"""Retained public market headlines; UI sector selections never restrict ingestion."""
from __future__ import annotations

import html
import re
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx

from .. import db
from ..quant_reference import SECTOR_REFERENCE

_lock = threading.Lock()
_MARKET_TERMS = ("A股", "沪深", "股市", "交易所", "央行", "证监会", "ETF", "利率", "降准", "政策", "板块")
_SECTOR_TERMS: dict[str, tuple[str, ...]] = {
    "CPO光通信": ("CPO", "光模块", "光通信", "硅光", "800G", "1.6T"),
    "AI算力硬件": ("算力", "PCB", "印制电路板", "AI服务器"),
    "半导体芯片": ("半导体", "芯片", "晶圆", "存储器", "集成电路"),
    "服务器液冷": ("液冷", "数据中心", "服务器"),
    "人形机器人": ("人形机器人", "机器人", "减速器", "灵巧手"),
    "AI应用": ("人工智能应用", "智能体", "大模型", "AI应用"),
    "商业航天": ("商业航天", "卫星互联网", "卫星通信", "火箭"),
    "低空经济": ("低空经济", "eVTOL", "飞行汽车", "无人机"),
    "证券金融": ("券商", "证券业", "证券公司", "金融科技"),
    "银行红利": ("银行", "净息差", "高股息"),
    "创新药": ("创新药", "CXO", "医药", "医疗", "制药"),
    "稀土有色": ("稀土", "有色", "铜价", "铝价", "小金属"),
    "黄金贵金属": ("黄金", "白银", "金价", "贵金属"),
    "基础化工": ("化工", "化肥", "新材料", "氟化工"),
    "煤炭石油": ("煤炭", "石油", "油气", "天然气", "原油"),
    "电力电网": ("电网", "电力", "特高压", "电气设备"),
    "锂电池": ("锂电", "锂矿", "固态电池", "动力电池"),
    "新能源汽车": ("新能源汽车", "电动车", "智能驾驶", "汽车零部件"),
    "军工装备": ("军工", "国防", "航空装备", "船舶装备"),
    "光伏": ("光伏", "硅片", "太阳能电池"),
    "储能": ("储能", "钠离子电池"),
    "消费零售": ("消费", "零售", "白酒", "餐饮"),
    "房地产": ("房地产", "房企", "商品房", "楼市"),
    "航运物流": ("航运", "集装箱", "快递", "物流"),
    "传媒游戏": ("传媒", "游戏", "影视"),
}
_REFERENCE = {row["sector"]: row for row in SECTOR_REFERENCE}
_SECTOR_NAMES = list(dict.fromkeys(["CPO光通信", *_REFERENCE.keys(), *_SECTOR_TERMS.keys()]))
_GOOD_TERMS = ("获批", "中标", "签订大单", "增持", "回购", "业绩预增", "净利润增长", "盈利增长", "涨价", "价格上涨", "上调评级", "补贴", "扭亏")
_BAD_TERMS = ("减持", "业绩预亏", "亏损扩大", "立案调查", "被罚", "下调评级", "停产", "违约", "债务危机", "暴跌", "大跌", "价格下跌", "需求下降")
_ROLL_ITEM = re.compile(r'<li>\s*<span>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*</span>\s*\[<a[^>]*>([^<]*)</a>\]\s*<a\s+href="(https?://[^"]+)"\s+title="([^"]+)"', re.I)
_THS_ITEM = re.compile(r'<a[^>]+title="([^"]+)"\s+href="(https?://[^" ]+\.shtml)"\s+class="news-link"[^>]*>.*?</a>\s*<span>(\d{1,2})月(\d{1,2})日\s+(\d{2}:\d{2})</span>', re.I | re.S)


def _fetch_page(path: str) -> list[dict]:
    response = httpx.get("https://roll.eastmoney.com/" + path, timeout=10, follow_redirects=True,
                         headers={"User-Agent": "Mozilla/5.0 (compatible; MyAgentNews/1.0)"})
    response.raise_for_status()
    rows = []
    for timestamp, category, url, title in _ROLL_ITEM.findall(response.text):
        host = urlparse(url).hostname or ""
        if host != "eastmoney.com" and not host.endswith(".eastmoney.com"):
            continue
        rows.append({"title": html.unescape(title), "url": url,
                     "published_at": timestamp.replace(" ", "T") + ":00+08:00",
                     "source": "东方财富·" + html.unescape(category)})
    return rows


def _safe_fetch(path: str) -> list[dict] | None:
    try:
        return _fetch_page(path)
    except (httpx.HTTPError, ValueError):
        return None


