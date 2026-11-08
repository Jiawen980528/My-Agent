import os
import unittest
from unittest.mock import patch


class CorsConfigTests(unittest.TestCase):
    def test_default_cors_is_not_wildcard(self):
        from app.cors_config import cors_origins
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CORS_ORIGINS", None)
            self.assertNotIn("*", cors_origins())

    def test_cors_can_be_explicitly_configured(self):
        from app.cors_config import cors_origins
        with patch.dict(os.environ, {"CORS_ORIGINS": "https://agent.example.com/, http://localhost:5173"}):
            self.assertEqual(cors_origins(), ["https://agent.example.com", "http://localhost:5173"])

    def test_wildcard_is_ignored_when_credentials_are_enabled(self):
        from app.cors_config import cors_origins
        with patch.dict(os.environ, {"CORS_ORIGINS": "*"}):
            self.assertNotIn("*", cors_origins())


if __name__ == "__main__":
    unittest.main()
