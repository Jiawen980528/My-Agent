from __future__ import annotations

import io
from zipfile import ZipFile

import polars as pl
import pytest

from app.services import research_pool


def _workbook() -> bytes:
    buffer = io.BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("xl/workbook.xml", "<workbook/>")
    return buffer.getvalue()


def test_import_private_pool_matches_codes_and_names_without_inventing_unresolved(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    instruments = data_dir / "instruments"
    instruments.mkdir(parents=True)
    pl.DataFrame({"symbol": ["000739.SZ", "002031.SZ"], "name": ["普洛药业", "巨轮智能"]}).write_parquet(instruments / "instruments.parquet")

    def read_excel(_, *, sheet_name, **__):
        if sheet_name == "创新药产业链":
            return pl.DataFrame({"细分方向": ["原料药"], "个股名称": ["普洛药业"], "股票代码": ["000739"],
                                 "核心逻辑/卡位": ["CDMO"], "信息来源": ["课堂资料"]})
        if sheet_name == "重点补漏清单":
            return pl.DataFrame({"板块": ["人形机器人"], "必须补回／重点补漏": ["巨轮智能、未知股票"],
                                 "为何列入": ["历史辨识度"], "参考来源": ["公开资料"]})
        raise ValueError("sheet absent")

    monkeypatch.setattr(research_pool.pl, "read_excel", read_excel)
    result = research_pool.import_workbook(data_dir, _workbook(), "课堂.xlsx")
    assert result["imported"] == 3
    assert result["unresolved"] == 1
    rows = research_pool.load(data_dir)["items"]
    assert {r["name"]: r["symbol"] for r in rows} == {
        "普洛药业": "000739.SZ", "巨轮智能": "002031.SZ", "未知股票": None,
    }
    assert (data_dir / "user_data" / "myagent_research_pool.json").stat().st_mode & 0o777 == 0o600
    assert research_pool.import_workbook(data_dir, _workbook(), "课堂.xlsx")["count"] == 3


def test_rejects_invalid_or_oversized_workbook(tmp_path):
    with pytest.raises(ValueError, match="有效"):
        research_pool.import_workbook(tmp_path, b"not a zip", "bad.xlsx")
    with pytest.raises(ValueError, match="2 MB"):
        research_pool.import_workbook(tmp_path, b"x" * (research_pool.MAX_UPLOAD_BYTES + 1), "bad.xlsx")
    with pytest.raises(ValueError, match="未找到"):
        research_pool.import_workbook(tmp_path, _workbook(), "bad.xlsx")
