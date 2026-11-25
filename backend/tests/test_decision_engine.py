import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from app.services.decision_engine import build_decision


class DecisionEngineTests(unittest.TestCase):
    def test_missing_or_stale_data_fails_closed(self):
        result = build_decision({"freshness": {"stale": True}}, now=datetime(2026, 11, 8, tzinfo=ZoneInfo("Asia/Shanghai")))
        self.assertEqual(result["action"], "WAIT")
        self.assertEqual(result["status"], "WAIT")
        self.assertEqual(result["suggested_qty"], 0)

    def test_conditional_add_has_explicit_risk_limit(self):
        result = build_decision({
            "freshness": {"stale": False, "market_time": "2026-11-08T10:00:00+08:00"},
            "quote": {"price": 9.95, "support": 9.9, "resistance": 10.5},
            "market": {"pct": 0.5, "turnover_ratio": 1.1},
            "board": {"pct": 0.8}, "account": {"available_cash": 20000, "source": "qmt", "verified": True},
        }, risk_budget=5000, now=datetime(2026, 11, 8, 10, 0, tzinfo=ZoneInfo("Asia/Shanghai")))
        self.assertEqual(result["action"], "CONDITIONAL_ADD")
        self.assertLessEqual(result["max_risk_yuan"], 5000)
        self.assertIsNotNone(result["invalidation_price"])

    def test_manual_account_can_generate_research_only_add_signal(self):
        result = build_decision({
            "freshness": {"stale": False, "market_time": "2026-11-08T10:00:00+08:00"},
            "quote": {"price": 9.95, "support": 9.9, "resistance": 10.5},
            "market": {"pct": 0.5, "turnover_ratio": 1.1},
            "board": {"pct": 0.8}, "account": {"available_cash": 20000, "source": "manual", "verified": False},
        })
        self.assertEqual(result["action"], "CONDITIONAL_ADD")
        self.assertFalse(result["account_verified"])
        self.assertEqual(result["account_mode"], "manual")
        self.assertTrue(result["research_only"])
        self.assertTrue(any("手工持仓成本/数量" in value for value in result["basis"]))

    def test_context_evidence_and_cash_cap_are_exposed(self):
        result = build_decision({
            "freshness": {"stale": False, "market_time": "2026-11-08T10:00:00+08:00"},
            "quote": {"price": 9.95, "support": 9.9, "resistance": 10.5},
            "market": {"pct": 0.5, "turnover_ratio": 1.1},
            "board": {"pct": 0.8},
            "market_breadth": {"up_count": 3000, "down_count": 1000},
            "turnover_forecast": {"status": "ok", "forecast_amount": 1_000_000},
            "defensive": {"pct": 0.1},
            "trades_today": [{"symbol": "600000.SH", "side": "buy"}],
            "account": {"available_cash": 100, "day_risk_used": 0, "source": "qmt", "verified": True},
        }, risk_budget=5000)
        self.assertEqual(result["action"], "CONDITIONAL_ADD")
        self.assertEqual(result["suggested_qty"], 10)
        self.assertEqual(result["evidence"]["trades_today_count"], 1)
        self.assertIn("全市场真实成交额预测", result["basis"])

    def test_strict_context_waits_when_market_context_is_missing(self):
        result = build_decision({
            "strict_context": True,
            "freshness": {"stale": False, "market_time": "2026-11-08T10:00:00+08:00"},
            "quote": {"price": 9.95, "support": 9.9, "resistance": 10.5},
            "market": {"pct": 0.5, "turnover_ratio": 1.1}, "board": {"pct": 0.8},
            "account": {"available_cash": 20000, "source": "qmt", "verified": True},
        })
        self.assertEqual(result["action"], "WAIT")
        self.assertIn("market_breadth", result["evidence"]["context_missing"])

    def test_strict_context_requires_real_multi_period_summary(self):
        result = build_decision({
            "strict_context": True,
            "freshness": {"stale": False, "market_time": "2026-11-08T10:00:00+08:00"},
            "quote": {"price": 9.95, "support": 9.9, "resistance": 10.5},
            "market": {"pct": 0.5, "turnover_ratio": 1.1}, "board": {"pct": 0.8},
            "market_breadth": {"up_count": 3000, "down_count": 1000},
            "turnover_forecast": {"status": "ok"}, "defensive": {"pct": 0.1},
            "account": {"available_cash": 20000, "source": "qmt", "verified": True},
            "multi_period": {"daily": {"trend": "up", "observations": 10},
                             "minute_60": {"trend": "up", "observations": 3},
                             "minute_15": {"trend": "up", "observations": 6},
                             "minute_5": {"trend": "up", "observations": 18}},
        })
        self.assertEqual(result["action"], "CONDITIONAL_ADD")
        self.assertNotIn("multi_period", result["evidence"]["context_missing"])
        self.assertIn("日线/60分钟/15分钟/5分钟多周期", result["basis"])

    def test_external_and_arms_context_are_exposed_as_warnings(self):
        result = build_decision({
            "strict_context": True,
            "freshness": {"stale": False, "market_time": "2026-11-08T10:00:00+08:00"},
            "quote": {"price": 9.95, "support": 9.9, "resistance": 10.5},
            "market": {"pct": 0.5, "turnover_ratio": 1.1}, "board": {"pct": 0.8},
            "market_breadth": {"up_count": 3000, "down_count": 1000, "arms": {"value": 1.35}},
            "turnover_forecast": {"status": "ok"}, "defensive": {"pct": 0.1},
            "multi_period": {"daily": {"trend": "up", "observations": 10},
                             "minute_60": {"trend": "up", "observations": 3},
                             "minute_15": {"trend": "up", "observations": 6},
                             "minute_5": {"trend": "up", "observations": 18}},
            "account": {"available_cash": 20000, "source": "manual", "verified": False},
            "external_market": {"status": "ok", "rows": [{"symbol": "^VIX", "last": 32, "status": "ok"}]},
        })
        self.assertIn("阿姆斯/TRIN", result["basis"])
        self.assertIn("美股/外围市场背景（公共行情，可能延迟）", result["basis"])
        self.assertEqual(len(result["warnings"]), 2)
        self.assertEqual(result["evidence"]["external_market"]["status"], "ok")

    def test_technical_context_is_kept_in_evidence_and_warns(self):
        result = build_decision({
            "freshness": {"stale": False, "market_time": "2026-11-08T10:00:00+08:00"},
            "quote": {"price": 9.95, "support": 9.9, "resistance": 10.5},
            "market": {"pct": 0.5, "turnover_ratio": 1.1}, "board": {"pct": 0.8},
            "account": {"available_cash": 20000, "source": "manual", "verified": False},
            "technical": {"rsi_14": 74, "macd_hist": -0.02, "kdj_j": 105},
        })
        self.assertIn("日线技术指标（真实 enriched 数据）", result["basis"])
        self.assertEqual(result["evidence"]["technical"]["rsi_14"], 74)
        self.assertEqual(len(result["warnings"]), 3)


if __name__ == "__main__":
    unittest.main()
