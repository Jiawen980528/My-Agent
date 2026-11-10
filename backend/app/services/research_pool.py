"""Private research universe imported from the user's industry workbooks.

The uploaded workbook stays in memory. Only normalized candidate facts are saved
under user_data; class notes and workbooks never enter the public source tree.
"""
from __future__ import annotations

import io
import json
import re
import threading
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import polars as pl

from app.services.fs_utils import atomic_write_text
from app.services.watchlist_ocr.pipeline import build_instrument_lookups

MAX_UPLOAD_BYTES = 2_000_000
MAX_UNCOMPRESSED_BYTES = 12_000_000
_WRITE_LOCK = threading.Lock()
_SHEETS = (
    ("创新药产业链", 2, "创新药", "coded"),
    ("物理AI产业链", 2, "物理AI", "coded"),
    ("主流板块锚定表", 3, None, "names"),
    ("重点补漏清单", 2, None, "supplement"),
)


def _path(data_dir: Path) -> Path:
    return data_dir / "user_data" / "myagent_research_pool.json"


def load(data_dir: Path) -> dict:
    path = _path(data_dir)
    if not path.exists():
        return {"items": [], "sources": []}
    try:
        content = json.loads(path.read_text(encoding="utf-8"))
        return content if isinstance(content.get("items"), list) else {"items": [], "sources": []}
    except (OSError, ValueError, AttributeError):
        return {"items": [], "sources": []}


def _text(value) -> str:
    return str(value).strip() if value is not None else ""


def _names(value) -> list[str]:
    return [item.strip() for item in re.split(r"[、，,；;\n]+", _text(value)) if item.strip()]


def _symbol(code: str, code_to_symbol: dict[str, str]) -> str | None:
    bare = code.split(".")[0].zfill(6)
    if not re.fullmatch(r"\d{6}", bare):
        return None
    if bare in code_to_symbol:
        return code_to_symbol[bare]
    suffix = "SH" if bare.startswith("6") else "BJ" if bare.startswith(("4", "8", "9")) else "SZ"
    return f"{bare}.{suffix}"


def _source_date(raw: bytes, sheet: str, filename: str) -> str:
    match = re.search(r"(20\d{2})[-/.年]?(\d{2})[-/.月]?(\d{2})", filename)
    if not match:
        try:
            intro = pl.read_excel(io.BytesIO(raw), sheet_name=sheet, engine="calamine", read_options={"header_row": 0}).head(2)
            text = " ".join([*intro.columns, *(str(value) for row in intro.iter_rows() for value in row if value is not None)])
            match = re.search(r"(20\d{2})[-/.年]?(\d{2})[-/.月]?(\d{2})", text)
        except Exception:  # calamine 的缺 sheet / 损坏文件异常类型随版本变化
            pass
    return f"{match[1]}-{match[2]}-{match[3]}" if match else ""


def _workbook_rows(raw: bytes, filename: str, data_dir: Path) -> list[dict]:
    if len(raw) > MAX_UPLOAD_BYTES or not filename.lower().endswith(".xlsx"):
        raise ValueError("仅接受 2 MB 以内的 .xlsx 资料")
    try:
        with ZipFile(io.BytesIO(raw)) as archive:
            if sum(info.file_size for info in archive.infolist()) > MAX_UNCOMPRESSED_BYTES:
                raise ValueError("表格解压后超过 12 MB")
            if "xl/workbook.xml" not in archive.namelist():
                raise ValueError("不是有效的 Excel 工作簿")
    except BadZipFile as exc:
        raise ValueError("不是有效的 .xlsx 文件") from exc

    code_to_symbol, symbol_to_name = build_instrument_lookups(data_dir)
    name_to_symbol = {name: symbol for symbol, name in symbol_to_name.items()}
    items: list[dict] = []
    found_sheet = False
    for sheet, header_row, theme, mode in _SHEETS:
        try:
            frame = pl.read_excel(io.BytesIO(raw), sheet_name=sheet, engine="calamine", read_options={"header_row": header_row})
        except Exception:  # 缺 sheet 或文件损坏均在最终统一报告为不可识别资料
            continue
        found_sheet = True
        source_date = _source_date(raw, sheet, filename)
        for row in frame.head(1000).iter_rows(named=True):
            if mode == "coded":
                name = _text(row.get("个股名称"))
                code = _text(row.get("股票代码"))
                if not name or not code:
                    continue
                symbol = _symbol(code, code_to_symbol)
                items.append({"symbol": symbol, "name": name, "theme": theme, "segment": _text(row.get("细分方向")),
                              "role": "产业链", "rationale": _text(row.get("核心逻辑/卡位"))[:240],
                              "source": _text(row.get("信息来源"))[:120], "source_date": source_date, "source_file": filename})
                continue
            sector = _text(row.get("主流板块" if mode == "names" else "板块"))
            segment = _text(row.get("热门题材（合并展示）")) if mode == "names" else ""
            groups = (("中军", row.get("中军／容量候选")), ("辨识度", row.get("辨识度／弹性观察池（含补漏）"))) if mode == "names" else (("补漏", row.get("必须补回／重点补漏")),)
            for role, cell in groups:
                for name in _names(cell):
                    items.append({"symbol": name_to_symbol.get(name), "name": name, "theme": sector,
                                  "segment": segment, "role": role,
                                  "rationale": _text(row.get("调整备注" if mode == "names" else "为何列入"))[:240],
                                  "source": _text(row.get("参考来源" if mode == "supplement" else "课堂板块表"))[:120],
                                  "source_date": source_date, "source_file": filename})
    if not found_sheet:
        raise ValueError("未找到受支持的产业链或板块观察表")
    if not items:
        raise ValueError("表格中没有可识别的股票")
    return items


def import_workbook(data_dir: Path, raw: bytes, filename: str) -> dict:
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1][:120]
    items = _workbook_rows(raw, filename, data_dir)
    with _WRITE_LOCK:
        current = load(data_dir)
        combined = [item for item in current["items"] if item.get("source_file") != filename] + items
        deduped = list({(item["name"], item["theme"], item["segment"], item["role"]): item for item in combined}.values())
        sources = sorted(set(current.get("sources", [])) | {filename})
        result = {"items": deduped, "sources": sources}
        path = _path(data_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, json.dumps(result, ensure_ascii=False), mode=0o600)
    return {"count": len(deduped), "imported": len(items), "unresolved": sum(not item["symbol"] for item in deduped), "sources": sources}
