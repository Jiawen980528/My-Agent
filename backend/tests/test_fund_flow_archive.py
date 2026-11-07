"""Fund flow minute archives preserve observed curves per trading day."""
import tempfile
import unittest
from pathlib import Path

from app.services.fund_flow_archive import load_day, recorded_dates, save_day


class FundFlowArchiveTest(unittest.TestCase):
    def test_keeps_longest_observed_curve(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = [{"time": "2026-11-06 09:31", "main": 1.0}]
            later = first + [{"time": "2026-11-06 09:32", "main": 2.0}]
            self.assertTrue(save_day(root, "market", first, "2026-11-06T09:31:00"))
            self.assertTrue(save_day(root, "market", later, "2026-11-06T09:32:00"))
            save_day(root, "market", first, "2026-11-06T09:33:00")
            self.assertEqual(load_day(root, "market", "2026-11-06")["rows"], later)
            self.assertEqual(recorded_dates(root, "market"), ["2026-11-06"])
            self.assertIsNone(load_day(root, "BK0447", "2026-11-06"))
            self.assertFalse(save_day(root, "market", first + [{"time": "2026-11-05 15:00"}], "x"))


if __name__ == "__main__":
    unittest.main()
