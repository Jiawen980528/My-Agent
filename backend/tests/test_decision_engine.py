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
            "board": {"pct": 0.8}, "account": {"available_cash": 20000},
        }, risk_budget=5000, now=datetime(2026, 11, 8, 10, 0, tzinfo=ZoneInfo("Asia/Shanghai")))
        self.assertEqual(result["action"], "CONDITIONAL_ADD")
        self.assertLessEqual(result["max_risk_yuan"], 5000)
        self.assertIsNotNone(result["invalidation_price"])


if __name__ == "__main__":
    unittest.main()
