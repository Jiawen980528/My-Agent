"""Allow-listed tool registry. No shell, arbitrary URL or filesystem tool exists here."""
import hashlib
from datetime import datetime
from zoneinfo import ZoneInfo
from . import db
from .config import settings
from . import email_store
from .modules import qq_mail
from .modules import web_news, market
from .quant_reference import sector_for_name

class ToolValidationError(ValueError): pass
class Tool:
    def __init__(self,name,description,parameters,handler,permission="write",risk="low",timeout_seconds=10):
        self.name,self.description,self.parameters,self.handler=name,description,parameters,handler
        self.permission,self.risk,self.timeout_seconds=permission,risk,timeout_seconds
    def schema(self): return {"type":"function","function":{"name":self.name,"description":self.description,"parameters":self.parameters}}
    def validate(self,args):
        if not isinstance(args,dict): raise ToolValidationError("参数必须是对象")
        props=self.parameters.get("properties",{}); required=self.parameters.get("required",[])
        unknown=set(args)-set(props)
        if unknown and self.parameters.get("additionalProperties") is False: raise ToolValidationError("存在未允许参数")
        for key in required:
            if key not in args: raise ToolValidationError(f"缺少参数: {key}")
        for key,value in args.items():
            spec=props.get(key,{})
            if spec.get("type")=="string" and not isinstance(value,str): raise ToolValidationError(f"{key} 必须是字符串")
            if spec.get("type")=="object" and not isinstance(value,dict): raise ToolValidationError(f"{key} 必须是对象")
            if spec.get("type")=="integer" and (not isinstance(value,int) or isinstance(value,bool)): raise ToolValidationError(f"{key} 必须是整数")
            if "minimum" in spec and value < spec["minimum"]: raise ToolValidationError(f"{key} 过小")
            if "maximum" in spec and value > spec["maximum"]: raise ToolValidationError(f"{key} 过大")

class ToolRegistry:
    def __init__(self): self._tools={}
    def register(self,tool):
        if tool.name in self._tools: raise ValueError(f"重复工具: {tool.name}")
        self._tools[tool.name]=tool
    def get(self,name): return self._tools.get(name)
    def schemas(self): return [x.schema() for x in self._tools.values()]
    def names(self): return sorted(self._tools)

registry=ToolRegistry()
def remember(args):
    mid=db.save_memory(args["content"],"agent_tool"); db.log_event("INFO","memory_saved",f"id={mid}"); return {"ok":True,"memory_id":mid}
def search_memory(args): return {"items":db.search_memories(args["query"],args.get("limit",10))}
def create_reminder(args):
    try:
        local=datetime.fromisoformat(args["run_at"])
        if local.tzinfo is None: local=local.replace(tzinfo=ZoneInfo(settings.timezone))
        utc=local.astimezone(ZoneInfo("UTC")).replace(microsecond=0).isoformat()
    except ValueError as e: raise ToolValidationError("run_at 必须是 ISO 8601 时间") from e
    task_id=db.create_task(args["title"],utc,str(local.tzinfo)); db.log_event("INFO","task_created",f"id={task_id}")
    return {"ok":True,"task_id":task_id,"run_at_utc":utc,"message":"提醒已创建；当前版本仅在本系统记录执行结果。"}
def request_action(args):
    raw=f"{args['action_type']}|{args['target']}|{args['payload']}"
    key=hashlib.sha256(raw.encode()).hexdigest()
    try: aid=db.create_approval(args["action_type"],args["target"],args["payload"],"high",key)
    except Exception: return {"ok":False,"status":"duplicate","message":"相同高风险操作已在审批队列，未重复创建。"}
    db.log_event("WARNING","approval_requested",f"id={aid}, type={args['action_type']}")
    return {"ok":True,"approval_id":aid,"status":"pending_approval","message":"高风险操作已暂停等待人工审批；本版本绝不执行真实外部操作。"}

