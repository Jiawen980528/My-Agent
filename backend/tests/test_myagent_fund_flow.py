"""Units and date alignment for the MyAgent fund-flow bridge."""
import unittest

from app.api.myagent_bridge import _parse_flow, _parse_price, _sum_market_flows


class FundFlowParsingTests(unittest.TestCase):
    def test_daily_net_amounts_are_yi_and_invalid_rows_are_skipped(self):
        rows = _parse_flow([
            "2026-11-05,100000000,50000000,-30000000,60000000,40000000,1.0",
            "2026-11-04,invalid,0,0,0,0",
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["main"], 1.0)
        self.assertEqual(rows[0]["big"] + rows[0]["super"], rows[0]["main"])

    def test_market_history_joins_by_date_not_list_position(self):
        sh = _parse_flow(["2026-11-04,100000000,0,0,60000000,40000000",
                          "2026-11-05,200000000,0,0,150000000,50000000"])
        sz = _parse_flow(["2026-11-05,-100000000,0,0,-60000000,-40000000"])
        rows = _sum_market_flows(sh, sz)
        self.assertEqual([row["time"] for row in rows], ["2026-11-04", "2026-11-05"])
        self.assertEqual([row["main"] for row in rows], [1.0, 1.0])

    def test_sector_candles_preserve_ohlc_and_drop_invalid(self):
        rows = _parse_price([
            "2026-11-05,100,103,105,99,12345,0,0,3.00,0,0",
            "2026-11-06,0,0,0,0,0,0,0,0,0,0",
        ], "daily")
        self.assertEqual(len(rows), 1)
        self.assertEqual([rows[0][key] for key in ("open", "close", "low", "high")], [100, 103, 99, 105])
        self.assertEqual(rows[0]["pct"], 3.0)


if __name__ == "__main__":
    unittest.main()
