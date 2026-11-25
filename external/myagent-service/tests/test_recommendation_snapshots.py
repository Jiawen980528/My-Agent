from dataclasses import replace

from app import db


def _use_temp_db(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "settings", replace(db.settings, database_path=str(tmp_path / "test.sqlite3")))
    db.init_db()


def test_recommendation_snapshots_keep_period_and_review_state(monkeypatch, tmp_path):
    _use_temp_db(monkeypatch, tmp_path)

    first = db.save_quant_recommendation_snapshot(
        scan_id=1,
        period="盘中观察",
        valid_until="本次盘中观察结束",
        generated_at="2026-11-26T09:40:00+08:00",
        data_source="TickFlow",
        symbols=["000001"],
        payload=[{"symbol": "000001", "price": 10.0}],
    )
    second = db.save_quant_recommendation_snapshot(
        scan_id=2,
        period="次日跟踪",
        valid_until="下一交易日收盘后",
        generated_at="2026-11-26T15:00:00+08:00",
        data_source="TickFlow",
        symbols=["600000"],
        payload=[{"symbol": "600000", "price": 12.0}],
    )

    rows = db.list_quant_recommendation_snapshots()
    assert [row["period"] for row in rows] == ["次日跟踪", "盘中观察"]
    assert all(row["status"] == "待复盘" and row["review"] is None for row in rows)
    assert rows[0]["symbols"] == ["600000"]
    assert rows[1]["payload"] == [{"symbol": "000001", "price": 10.0}]

    review = {
        "observations": [{
            "symbol": "000001",
            "reference_price": 10.0,
            "observed_price": 10.4,
            "observed_return_pct": 4.0,
            "source": "TickFlow",
        }],
        "note": "真实行情复盘",
    }
    assert db.resolve_quant_recommendation_snapshot(first, review) is True
    assert db.resolve_quant_recommendation_snapshot(first, review) is False

    reviewed = db.get_quant_recommendation_snapshot(first)
    assert reviewed is not None
    assert reviewed["status"] == "已复盘"
    assert reviewed["review"]["observations"][0]["observed_return_pct"] == 4.0

