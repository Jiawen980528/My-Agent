import tempfile
import unittest
from pathlib import Path

from app.services import ptrade_replay as replay


def sample(source="PTrade", duplicate=False):
    header = ",".join(replay.FIELDS)
    line = "159558.SZ,2026-11-06T09:31:00+08:00,0.8,0.81,0.79,0.805,1000,805," + source
    return (header + "\n" + line + ("\n" + line if duplicate else "") + "\n").encode()


class PTradeReplayTests(unittest.TestCase):
    def test_import_preserves_source_and_time(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = replay.save_csv(root, sample())
            self.assertEqual(report["counts"]["159558.SZ"], 1)
            rows = replay.load(root, "159558.SZ")
            self.assertEqual(rows[0]["source"], "PTrade")
            self.assertEqual(rows[0]["datetime"], "2026-11-06T09:31+08:00")
            self.assertEqual(replay.replay("159558.SZ", rows)["row_count"], 1)

    def test_rejects_false_source_and_duplicate(self):
        with self.assertRaises(ValueError):
            replay.parse_csv(sample("PublicData"))
        with self.assertRaises(ValueError):
            replay.parse_csv(sample(duplicate=True))

    def test_cashflow_without_prices(self):
        result = replay.replay("159558.SZ", [])
        self.assertEqual(result["fees"], 20)
        self.assertEqual(result["extra_qty"], 12600)
        self.assertIsNone(result["versus_no_trade"])


if __name__ == "__main__":
    unittest.main()