def read_qq_unread(args):
    credentials = email_store.qq_credentials()
    if not credentials:
        return {"ok": False, "message": "QQ 邮箱尚未连接。"}
    limit = args.get("limit", 10)
    items = qq_mail.unread_headers(*credentials, limit=limit)
    db.log_event("INFO", "qq_mail_unread_read", f"count={len(items)}")
    return {"ok": True, "items": items, "message": f"已读取 {len(items)} 封未读邮件的摘要。"}

def queue_qq_mail_send(args):
    if not email_store.qq_credentials():
        return {"ok": False, "message": "QQ 邮箱尚未连接，无法准备发送。"}
    payload={"recipient":args["recipient"].strip(),"subject":args["subject"].strip(),"body":args["body"].strip()}
    raw=f"send_qq_mail|{payload['recipient']}|{payload['subject']}|{payload['body']}"
    try:
        approval_id=db.create_approval("send_qq_mail",payload["recipient"],payload,"high",hashlib.sha256(raw.encode()).hexdigest())
    except Exception:
        return {"ok":False,"status":"duplicate","message":"相同邮件已在待确认列表，未重复创建。"}
    db.log_event("WARNING","qq_mail_send_queued",f"id={approval_id}, recipient={payload['recipient']}")
    return {"ok":True,"status":"pending_approval","approval_id":approval_id,"message":"邮件已准备好，等待你在“高风险审批”中点击批准并执行。"}

def search_latest_news(args):
    result = web_news.search(args["query"], args.get("limit", 8))
    db.log_event("INFO", "web_news_searched", f"query={result['query']}, count={len(result['items'])}")
    return {"ok": True, **result}

def read_quant_portfolio(args):
    """Read the user's recorded portfolio and saved screening runs."""
    limit = args.get("scan_limit", 5)
    return {
        "ok": True,
        "holdings": db.list_quant_holdings(),
        "watchlist": db.list_quant_watch(),
        "recent_scans": db.list_quant_scans(limit),
        "note": "持仓为 MyAgent 已记录数据；券商账户未自动同步时可能不是当前实际仓位。",
    }

def read_tickflow_market(args):
    """Read a bounded, source-labelled TickFlow market and K-line snapshot."""
    symbols = args.get("symbols", [])
    if not isinstance(symbols, list) or len(symbols) > 8 or any(
        not isinstance(value, str) or len(value) > 16 for value in symbols
    ):
        raise ToolValidationError("symbols 须为最多 8 个指数或股票代码")
    days = args.get("days", 60)
    snapshot = market.get_tickflow_context(symbols, days)
    if not snapshot:
        return {"ok": False, "error": "TickFlow 行情桥接暂不可用"}
    klines = []
    for item in snapshot.get("klines", []):
        if isinstance(item, dict):
            klines.append({
                "symbol": item.get("symbol"), "source": item.get("source"),
                "rows": (item.get("rows") or [])[-30:],
            })
    return {
        "ok": True, "source": snapshot.get("source"), "as_of": snapshot.get("as_of"),
        "market": snapshot.get("market"), "klines": klines,
        "note": "标注数据时点与来源；公开行情和收盘数据不得称为交易所实时行情。",
    }


def read_quant_intraday(args):
    """Provide one verified minute series to the agent with bounded context."""
    symbol = str(args["symbol"]).strip().upper().replace(".SS", ".SH")
    if len(symbol) == 6 and symbol.isdigit():
        symbol += ".SH" if symbol.startswith(("5", "6")) else ".SZ"
    parts = symbol.split(".")
    if len(parts) != 2 or len(parts[0]) != 6 or not parts[0].isdigit() or parts[1] not in {"SH", "SZ", "BJ"}:
        raise ToolValidationError("请输入完整证券代码，如 159558.SZ")
    day = args.get("trade_date")
    if day:
        try:
            day = datetime.strptime(day, "%Y-%m-%d").date().isoformat()
        except (TypeError, ValueError) as exc:
            raise ToolValidationError("trade_date 应为 YYYY-MM-DD") from exc
    else:
        from datetime import timedelta
        current = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        while current.weekday() >= 5:
            current -= timedelta(days=1)
        day = current.isoformat()
    payload = market.get_tickflow_portfolio("portfolio-minute", {"symbol": symbol, "trade_date": day})
    rows = payload.get("rows") or []
    if not rows:
        return {"ok": False, "symbol": symbol, "trade_date": day, "source": payload.get("source"), "message": "该交易日暂无授权分钟数据"}
    replay = payload.get("replay")
    return {"ok": True, "symbol": symbol, "trade_date": day,
            "source": payload.get("source"), "last_market_time": payload.get("last_market_time"),
            "minute_count": len(rows), "last_price": rows[-1].get("close"),
            "day_high": max(row["high"] for row in rows), "day_low": min(row["low"] for row in rows),
            "recent_minutes": rows[-40:],
            "user_reported_trade_replay": replay,
            "note": "仅基于实际返回的分钟K；成交点若有则为用户提供，非券商回报。非交易时间不得称为实时更新。"}

