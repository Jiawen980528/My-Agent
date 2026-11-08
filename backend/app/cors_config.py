"""Environment-driven CORS origin configuration."""
from __future__ import annotations

import os


def cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    origins = [item.strip().rstrip("/") for item in raw.split(",") if item.strip() and item.strip() != "*"]
    return origins or ["http://localhost:5173"]
