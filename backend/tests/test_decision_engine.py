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

    def test_unverified_manual_account_cannot_generate_add_signal(self):
        result = build_decision({
            "freshness": {"stale": False, "market_time": "2026-11-08T10:00:00+08:00"},
            "quote": {"price": 9.95, "support": 9.9, "resistance": 10.5},
            "market": {"pct": 0.5, "turnover_ratio": 1.1},
            "board": {"pct": 0.8}, "account": {"available_cash": 20000, "source": "manual", "verified": False},
        })
        self.assertEqual(result["action"], "WAIT")
        self.assertFalse(result["account_verified"])
        self.assertIn("未核验", "；".join(result["reasons"]))

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


if __name__ == "__main__":
    unittest.main()
