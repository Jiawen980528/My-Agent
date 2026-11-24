import unittest

from app.services.forecast_reviews import classify_prediction


class ForecastReviewTests(unittest.TestCase):
    def test_prediction_without_real_close_stays_pending(self):
        self.assertEqual(classify_prediction(None, 100, 120), "pending")
        self.assertEqual(classify_prediction(110, None, 120), "pending")


    def test_prediction_hits_only_inside_real_interval(self):
        self.assertEqual(classify_prediction(100, 100, 120), "hit")
        self.assertEqual(classify_prediction(120, 100, 120), "hit")
        self.assertEqual(classify_prediction(99.99, 100, 120), "miss")
