import errno
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from unlocker import server, state
from unlocker.paths import write_atomic


class ProgressTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "progress.json"

    def test_missing_and_legacy_progress_keep_defaults(self):
        self.assertEqual(state.load_progress(self.path), state.DEFAULT_PROGRESS)
        self.path.write_text(json.dumps({"appid": 730, "last_completed": 2}))
        progress = state.load_progress(self.path)
        self.assertEqual(progress["last_completed"], 2)
        self.assertIsNone(progress["config_hash"])
        self.assertIsNone(progress["next_unlock_at"])

    def test_invalid_fields_are_damaged_progress(self):
        invalid = {
            "appid": [-1, True, 730.5, "730", None],
            "last_completed": [-2, False, 1.5, "bad", None],
            "config_hash": [123, False, [], {}],
            "next_unlock_at": [1, False, [], "", "bad", "2026-02-30T12:00:00", "2026-10-17T12:00:00+00:00"],
            "session_ends_at": [1, False, {}, "bad", "2026-10-17T12:00:00+02:00"],
        }
        for key, values in invalid.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.path.write_text(json.dumps({key: value}))
                    with self.assertRaises(state.DamagedProgress):
                        state.load_progress(self.path)

    def test_invalid_json_and_shapes_are_damaged_progress(self):
        for text in ("{broken", "[]", "null", "42"):
            with self.subTest(text=text):
                self.path.write_text(text)
                with self.assertRaises(state.DamagedProgress):
                    state.load_progress(self.path)

    def test_valid_local_timers_round_trip(self):
        progress = {
            **state.DEFAULT_PROGRESS,
            "appid": 730,
            "last_completed": 0,
            "next_unlock_at": "2026-10-17T12:00:00.123456",
            "session_ends_at": "2026-10-17T13:00:00",
            "config_hash": "0123456789abcdef",
        }
        state.save_progress(self.path, progress)
        self.assertEqual(state.load_progress(self.path), progress)


class SaveRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for module in (state, server):
            for name, folder in (("JSONS_DIR", "jsons"), ("CSVS_DIR", "csvs"), ("COMPLETED_DIR", "completed")):
                self.enter_patch(patch.object(module, name, root / folder))
        state.JSONS_DIR.mkdir()
        state.CSVS_DIR.mkdir()
        self.enter_patch(patch.object(server, "lock_info", return_value=None))
        self.enter_patch(patch.object(server, "_running_pid", return_value=None))
        self.enter_patch(patch.object(server, "_title", return_value="Review"))
        self.enter_patch(patch.object(server.achievements, "app_icon", return_value=None))
        self.enter_patch(patch.object(server.achievements, "app_counters", return_value=None))
        self.enter_patch(patch.object(server.achievements, "keep_asf_open"))
        self.config = {
            "appid": 730, "game": "Review",
            "achievements": [{"id": 1, "delay": 0, "new_session": False}],
        }
        self.config_path, self.progress_path = state.profile_paths("review")
        self.csv_path = state.CSVS_DIR / "review.csv"
        self.config_path.write_text(json.dumps(self.config))
        self.csv_path.write_text("original CSV")
        self.journal = server._journal_path("review")

    def enter_patch(self, patcher):
        self.addCleanup(patcher.stop)
        return patcher.start()

    def make_journal(self):
        self.journal.write_text(json.dumps({"files": [
            {"path": str(self.config_path), "old": self.config_path.read_text()},
            {"path": str(self.csv_path), "old": "original CSV"},
            {"path": str(self.progress_path), "old": json.dumps(state.DEFAULT_PROGRESS)},
        ]}))

    def test_failed_recovery_preserves_backup_and_blocks_save_until_retry(self):
        self.make_journal()
        journal_text = self.journal.read_text()
        self.progress_path.write_text("{broken")
        self.csv_path.write_text("partial CSV")

        def deny_progress(path, text):
            if path == self.progress_path:
                raise OSError(errno.EACCES, "simulated file-access failure")
            write_atomic(path, text)

        changed = {**self.config, "game": "New schedule"}
        with patch.object(server, "write_atomic", side_effect=deny_progress):
            with self.assertRaises(server.AppError) as caught:
                server.save_game("review", changed, "new CSV", overwrite=True)
        self.assertEqual(caught.exception.status, 500)
        self.assertIn("recovery data was kept", str(caught.exception))
        self.assertEqual(self.journal.read_text(), journal_text)
        self.assertEqual(json.loads(self.config_path.read_text()), self.config)
        self.assertEqual(self.progress_path.read_text(), "{broken")

        self.assertEqual(server.save_game("review", changed, "new CSV", overwrite=True), {"saved": "review"})
        self.assertFalse(self.journal.exists())
        self.assertEqual(state.load_progress(self.progress_path), state.DEFAULT_PROGRESS)
        self.assertEqual(json.loads(self.config_path.read_text()), changed)
        self.assertEqual(self.csv_path.read_text(), "new CSV")

    def test_unreadable_journal_is_preserved_and_reported(self):
        for text in ("{broken", "{}", '{"files": [null]}'):
            with self.subTest(text=text):
                self.journal.write_text(text)
                with self.assertRaises(server.AppError):
                    server.save_game("review", self.config, "new CSV", overwrite=True)
                self.assertEqual(self.journal.read_text(), text)
                self.assertEqual(self.csv_path.read_text(), "original CSV")

    def test_restart_restores_interrupted_save(self):
        self.make_journal()
        self.csv_path.write_text("partial CSV")
        self.progress_path.write_text("{broken")
        server.recover_saves()
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.csv_path.read_text(), "original CSV")
        self.assertEqual(state.load_progress(self.progress_path), state.DEFAULT_PROGRESS)

    def test_write_failure_rolls_back_schedule(self):
        def deny_config(path, text):
            if path == self.config_path:
                raise OSError(errno.ENOSPC, "simulated full disk")
            write_atomic(path, text)

        with patch.object(server, "write_atomic", side_effect=deny_config):
            with self.assertRaises(server.AppError):
                server.save_game("review", {**self.config, "game": "Changed"}, "new CSV", overwrite=True)
        self.assertEqual(self.csv_path.read_text(), "original CSV")
        self.assertEqual(json.loads(self.config_path.read_text()), self.config)
        self.assertFalse(self.journal.exists())

    def test_bad_field_values_only_disable_the_affected_game(self):
        self.progress_path.write_text(json.dumps({"last_completed": "bad"}))
        other_config, _ = state.profile_paths("other")
        other_config.write_text(json.dumps(self.config))
        games = {game["name"]: game for game in server.game_states()["games"]}
        self.assertTrue(games["review"]["progress_damaged"])
        self.assertEqual(games["review"]["state"], "invalid")
        self.assertEqual(games["other"]["state"], "idle")
        server.reset_game_progress("review")
        self.assertTrue(self.progress_path.with_name(self.progress_path.name + ".damaged").exists())
        self.assertEqual(server._game_state("review", None)["state"], "idle")


if __name__ == "__main__":
    unittest.main()