def read_quant_sector(args):
    name = args["name"].strip()
    return {"ok": True, "name": name, "sector": sector_for_name(name)}

registry.register(Tool("remember_note","Save a note to persistent personal memory.",{"type":"object","properties":{"content":{"type":"string"}},"required":["content"],"additionalProperties":False},remember,"write","low"))
registry.register(Tool("search_memory","Search saved personal memories.",{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["query"],"additionalProperties":False},search_memory,"read","low"))
registry.register(Tool("create_reminder","Create a one-time reminder with ISO datetime.",{"type":"object","properties":{"title":{"type":"string"},"run_at":{"type":"string"}},"required":["title","run_at"],"additionalProperties":False},create_reminder,"write","medium"))
registry.register(Tool("request_high_risk_action","Queue an external/high-risk action for approval only; never execute.",{"type":"object","properties":{"action_type":{"type":"string"},"target":{"type":"string"},"payload":{"type":"object"}},"required":["action_type","target","payload"],"additionalProperties":False},request_action,"approval","high"))
registry.register(Tool("read_qq_unread","Read the sender, subject and date of unread QQ Mail messages only.",{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":20}},"additionalProperties":False},read_qq_unread,"read","low"))
registry.register(Tool("queue_qq_mail_send","Prepare one QQ email to send. This never sends automatically; the user must approve it in the dashboard.",{"type":"object","properties":{"recipient":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"}},"required":["recipient","subject","body"],"additionalProperties":False},queue_qq_mail_send,"approval","high"))
registry.register(Tool("search_latest_news","Search public news RSS feeds for current topics. Use for latest news, current events, markets or recent developments; results are read-only.",{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":12}},"required":["query"],"additionalProperties":False},search_latest_news,"read","low",timeout_seconds=20))
registry.register(Tool("read_quant_portfolio","Read MyAgent recorded stock holdings, watchlist and recent 拾贝模型 screening runs. Distinguish recorded positions from live broker positions.",{"type":"object","properties":{"scan_limit":{"type":"integer","minimum":1,"maximum":20}},"additionalProperties":False},read_quant_portfolio,"read","low"))
registry.register(Tool("read_tickflow_market","Read TickFlow market overview and recent daily K-lines for up to 8 stock or index symbols. Use this for market indicators and price questions; report source and timestamp.",{"type":"object","properties":{"symbols":{"type":"array","items":{"type":"string"},"maxItems":8},"days":{"type":"integer","minimum":20,"maximum":200}},"additionalProperties":False},read_tickflow_market,"read","low",timeout_seconds=30))
registry.register(Tool("read_quant_intraday","Read one stock or ETF's actual TickFlow minute K data, latest market timestamp and user-reported ETF trade replay. Use for intraday, 做T or minute-chart questions; state market date and source.",{"type":"object","properties":{"symbol":{"type":"string"},"trade_date":{"type":"string"}},"required":["symbol"],"additionalProperties":False},read_quant_intraday,"read","low",timeout_seconds=30))
registry.register(Tool("read_quant_sector","Look up the user's saved sector classification for a stock or company name.",{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":False},read_quant_sector,"read","low"))
