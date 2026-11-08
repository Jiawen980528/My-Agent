import unittest

from app.services.volume_forecast import forecast_amount


class VolumeForecastTests(unittest.TestCase):
    def test_requires_real_comparable_history(self):
        result = forecast_amount([{"datetime": "2026-11-08 10:00", "amount": 100}], [])
        self.assertEqual(result["status"], "unavailable")

    def test_uses_same_time_historical_amount_profile(self):
        current = [
            {"datetime": "2026-11-08 09:30", "amount": 40},
            {"datetime": "2026-11-08 10:00", "amount": 60},
        ]
        history = []
        for index in range(3):
            day = f"2026-11-0{index + 1}"
            history.append([
                {"datetime": f"{day} 09:30", "amount": 100},
                {"datetime": f"{day} 10:00", "amount": 100},
                {"datetime": f"{day} 15:00", "amount": 400},
            ])
        result = forecast_amount(current, history)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["forecast_amount"], 300)
        self.assertEqual(result["sample_days"], 3)

    def test_source_is_explicit_and_not_assumed_to_be_tickflow(self):
        current = [
            {"datetime": "2026-11-08 09:30", "amount": 40},
            {"datetime": "2026-11-08 10:00", "amount": 60},
        ]
        history = [[
            {"datetime": f"2026-11-0{index} 09:30", "amount": 100},
            {"datetime": f"2026-11-0{index} 10:00", "amount": 100},
            {"datetime": f"2026-11-0{index} 15:00", "amount": 400},
        ] for index in range(1, 4)]
        result = forecast_amount(current, history, source="CustomMinute")
        self.assertEqual(result["source"], "CustomMinute")


if __name__ == "__main__":
    unittest.main()
