import unittest

from app.api.myagent_bridge import _local_board_catalog


class BoardCatalogFallbackTests(unittest.TestCase):
    def test_compound_semiconductor_search_expands_to_verified_aliases(self):
        items = _local_board_catalog("半导体设备材料")
        self.assertEqual([item["code"] for item in items], ["BK1325", "BK1326"])
        self.assertTrue(all(item["pct"] is None for item in items))

    def test_code_fallback_has_no_live_claim(self):
        items = _local_board_catalog("半导体设备")
        self.assertEqual(items[0]["code"], "BK1326")
        self.assertIsNone(items[0]["pct"])


if __name__ == "__main__":
    unittest.main()