def _fetch_ths(path: str) -> list[dict]:
    response = httpx.get("https://news.10jqka.com.cn/thsgd_list/" + path, timeout=10,
                         follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"})
    response.raise_for_status()
    rows = []
    for title, url, month, day, clock in _THS_ITEM.findall(response.content.decode("gb18030", errors="replace")):
        host = urlparse(url).hostname or ""
        date_match = re.search(r"/(\d{4})(\d{2})(\d{2})/", url)
        if not host.endswith(".10jqka.com.cn") or not date_match:
            continue
        year, url_month, url_day = date_match.groups()
        if int(month) != int(url_month) or int(day) != int(url_day):
            continue
        rows.append({"title": html.unescape(title), "url": url.replace("http://", "https://", 1),
                     "published_at": f"{year}-{url_month}-{url_day}T{clock}:00+08:00", "source": "同花顺滚动"})
    return rows


def _safe_ths(path: str) -> list[dict] | None:
    try:
        return _fetch_ths(path)
    except (httpx.HTTPError, ValueError, UnicodeError):
        return None


def refresh_news() -> dict:
    """Save public headlines for all sectors, regardless of dashboard preferences."""
    if not _lock.acquire(blocking=False):
        return {"status": "busy", "fetched": 0}
    try:
        with db.session() as connection:
            existing = connection.execute("SELECT COUNT(*) FROM quant_news_items").fetchone()[0]
        paths = ["", "stock.html", "finance.html"]
        paths += [f"default_{n}.html" for n in range(2, 16 if existing == 0 else 5)]
        paths += [f"stock_{n}.html" for n in range(2, 6 if existing == 0 else 3)]
        rows, errors = [], 0
        with ThreadPoolExecutor(max_workers=4) as pool:
            for result in pool.map(_safe_fetch, paths):
                if result is None:
                    errors += 1
                else:
                    rows.extend(result)
            for result in pool.map(_safe_ths, ["index.shtml", "index_2.shtml"]):
                if result is None:
                    errors += 1
                else:
                    rows.extend(result)
        if rows:
            now = db.utc_now()
            with db.session() as connection:
                connection.executemany(
                    "INSERT INTO quant_news_items(url,title,source,published_at,fetched_at) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(url) DO UPDATE SET title=excluded.title,source=excluded.source,"
                    "published_at=excluded.published_at,fetched_at=excluded.fetched_at",
                    [(r["url"], r["title"], r["source"], r["published_at"], now) for r in rows])
                connection.execute("DELETE FROM quant_news_items WHERE url NOT IN "
                                   "(SELECT url FROM quant_news_items ORDER BY published_at DESC LIMIT 5000)")
        return {"status": "ok" if rows else "unavailable", "fetched": len(rows), "failed_pages": errors}
    finally:
        _lock.release()


def classify_headline(title: str, held_sectors: tuple[str, ...] = ()) -> dict:
    upper = title.upper()
    sectors = [name for name, words in _SECTOR_TERMS.items() if any(word.upper() in upper for word in words)]
    for name, ref in _REFERENCE.items():
        if name not in sectors and any(stock in title for stock in ref["anchors"] + ref["watch"]):
            sectors.append(name)
    for name in held_sectors:
        if len(name) >= 2 and name in title and name not in sectors:
            sectors.append(name)
    good = [term for term in _GOOD_TERMS if term in title]
    bad = [term for term in _BAD_TERMS if term in title]
    if good and not bad:
        bias, cue = "可能利好", "标题出现正向线索：" + "、".join(good[:3])
    elif bad and not good:
        bias, cue = "可能利空", "标题出现负向线索：" + "、".join(bad[:3])
    elif good and bad:
        bias, cue = "待判断", "标题同时包含正负线索，需核对原文"
    else:
        bias, cue = "待判断", "标题没有足够的方向性信息"
    return {"bias": bias, "bias_reason": cue, "sector_names": sectors}


def headlines(holdings: list[dict], interval_minutes: int = 5) -> dict:
    interval_minutes = max(1, min(15, interval_minutes))
    with db.session() as connection:
        newest = connection.execute("SELECT MAX(fetched_at) FROM quant_news_items").fetchone()[0]
    if not newest or (datetime.now(timezone.utc) - datetime.fromisoformat(newest)).total_seconds() >= interval_minutes * 60:
        refresh_news()
    with db.session() as connection:
        stored = [dict(row) for row in connection.execute(
            "SELECT title,url,source,published_at,fetched_at FROM quant_news_items "
            "ORDER BY published_at DESC LIMIT 2000").fetchall()]
    names = tuple(sorted({str(x.get("name") or "").strip() for x in holdings if x.get("name")}))
    held_sectors = tuple(sorted({str(x.get("sector") or "").strip() for x in holdings if x.get("sector")}))
    items = []
    counts: dict[str, Counter] = {name: Counter() for name in _SECTOR_NAMES}
    for row in stored:
        title = row["title"]
        matched_holdings = [name for name in names if len(name) >= 2 and name in title]
        matched_sectors = [name for name in held_sectors if len(name) >= 2 and name in title]
        classification = classify_headline(title, held_sectors)
        market = [term for term in _MARKET_TERMS if term in title]
        relevance = ("持仓相关" if matched_holdings else "板块相关" if matched_sectors or classification["sector_names"]
                     else "市场相关" if market else "其他")
        item = {**row, **classification, "relevance": relevance,
                "matched_holdings": matched_holdings, "matched_sectors": matched_sectors,
                "watch_reason": "提及持仓：" + "、".join(matched_holdings) if matched_holdings else
                    "提及板块：" + "、".join(matched_sectors) if matched_sectors else
                    "涉及市场主题：" + "、".join(market[:2]) if market else "一般资讯"}
        items.append(item)
        for sector in classification["sector_names"]:
            counts.setdefault(sector, Counter())["total"] += 1
            counts[sector][classification["bias"]] += 1
    catalog = [{"name": name, "theme": _REFERENCE.get(name, {}).get("theme", ""),
                "count": counts[name]["total"], "positive": counts[name]["可能利好"],
                "negative": counts[name]["可能利空"]} for name in counts]
    catalog.sort(key=lambda row: (-row["count"], row["name"]))
    newest_fetch = max((r["fetched_at"] for r in stored), default=None)
    stale = not newest_fetch or (datetime.now(timezone.utc) - datetime.fromisoformat(newest_fetch)).total_seconds() > 900
    return {"items": items, "sectors": catalog, "total_items": len(items),
            "fetched_at": newest_fetch or datetime.now(timezone.utc).isoformat(),
            "source": "东方财富 / 同花顺公开滚动新闻", "status": "unavailable" if not items else "stale" if stale else "ok",
            "notice": "公开滚动新闻按所选间隔采集；仅覆盖已抓取的公开页面。板块和利好利空为标题关键词初判，请核对原文。"}
