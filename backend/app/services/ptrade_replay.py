"""Read-only PTrade ETF minute import and trade replay. No broker order calls."""
from __future__ import annotations

import csv
from contextlib import closing
import io
import math
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
TARGET_DAY = "2026-11-06"
SYMBOLS = {"159558.SZ", "588080.SS"}
TRADES = {
    "159558.SZ": [("09:34", "sell", 23800, .803), ("10:55", "buy", 12000, .830),
                  ("11:17", "buy", 12100, .824), ("13:57", "buy", 12300, .821)],
    "588080.SS": [("09:38", "sell", 10000, 1.273), ("10:55", "buy", 7600, 1.304),
                  ("13:40", "buy", 7700, 1.291)],
}
FIELDS = ("symbol", "datetime", "open", "high", "low", "close", "volume", "amount", "source")
TRADE_FIELDS = ("trade_id", "symbol", "datetime", "side", "qty", "price", "fee", "source")
_SYMBOL = re.compile(r"^\d{6}\.(SH|SZ|BJ|SS)$")


def _canonical_symbol(symbol: str) -> str:
    """Use one storage key while accepting TickFlow's SS spelling for Shanghai."""
    return str(symbol or "").strip().upper().replace(".SS", ".SH")


def _legacy_symbol(symbol: str) -> str:
    """Map the historical seed's only SS spelling back for compatibility."""
    value = _canonical_symbol(symbol)
    return "588080.SS" if value == "588080.SH" else value


def _db(data_dir: Path) -> Path:
    return data_dir / "ptrade_etf_replay.sqlite3"


def _trade_rows_db(data_dir: Path) -> Path:
    return data_dir / "trade_ledger.sqlite3"


def _default_trade_rows(symbol: str, trade_date: str) -> list[dict]:
    if trade_date != TARGET_DAY or symbol not in TRADES:
        return []
    return [{"trade_id": f"legacy-{symbol}-{index}", "symbol": symbol,
             "datetime": f"{trade_date}T{hm}:00+08:00", "side": side,
             "qty": qty, "price": price, "fee": None, "source": "legacy_seed"}
            for index, (hm, side, qty, price) in enumerate(TRADES[symbol], 1)]


def parse_trade_csv(raw: bytes) -> list[dict]:
    """Parse a generic, broker-neutral transaction CSV.

    This records transactions only; it never accepts account passwords or order
    instructions. Fees are optional and are calculated by replay when absent.
    """
    if len(raw) > 300_000:
        raise ValueError("成交 CSV 超过 300 KB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("成交 CSV 必须使用 UTF-8 编码") from exc
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or set(reader.fieldnames) != set(TRADE_FIELDS):
        raise ValueError("成交 CSV 字段必须为 trade_id,symbol,datetime,side,qty,price,fee,source")
    rows: list[dict] = []
    seen: set[str] = set()
    for line, item in enumerate(reader, 2):
        if line > 5001:
            raise ValueError("成交 CSV 行数过多")
        trade_id = (item.get("trade_id") or "").strip()
        symbol = (item.get("symbol") or "").strip().upper()
        side = (item.get("side") or "").strip().lower()
        source = (item.get("source") or "").strip()
        if (not trade_id or trade_id in seen or not _SYMBOL.fullmatch(symbol)
                or side not in {"buy", "sell"} or not source):
            raise ValueError(f"第 {line} 行成交标识、证券、方向或来源无效")
        try:
            dt = datetime.fromisoformat((item.get("datetime") or "").strip())
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=SHANGHAI)
            if dt.utcoffset() != timedelta(hours=8):
                raise ValueError("时区必须为北京时间 +08:00")
            qty = float(item["qty"])
            price = float(item["price"])
            fee_text = (item.get("fee") or "").strip()
            fee = float(fee_text) if fee_text else None
            if not all(math.isfinite(value) for value in (qty, price) if value is not None) or qty <= 0 or price <= 0:
                raise ValueError("数量和价格必须为正数")
            if fee is not None and (not math.isfinite(fee) or fee < 0):
                raise ValueError("手续费必须为非负数")
        except (TypeError, ValueError, KeyError) as exc:
            raise ValueError(f"第 {line} 行无效：{exc}") from exc
        seen.add(trade_id)
        rows.append({"trade_id": trade_id, "symbol": _canonical_symbol(symbol), "datetime": dt.isoformat(timespec="seconds"),
                     "side": side, "qty": qty, "price": price, "fee": fee, "source": source})
    if not rows:
        raise ValueError("成交 CSV 没有有效记录")
    return rows


