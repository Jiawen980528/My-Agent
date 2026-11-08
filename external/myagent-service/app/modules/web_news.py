"""Bounded, read-only public news search via RSS feeds."""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus
from xml.etree import ElementTree

import httpx

SOURCES = (
    "https://www.bing.com/news/search?q={query}&format=rss&mkt=zh-CN",
    "https://news.google.com/rss/search?q={query}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
)

def _text(node, path: str) -> str:
    child = node.find(path)
    return (child.text or "").strip() if child is not None else ""

def search(query: str, limit: int = 8) -> dict:
    query = " ".join(query.split())
    if not query or len(query) > 160:
        raise ValueError("新闻检索词需为 1–160 个字符")
    last_error = None
    for template in SOURCES:
        try:
            response = httpx.get(template.format(query=quote_plus(query)), timeout=12, follow_redirects=True, headers={"User-Agent":"MyAgent/0.2 RSS reader"})
            response.raise_for_status()
            root = ElementTree.fromstring(response.content)
            results = []
            for item in root.findall("./channel/item")[:limit]:
                published = _text(item, "pubDate")
                try:
                    published = parsedate_to_datetime(published).astimezone(timezone.utc).isoformat()
                except (TypeError, ValueError):
                    pass
                results.append({"title": _text(item, "title"), "url": _text(item, "link"), "summary": _text(item, "description"), "published_at": published, "source": _text(item, "source")})
            if results:
                return {"query": query, "fetched_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "items": results}
        except Exception as exc:
            last_error = exc
    raise RuntimeError("公开新闻源暂时不可用") from last_error
