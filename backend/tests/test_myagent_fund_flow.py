"""Units and date alignment for the MyAgent fund-flow bridge."""
import unittest
import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from app.api.myagent_bridge import (
    _fetch_tickflow_sector_curve,
    _parse_flow,
    _parse_price,
    _sum_market_flows,
    local_tickflow_status,
)


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

    def test_tickflow_status_is_local_and_does_not_require_bridge_token(self):
        class NoQuotes:
            @staticmethod
            def has(_cap):
                return False

        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(capabilities=NoQuotes())))
        result = asyncio.run(local_tickflow_status(request))
        self.assertFalse(result["connected"])
        self.assertEqual(result["source"], "未连接")
        self.assertIn("有效 Key", result["message"])

    def test_sector_intraday_prefers_real_minute_aggregation_and_marks_normalized(self):
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=object())))
        rotation = {
            "status": "ok", "date": "2026-11-26",
            "series": {"sectors": ["半导体设备"], "buckets": ["09:30", "09:35"], "matrix": [[0.01, 0.02]]},
        }
        with patch("app.api.myagent_bridge.sector_rotation.build_sector_rotation", return_value=rotation):
            result = asyncio.run(_fetch_tickflow_sector_curve(request, "BK1326", "半导体设备", "5m"))
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["provider"], "tickflow_derived")
        self.assertTrue(result["normalized"])
        self.assertEqual(result["source"], "TickFlow全市场分钟聚合（等权归一化，基准=100）")
        self.assertEqual([row["close"] for row in result["rows"]], [101.0, 102.0])

    def test_sector_intraday_tries_industry_when_concept_catalog_misses_name(self):
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=object())))
        missing = {"status": "ok", "series": {"sectors": ["其他"], "buckets": ["09:30"], "matrix": [[0.0]]}}
        industry = {"status": "ok", "date": "2026-11-26", "series": {
            "sectors": ["银行", "其他"], "buckets": ["09:30"], "matrix": [[0.005], [0.0]],
        }}
        with patch("app.api.myagent_bridge.sector_rotation.build_sector_rotation", side_effect=[missing, industry]) as build:
            result = asyncio.run(_fetch_tickflow_sector_curve(request, "BK0475", "银行", "1m"))
        self.assertIsNotNone(result)
        self.assertEqual(build.call_count, 2)


if __name__ == "__main__":
    unittest.main()