def save_trade_csv(data_dir: Path, raw: bytes) -> dict:
    rows = parse_trade_csv(raw)
    path = _trade_rows_db(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=10)) as db:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS trades (trade_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, datetime TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, fee REAL, source TEXT NOT NULL)")
            db.executemany("INSERT INTO trades VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(trade_id) DO UPDATE SET symbol=excluded.symbol,datetime=excluded.datetime,side=excluded.side,qty=excluded.qty,price=excluded.price,fee=excluded.fee,source=excluded.source",
                           [tuple(row[field] for field in TRADE_FIELDS) for row in rows])
    return {"count": len(rows), "symbols": sorted({row["symbol"] for row in rows}), "source": "transaction_ledger"}


def load_trade_rows(data_dir: Path, symbol: str, trade_date: str) -> list[dict]:
    symbol = _canonical_symbol(symbol)
    path = _trade_rows_db(data_dir)
    if not path.exists():
        return _default_trade_rows(_legacy_symbol(symbol), trade_date)
    with closing(sqlite3.connect(path, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute("SELECT * FROM trades WHERE symbol=? AND datetime>=? AND datetime<? ORDER BY datetime,trade_id",
                                                (symbol, trade_date, (datetime.fromisoformat(trade_date) + timedelta(days=1)).date().isoformat()))]
    return rows or _default_trade_rows(_legacy_symbol(symbol), trade_date)


def _minute_allowed(dt: datetime) -> bool:
    t = dt.hour * 60 + dt.minute
    return 9 * 60 + 30 <= t <= 11 * 60 + 30 or 13 * 60 <= t <= 15 * 60


def _match_trade_lots(trades: list[dict]) -> tuple[float, float, float, float]:
    """Match opposite-side lots in time order, including sell-then-buy T trades.

    A sell with no earlier buy is treated as a reduction of an existing position
    until a later buy closes it; a buy with no earlier sell is held as an open
    lot until a later sell closes it.  This avoids using aggregate quantities,
    which cannot distinguish an add-on position from a round-trip.
    """
    pending_buys: list[dict] = []
    pending_sells: list[dict] = []
    matched_qty = matched_pnl = 0.0

    def consume(queue: list[dict], incoming: dict, *, sell_first: bool) -> None:
        nonlocal matched_qty, matched_pnl
        remaining = float(incoming["qty"])
        while remaining > 0 and queue:
            lot = queue[0]
            quantity = min(remaining, float(lot["qty"]))
            sell = lot if sell_first else incoming
            buy = incoming if sell_first else lot
            sell_fee = float(sell["fee"]) * quantity / float(sell["qty"])
            buy_fee = float(buy["fee"]) * quantity / float(buy["qty"])
            matched_qty += quantity
            matched_pnl += quantity * (float(sell["price"]) - float(buy["price"])) - sell_fee - buy_fee
            lot["qty"] = float(lot["qty"]) - quantity
            remaining -= quantity
            if lot["qty"] <= 1e-9:
                queue.pop(0)
        if remaining > 1e-9:
            incoming["qty"] = remaining
        else:
            incoming["qty"] = 0.0

    for trade in trades:
        current = {"qty": float(trade["qty"]), "price": float(trade["price"]), "fee": float(trade["fee"])}
        if trade["side"] == "buy":
            consume(pending_sells, current, sell_first=True)
            if current["qty"] > 1e-9:
                pending_buys.append(current)
        else:
            consume(pending_buys, current, sell_first=False)
            if current["qty"] > 1e-9:
                pending_sells.append(current)
    return (matched_qty, matched_pnl,
            sum(float(lot["qty"]) for lot in pending_buys),
            sum(float(lot["qty"]) for lot in pending_sells))


def _coverage(rows: list[dict]) -> dict:
    stamps = {row["datetime"][11:16] for row in rows}
    options = []
    for offset in (0, 1):
        expected = {f"{minute // 60:02d}:{minute % 60:02d}" for minute in
                    list(range(570+offset, 690+offset)) + list(range(780+offset, 900+offset))}
        options.append((len(expected-stamps), len(stamps-expected)))
    missing, extra = min(options, key=lambda item: sum(item))
    return {"complete": len(rows) == 240 and missing == 0 and extra == 0,
            "missing_minutes": missing, "unexpected_minutes": extra}


def parse_csv(raw: bytes) -> tuple[list[dict], dict]:
    if len(raw) > 300_000:
        raise ValueError("CSV 超过 300 KB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("CSV 必须使用 UTF-8 编码") from exc
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or set(reader.fieldnames) != set(FIELDS):
        raise ValueError("CSV 字段必须为 symbol,datetime,open,high,low,close,volume,amount,source")
    rows = []
    seen = set()
    for line, item in enumerate(reader, 2):
        if line > 1000:
            raise ValueError("CSV 行数过多")
        symbol = (item.get("symbol") or "").strip().upper()
        if symbol not in SYMBOLS:
            raise ValueError(f"第 {line} 行证券代码不在首批支持范围")
        try:
            dt = datetime.fromisoformat((item.get("datetime") or "").strip())
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=SHANGHAI)
            elif dt.utcoffset() != timedelta(hours=8):
                raise ValueError("时区必须为北京时间 +08:00")
            if dt.second or dt.microsecond or dt.date().isoformat() != TARGET_DAY or not _minute_allowed(dt):
                raise ValueError("日期或交易时段不正确")
            values = {key: float(item[key]) for key in ("open", "high", "low", "close", "volume", "amount")}
            if any(not math.isfinite(value) or value < 0 for value in values.values()):
                raise ValueError("数值必须非负且有限")
            if min(values[key] for key in ("open", "high", "low", "close")) <= 0:
                raise ValueError("价格必须大于零")
            if values["low"] > min(values["open"], values["close"]) or values["high"] < max(values["open"], values["close"]):
                raise ValueError("OHLC 顺序错误")
            source = (item.get("source") or "").strip()
            if source != "PTrade":
                raise ValueError("来源必须为 PTrade；不得把其他行情标注为券商数据")
            key = (symbol, dt.isoformat(timespec="minutes"))
            if key in seen:
                raise ValueError("CSV 含重复分钟")
            seen.add(key)
            rows.append({"symbol": symbol, "datetime": key[1], **values, "source": source})
        except (TypeError, ValueError, KeyError) as exc:
            raise ValueError(f"第 {line} 行无效：{exc}") from exc
    if not rows:
        raise ValueError("CSV 没有有效分钟行情")
    rows.sort(key=lambda item: (item["symbol"], item["datetime"]))
    counts = {symbol: sum(row["symbol"] == symbol for row in rows) for symbol in sorted(SYMBOLS)}
    return rows, {"counts": counts, "coverage": {symbol: _coverage([row for row in rows if row["symbol"] == symbol]) for symbol in counts},
                  "volume_unit": "份（PTrade 原始 volume；请在客户端核实券商口径）",
                  "amount_unit": "元", "source": "PTrade"}


def save_csv(data_dir: Path, raw: bytes) -> dict:
    rows, report = parse_csv(raw)
    path = _db(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=10)) as db:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS minute (symbol TEXT NOT NULL, datetime TEXT NOT NULL, "
                       "open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, "
                       "volume REAL NOT NULL, amount REAL NOT NULL, source TEXT NOT NULL, "
                       "PRIMARY KEY(symbol,datetime))")
            db.executemany("INSERT INTO minute VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(symbol,datetime) "
                           "DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,"
                           "volume=excluded.volume,amount=excluded.amount,source=excluded.source",
                           [tuple(row[key] for key in FIELDS) for row in rows])
    return report


