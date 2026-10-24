import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from unlocker import runner


class SleepTests(unittest.TestCase):
    def run_sleep(self, wall_moved, mono_moved):
        out = io.StringIO()
        with patch.object(runner.time, "sleep"), \
                patch.object(runner.time, "time", side_effect=[1000, 1000 + wall_moved]), \
                patch.object(runner.time, "monotonic", side_effect=[50, 50 + mono_moved]), \
                redirect_stdout(out):
            runner._sleep(30)
        return out.getvalue()

    def test_awake_wait_says_nothing(self):
        self.assertEqual(self.run_sleep(30, 30), "")

    def test_lid_closed_during_wait_is_noted(self):
        # 5m 32s asleep: the wall clock moved on, the monotonic one didn't.
        self.assertEqual(self.run_sleep(30 + 332, 30),
                         "The computer slept for 5m, so unlocks are 5m later.\n")


if __name__ == "__main__":
    unittest.main()
