import unittest

from app.services.market_volume_forecast import aggregate_amount_rows, forecast_market_amount


class MarketVolumeForecastTests(unittest.TestCase):
    def test_aggregates_real_amount_by_minute(self):
        rows = aggregate_amount_rows([
            {"datetime": "2026-11-08 09:30:01", "amount": 100},
            {"datetime": "2026-11-08 09:30:59", "amount": 25},
            {"datetime": "2026-11-08 09:31", "amount": 50},
        ])
        self.assertEqual(rows, [
            {"datetime": "2026-11-08 09:30", "amount": 125.0},
            {"datetime": "2026-11-08 09:31", "amount": 50.0},
        ])

    def test_forecast_uses_aggregated_market_amount_not_price(self):
        current = [{"datetime": "2026-11-08 09:30", "amount": 40},
                   {"datetime": "2026-11-08 10:00", "amount": 60}]
        history = [[{"datetime": f"2026-11-0{day} 09:30", "amount": 100},
                    {"datetime": f"2026-11-0{day} 10:00", "amount": 100},
                    {"datetime": f"2026-11-0{day} 15:00", "amount": 400}]
                   for day in range(1, 4)]
        result = forecast_market_amount(current, history)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["forecast_amount"], 300)


if __name__ == "__main__":
    unittest.main()
