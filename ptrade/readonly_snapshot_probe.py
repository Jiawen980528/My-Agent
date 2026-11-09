"""PTrade 本机只读快照探针。

把本文件放入 PTrade 的研究/策略 Python 环境运行。它只读取已登录会话中的
持仓、行情、成交和关联板块，并写出 JSON；不读取密码，也不包含任何交易动作。
不同 PTrade 版本的函数名略有差异，探针会优先使用存在的只读函数，并把缺失项
写入 errors，而不是伪造数据。
"""
from __future__ import print_function

import datetime
import json
import os

OUTPUT = os.environ.get("MYAGENT_PTRADE_SNAPSHOT", "ptrade_readonly_snapshot.json")
SYMBOLS = tuple(os.environ.get("MYAGENT_SYMBOLS", "159558.SZ,588080.SH,159246.SZ,510210.SH,000938.SZ,515880.SH,600939.SH").split(","))


def _call(name, *args, **kwargs):
    fn = globals().get(name)
    if not callable(fn):
        return None
    try:
        return fn(*args, **kwargs)
    except Exception as exc:
        return {"__error__": type(exc).__name__ + ": " + str(exc)[:160]}


def _rows(value):
    if value is None or isinstance(value, dict) and "__error__" in value:
        return []
    if isinstance(value, dict):
        return [dict(value)]
    if isinstance(value, (list, tuple)):
        return [dict(row) for row in value if isinstance(row, dict)]
    if hasattr(value, "to_dict"):
        try:
            data = value.to_dict("records")
            return [dict(row) for row in data]
        except Exception:
            return []
    return []


def _pick(row, *names):
    for name in names:
        if isinstance(row, dict) and row.get(name) is not None:
            return row.get(name)
    return None


def collect():
    errors = []
    positions_raw = _call("get_positions")
    if positions_raw is None:
        errors.append("get_positions unavailable")
    positions = []
    for row in _rows(positions_raw):
        symbol = str(_pick(row, "symbol", "stock_code", "证券代码") or "").upper().replace(".SS", ".SH")
        if not symbol:
            continue
        positions.append({
            "symbol": symbol,
            "name": _pick(row, "name", "stock_name", "证券名称"),
            "quantity": _pick(row, "quantity", "持仓数量", "股份余额"),
            "available_quantity": _pick(row, "available_quantity", "可用数量", "可卖数量"),
            "cost": _pick(row, "cost", "cost_price", "平均成本", "持仓成本"),
        })

    quotes = []
    for symbol in SYMBOLS:
        value = _call("get_snapshot", symbol.strip().upper())
        for row in _rows(value):
            quotes.append({
                "symbol": symbol.strip().upper(),
                "last": _pick(row, "last", "price", "最新价"),
                "change_pct": _pick(row, "change_pct", "pct_chg", "涨跌幅"),
                "volume": _pick(row, "volume", "成交量"),
                "amount": _pick(row, "amount", "money", "成交额"),
            })

    blocks = []
    for symbol in SYMBOLS:
        value = _call("get_stock_blocks", symbol.strip().upper())
        for row in _rows(value):
            blocks.append({
                "symbol": symbol.strip().upper(),
                "code": _pick(row, "code", "板块代码"),
                "name": _pick(row, "name", "板块名称"),
            })

    trades = []
    value = _call("get_trades")
    for row in _rows(value):
        trades.append({
            "symbol": _pick(row, "symbol", "stock_code", "证券代码"),
            "time": _pick(row, "time", "成交时间"),
            "side": _pick(row, "side", "direction", "买卖方向"),
            "price": _pick(row, "price", "成交价格"),
            "quantity": _pick(row, "quantity", "成交数量"),
            "amount": _pick(row, "amount", "成交金额"),
        })

    payload = {
        "source": "ptrade",
        "read_only": True,
        "as_of": datetime.datetime.now().isoformat(),
        "account": {},
        "positions": positions,
        "quotes": quotes,
        "blocks": blocks,
        "trades": trades,
        "errors": errors,
    }
    with open(OUTPUT, "w") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, default=str)
    print("MyAgent PTrade read-only snapshot:", OUTPUT, "positions=", len(positions), "quotes=", len(quotes), "blocks=", len(blocks))
    return payload


def initialize(context):
    collect()


if __name__ == "__main__":
    collect()
