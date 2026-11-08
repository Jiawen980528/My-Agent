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
        self.assertEqual(result["matched_t_qty"], 23800)
        self.assertEqual(result["unmatched_sell_qty"], 0)
        self.assertIsNone(result["versus_no_trade"])

    def test_lot_matching_handles_buy_then_sell_and_unmatched_sell(self):
        trades = [
            {"trade_id": "b", "datetime": "2026-11-07T10:00:00+08:00", "side": "buy", "qty": 100,
             "price": 10.0, "fee": 5.0, "source": "manual"},
            {"trade_id": "s", "datetime": "2026-11-07T10:05:00+08:00", "side": "sell", "qty": 40,
             "price": 10.5, "fee": 5.0, "source": "manual"},
            {"trade_id": "s2", "datetime": "2026-11-07T10:06:00+08:00", "side": "sell", "qty": 80,
             "price": 10.2, "fee": 5.0, "source": "manual"},
        ]
        result = replay.replay("600000.SH", [], trade_date="2026-11-07", trades=trades)
        self.assertEqual(result["matched_t_qty"], 100)
        self.assertEqual(result["unmatched_sell_qty"], 20)
        self.assertEqual(result["unmatched_buy_qty"], 0)

    def test_lot_matching_handles_sell_then_buy_as_round_trip(self):
        trades = [
            {"trade_id": "s", "datetime": "2026-11-07T10:00:00+08:00", "side": "sell", "qty": 100,
             "price": 10.5, "fee": 5.0, "source": "manual"},
            {"trade_id": "b", "datetime": "2026-11-07T10:05:00+08:00", "side": "buy", "qty": 60,
             "price": 10.0, "fee": 5.0, "source": "manual"},
        ]
        result = replay.replay("600000.SH", [], trade_date="2026-11-07", trades=trades)
        self.assertEqual(result["matched_t_qty"], 60)
        self.assertEqual(result["unmatched_sell_qty"], 40)
        self.assertEqual(result["unmatched_buy_qty"], 0)

    def test_generic_trade_csv_is_idempotent_and_replayable(self):
        raw = ("trade_id,symbol,datetime,side,qty,price,fee,source\n"
               "fill-1,600000.SH,2026-11-07T10:00:00+08:00,buy,100,10.0,5,manual\n").encode()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(replay.save_trade_csv(root, raw)["count"], 1)
            self.assertEqual(replay.save_trade_csv(root, raw)["count"], 1)
            rows = replay.load_trade_rows(root, "600000.SH", "2026-11-07")
            result = replay.replay("600000.SH", [], trade_date="2026-11-07", trades=rows)
            self.assertEqual(len(result["trades"]), 1)
            self.assertEqual(result["fees"], 5)

    def test_shanghai_ss_alias_round_trips_through_ledger_and_minute_store(self):
        raw = ("trade_id,symbol,datetime,side,qty,price,fee,source\n"
               "fill-ss,588080.SS,2026-11-06T10:00:00+08:00,buy,100,1.2,5,manual\n").encode()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            replay.save_trade_csv(root, raw)
            rows = replay.load_trade_rows(root, "588080.SH", "2026-11-06")
            self.assertEqual(rows[0]["symbol"], "588080.SH")
            self.assertEqual(rows[0]["trade_id"], "fill-ss")

            minute = sample().decode().replace("159558.SZ", "588080.SS")
            replay.save_csv(root, minute.encode())
            loaded = replay.load(root, "588080.SH")
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0]["symbol"], "588080.SS")


if __name__ == "__main__":
    unittest.main()
