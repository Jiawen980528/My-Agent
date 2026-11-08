import unittest

from app.services.portfolio_account import is_trusted, normalize_snapshot, unavailable


class PortfolioAccountTests(unittest.TestCase):
    def test_unavailable_never_contains_balances_or_positions(self):
        result = unavailable("未配置")
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["verified"])
        self.assertIsNone(result["total_assets"])
        self.assertEqual(result["items"], [])
        self.assertFalse(is_trusted(result))

    def test_manual_snapshot_stays_unverified(self):
        result = normalize_snapshot({
            "total_assets": 100000,
            "items": [{"symbol": "588080.SS", "name": "科创ETF", "quantity": 1000}],
        }, source="manual", verified=True)
        self.assertEqual(result["status"], "unverified")
        self.assertFalse(result["verified"])
        self.assertEqual(result["items"][0]["symbol"], "588080.SH")
        self.assertFalse(is_trusted(result))

    def test_trusted_source_requires_adapter_verification(self):
        result = normalize_snapshot({"items": [{"symbol": "600000.SH"}]}, source="qmt", verified=True)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(is_trusted(result))


if __name__ == "__main__":
    unittest.main()
