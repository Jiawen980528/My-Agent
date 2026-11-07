"""Persist observed intraday fund-flow curves without synthesizing past minutes."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path


def _path(data_dir: Path) -> Path:
    return data_dir / "myagent_fund_flow_intraday.sqlite3"


def save_day(data_dir: Path, code: str, rows: list[dict], fetched_at: str) -> bool:
    """Keep the longest genuine curve seen for a trading day and scope."""
    if not rows or not code or len(rows) > 1000:
        return False
    day = str(rows[-1].get("time") or "")[:10]
    if len(day) != 10 or any(str(row.get("time") or "")[:10] != day for row in rows):
        return False
    path = _path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path, timeout=10) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS day_curves ("
                           "trade_date TEXT NOT NULL, code TEXT NOT NULL, rows_json TEXT NOT NULL, "
                           "row_count INTEGER NOT NULL, fetched_at TEXT NOT NULL, "
                           "PRIMARY KEY(trade_date,code))")
        connection.execute(
            "INSERT INTO day_curves(trade_date,code,rows_json,row_count,fetched_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(trade_date,code) DO UPDATE SET rows_json=excluded.rows_json,"
            "row_count=excluded.row_count,fetched_at=excluded.fetched_at "
            "WHERE excluded.row_count >= day_curves.row_count",
            (day, code, json.dumps(rows, ensure_ascii=False), len(rows), fetched_at),
        )
    return True


def load_day(data_dir: Path, code: str, day: str) -> dict | None:
    path = _path(data_dir)
    if not path.exists():
        return None
    with sqlite3.connect(path, timeout=10) as connection:
        row = connection.execute("SELECT rows_json,fetched_at FROM day_curves "
                                 "WHERE trade_date=? AND code=?", (day, code)).fetchone()
    if not row:
        return None
    return {"rows": json.loads(row[0]), "fetched_at": row[1]}


def recorded_dates(data_dir: Path, code: str, limit: int = 120) -> list[str]:
    path = _path(data_dir)
    if not path.exists():
        return []
    with sqlite3.connect(path, timeout=10) as connection:
        rows = connection.execute("SELECT trade_date FROM day_curves WHERE code=? "
                                  "ORDER BY trade_date DESC LIMIT ?", (code, limit)).fetchall()
    return [row[0] for row in rows]
