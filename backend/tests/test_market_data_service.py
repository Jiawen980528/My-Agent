import unittest
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app.services.market_data_service import batch_completeness, freshness, minute_quality, normalize_symbol, quote_snapshot


class MarketDataServiceTests(unittest.TestCase):
    def test_normalize_symbol_does_not_guess_exchange(self):
        self.assertEqual(normalize_symbol(" 588080.ss "), "588080.SH")
        self.assertEqual(normalize_symbol("159558.SZ"), "159558.SZ")
        self.assertEqual(normalize_symbol("600000"), "600000")

    def test_freshness_marks_missing_and_old_data(self):
        received = datetime(2026, 11, 8, 10, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.assertTrue(freshness(None, received_at=received)["stale"])
        old = freshness("2026-11-08T09:55:00+08:00", received_at=received)
        self.assertEqual(old["age_seconds"], 300)
        self.assertTrue(old["stale"])

    @patch("app.services.market_data_service._get_client")
    def test_quote_snapshot_has_source_and_freshness(self, get_client):
        get_client.return_value.quotes.get.return_value = [{
            "symbol": "600000.SH", "last_price": 10.2, "prev_close": 10.0,
            "timestamp": 1794099600000, "ext": {"name": "测试"},
        }]
        result = quote_snapshot(["600000.SH"])
        self.assertEqual(result["source"], "TickFlow")
        self.assertEqual(result["items"][0]["name"], "测试")
        self.assertIn("market_time", result["items"][0])
        self.assertEqual(result["items"][0]["source"], "TickFlow")
        self.assertEqual(result["missing_symbols"], [])
        self.assertTrue(result["complete"])
        get_client.return_value.quotes.get.assert_called_once_with(symbols=["600000.SH"])

    @patch("app.services.market_data_service._get_client")
    def test_quote_snapshot_reports_missing_requested_symbols(self, get_client):
        get_client.return_value.quotes.get.return_value = [{
            "symbol": "600000.SH", "last_price": 10.2, "prev_close": 10.0,
            "timestamp": "2026-11-08T10:00:00+08:00", "ext": {"name": "测试"},
        }]
        result = quote_snapshot(["600000.SH", "159558.SZ"])
        self.assertEqual(result["missing_symbols"], ["159558.SZ"])
        self.assertFalse(result["complete"])

    def test_minute_quality_rejects_duplicate_or_unsorted_rows(self):
        result = minute_quality([
            {"datetime": "2026-11-06 09:32"},
            {"datetime": "2026-11-06 09:32"},
            {"datetime": "2026-11-06 09:31"},
        ])
        self.assertFalse(result["valid"])
        self.assertEqual(result["duplicate_timestamps"], 1)
        self.assertFalse(result["sorted"])

    def test_batch_completeness_reports_empty_and_error_symbols(self):
        result = batch_completeness({"600000.SH": [{"datetime": "x"}], "159558.SZ": []}, {"159558.SZ": "PermissionError"})
        self.assertEqual(result["missing_symbols"], ["159558.SZ"])
        self.assertEqual(result["error_symbols"], ["159558.SZ"])
        self.assertFalse(result["complete"])


if __name__ == "__main__":
    unittest.main()