def load(data_dir: Path, symbol: str, trade_date: str = TARGET_DAY) -> list[dict]:
    storage_symbol = _legacy_symbol(symbol)
    if storage_symbol not in SYMBOLS or not _db(data_dir).exists():
        return []
    with closing(sqlite3.connect(_db(data_dir), timeout=10)) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute("SELECT * FROM minute WHERE symbol=? AND datetime>=? "
                                               "AND datetime<? ORDER BY datetime", (storage_symbol, trade_date,
                                               (datetime.fromisoformat(trade_date) + timedelta(days=1)).date().isoformat()))]


def replay(symbol: str, rows: list[dict], source: str = "PTrade", *,
           trade_date: str = TARGET_DAY, trades: list[dict] | None = None) -> dict:
    trade_rows = trades if trades is not None else _default_trade_rows(symbol, trade_date)
    trades = []
    cash = 0.0
    fee_total = 0.0
    sold = 0
    bought = 0
    for row in trade_rows:
        side = row["side"]
        qty = float(row["qty"])
        price = float(row["price"])
        fee = float(row["fee"]) if row.get("fee") is not None else max(5.0, price * qty * .0001)
        signed = price * qty if side == "sell" else -price * qty
        cash += signed - fee
        fee_total += fee
        sold += qty if side == "sell" else 0
        bought += qty if side == "buy" else 0
        trades.append({"trade_id": row.get("trade_id"), "datetime": row["datetime"], "side": side,
                       "qty": qty, "price": price, "fee": round(fee, 2), "source": row.get("source", source),
                       "cash_flow": round(signed-fee, 2)})
    matched, t_spread, unmatched_buy, unmatched_sell = _match_trade_lots(trades)
    extra = unmatched_buy - unmatched_sell
    close = rows[-1]["close"] if rows else None
    incremental = cash + extra * close if close is not None else None
    best = None
    backtest = None
    support = resistance = None
    if len(rows) >= 20:
        # Hindsight bound: one complete buy/sell round trip, price at minute close.
        lowest = (rows[0]["close"], 0)
        best_trade = None
        for index in range(1, len(rows)):
            price = rows[index]["close"]
            spread = price - lowest[0]
            if best_trade is None or spread > best_trade[0]:
                best_trade = (spread, lowest[1], index)
            if price < lowest[0]:
                lowest = (price, index)
        if best_trade:
            buy_price = rows[best_trade[1]]["close"]
            sell_price = rows[best_trade[2]]["close"]
            theoretical = matched*(sell_price-buy_price)-max(5, matched*buy_price*.0001)-max(5, matched*sell_price*.0001)
            best = {"buy_time": rows[best_trade[1]]["datetime"] if theoretical > 0 else None,
                    "sell_time": rows[best_trade[2]]["datetime"] if theoretical > 0 else None,
                    "pnl": round(max(0, theoretical), 2),
                    "disclaimer": "事后最优，使用未来行情挑选时点，不能作为可执行策略。"}
        # Causal illustrative strategy: signal from completed closes; fill at next open.
        position = 0
        strategy_cash = 0.0
        strategy_fees = 0.0
        events = []
        peak = 0.0
        max_drawdown = 0.0
        for index in range(20, len(rows)):
            prior = rows[:index]
            sma5 = sum(bar["close"] for bar in prior[-5:]) / 5
            sma20 = sum(bar["close"] for bar in prior[-20:]) / 20
            fill = rows[index]
            if position == 0 and sma5 > sma20 and len(events) == 0:
                fee = max(5, matched*fill["open"]*.0001)
                strategy_cash -= matched*fill["open"] + fee
                strategy_fees += fee
                position = matched
                events.append({"side": "buy", "time": fill["datetime"], "price": fill["open"]})
            elif position and sma5 < sma20:
                fee = max(5, position*fill["open"]*.0001)
                strategy_cash += position*fill["open"] - fee
                strategy_fees += fee
                position = 0
                events.append({"side": "sell", "time": fill["datetime"], "price": fill["open"]})
            equity = strategy_cash + position*fill["close"]
            peak = max(peak, equity)
            max_drawdown = max(max_drawdown, peak-equity)
        if position:
            fee = max(5, position*rows[-1]["close"]*.0001)
            strategy_cash += position*rows[-1]["close"] - fee
            strategy_fees += fee
            events.append({"side": "sell", "time": rows[-1]["datetime"], "price": rows[-1]["close"]})
        backtest = {"pnl": round(strategy_cash, 2), "max_drawdown_yuan": round(max_drawdown, 2),
                    "trade_count": len(events), "cost": round(strategy_fees, 2), "events": events,
                    "rule": "前20根已完成分钟K的MA5高于MA20时，下根开盘买入；跌破时下根开盘卖出，收盘强制平仓。仅作无未来函数的示例，不含滑点。"}
        support = min(bar["low"] for bar in rows[-20:])
        resistance = max(bar["high"] for bar in rows[-20:])
    return {"symbol": symbol, "date": trade_date, "source": source if rows else "awaiting_PTrade_CSV",
            "rows": rows, "row_count": len(rows), "coverage": _coverage(rows), "complete": _coverage(rows)["complete"],
            "trades": trades, "cash_flow": round(cash, 2), "fees": round(fee_total, 2),
            "matched_t_qty": round(matched, 6), "matched_t_pnl": round(t_spread, 2),
            "unmatched_buy_qty": round(unmatched_buy, 6), "unmatched_sell_qty": round(unmatched_sell, 6),
            "extra_qty": round(extra, 6),
            "close": close, "versus_no_trade": round(incremental, 2) if incremental is not None else None,
            "extra_position_mark_to_close": round(incremental-t_spread, 2) if incremental is not None else None,
            "hindsight_best": best, "causal_backtest": backtest,
            "support_20m": support, "resistance_20m": resistance,
            "note": "与不交易比较使用同日收盘价对额外持仓估值；未包含持仓初始成本及其他税费。"}
