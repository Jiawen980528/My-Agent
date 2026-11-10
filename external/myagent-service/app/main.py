import secrets
import os
import json
import threading
import time
import uuid
import re
import urllib.request
import urllib.error
import httpx
from pathlib import Path
from fastapi import FastAPI, Header, HTTPException, Depends, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse, RedirectResponse
from pydantic import BaseModel, Field
from .config import settings
from . import db
from .agent import run_agent
from .scheduler import start_scheduler, stop_scheduler
from .tools import registry
from . import provider_store
from . import email_store
from .modules import qq_mail, market, quant_news, portfolio_monitor, terminal_ledger
from .quant_reference import sector_for_name, sector_payload
from . import attachment_store

app = FastAPI(
    title="MyAgent",
    version="0.2.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
quant_jobs: dict[str, dict] = {}
quant_jobs_lock = threading.Lock()

ICP_NUMBER = "鄂ICP备2026032696号"


def _with_icp_footer(html: str, *, dark: bool = False) -> str:
    color = "#8fa2bd" if dark else "#667085"
    background = "rgba(10, 16, 24, .94)" if dark else "rgba(255, 255, 255, .94)"
    layout = (
        ".shell{height:calc(100vh - 35px)!important;min-height:0!important}"
        if dark
        else ".app{height:calc(100vh - 35px)!important;min-height:0!important}"
             ".app>.side{min-height:0;overflow-y:auto}.app>main{min-width:0;min-height:0;overflow-y:auto}"
    )
    footer = f"""
<style>
html,body{{height:100%;overflow:hidden!important}}body{{padding:0!important}}{layout}
.site-icp{{position:fixed;left:0;right:0;bottom:0;z-index:4;height:35px;padding:9px 12px;text-align:center;
font:12px/1.4 system-ui,-apple-system,\"Segoe UI\",sans-serif;color:{color};background:{background};
border-top:1px solid rgba(127,145,170,.18);backdrop-filter:blur(10px)}}
.site-icp a{{color:inherit;text-decoration:none}}.site-icp a:hover{{text-decoration:underline}}
</style>
<footer class="site-icp"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">{ICP_NUMBER}</a></footer>
"""
    return html.replace("</body>", footer + "</body>")

class ChatRequest(BaseModel):
    model: str = Field(default="auto", max_length=200)
    message: str = Field(min_length=1, max_length=8000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=5)
class UploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    content_base64: str = Field(min_length=1, max_length=4_200_000)
class MemoryRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
class ApprovalDecision(BaseModel):
    decision: str = Field(pattern="^(approve|reject)$")
    note: str = Field(default="", max_length=1000)
class ProviderUpdate(BaseModel):
    api_key: str | None = Field(default=None, max_length=512)
    model: str | None = Field(default=None, min_length=1, max_length=200)
    clear_key: bool = False
class ProviderOrderUpdate(BaseModel):
    order: list[str] = Field(min_length=1, max_length=6)
class CustomProviderUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=40, pattern=r"^[a-zA-Z0-9_-]+$")
    label: str = Field(min_length=1, max_length=80)
    base_url: str = Field(min_length=8, max_length=300)
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=1024)
    usage_url: str = Field(default="", max_length=300)
    quota_url: str = Field(default="", max_length=300)
    enabled: bool = True
class QQMailConnectRequest(BaseModel):
    email: str = Field(min_length=6, max_length=254)
    authorization_code: str = Field(min_length=8, max_length=64)
class MailMarkReadRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=20)
class QuantScanRequest(BaseModel):
    max_market_cap_yi: float = Field(default=100, gt=0, le=10000)
    max_avg_turnover: float = Field(default=1.5, gt=0, le=100)
    recent_days: int = Field(default=5, ge=1, le=10)
    volume_multiple: float = Field(default=2.0, ge=1, le=20)
    baseline_days: int = Field(default=60, ge=20, le=120)
    min_decline_pct: float = Field(default=8.0, ge=0, le=80)
    max_volume_cv: float = Field(default=0.65, ge=0.05, le=3)
    ma_tolerance_pct: float = Field(default=3.0, ge=0.5, le=15)
    exclude_st: bool = True
    force: bool = False
class QuantAIRequest(BaseModel):
    symbol: str = Field(pattern=r"^\d{6}$")
    name: str = Field(default="", max_length=40)
    question: str = Field(min_length=1, max_length=1000)
    context: dict = Field(default_factory=dict)
class QuantLayoutRequest(BaseModel):
    layout: str = Field(min_length=1, max_length=500000)
class QuantWatchRequest(BaseModel):
    symbol: str = Field(pattern=r"^\d{6}$")
    name: str = Field(min_length=1, max_length=80)
    sector: str = Field(default="待绑定", max_length=80)
    note: str = Field(default="", max_length=500)
    context: dict = Field(default_factory=dict)
    attachment_ids: list[str] = Field(default_factory=list, max_length=5)
class QuantHoldingUpdate(BaseModel):
    symbol: str = Field(pattern=r"^\d{6}$")
    name: str = Field(min_length=1, max_length=40)
    quantity: int = Field(default=0, ge=0, le=1_000_000_000)
    available_quantity: int | None = Field(default=None, ge=0, le=1_000_000_000)
    cost: float = Field(default=0, ge=0, le=1_000_000)
    sector: str = Field(default="", max_length=60)
    source: str = Field(default="manual", pattern=r"^(manual|screenshot|qmt)$")

class QuantTradeUpdate(BaseModel):
    trade_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    trade_time: str = Field(pattern=r"^\d{2}:\d{2}$")
    symbol: str = Field(pattern=r"^\d{6}\.(SH|SS|SZ|BJ)$")
    side: str = Field(pattern=r"^(buy|sell)$")
    quantity: int = Field(gt=0, le=1_000_000_000)
    price: str = Field(min_length=1, max_length=30)
    external_id: str | None = Field(default=None, max_length=80)

SESSION_COOKIE = "myagent_session"
SESSION_DAYS = 180
SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60

def require_auth(request: Request, x_admin_token: str | None = Header(default=None)):
    if not settings.admin_token:
        raise HTTPException(status_code=503, detail="请先在 .env 配置 ADMIN_TOKEN")
    bridge_token = os.getenv("QUANT_BRIDGE_TOKEN", "")
    if bridge_token and request.headers.get("X-Quant-Bridge-Token") and secrets.compare_digest(request.headers["X-Quant-Bridge-Token"], bridge_token):
        return True
    token = x_admin_token or request.cookies.get(SESSION_COOKIE)
    if not token or not secrets.compare_digest(token, settings.admin_token):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return True

@app.on_event("startup")
def startup():
    db.init_db()
    start_scheduler()

@app.on_event("shutdown")
def shutdown():
    stop_scheduler()

@app.get("/", response_class=HTMLResponse)
def home():
    html = (Path(__file__).parent / "static.html").read_text(encoding="utf-8")
    html = html.replace(
        '<button data-p="content">◫ 内容与资讯</button>',
        '<button data-p="content">◫ 内容与资讯</button><button onclick="location.href=\'/quant\'">⌁ 统一量化终端</button><button onclick="location.href=\'/portfolio-monitor\'">▦ 持仓监控</button>',
    )
    # Migrate an already-authenticated agent.xdailab.com browser session to
    # the shared parent-domain cookie without asking for the token again.
    html = html.replace("</body>", "<script>fetch('/api/session',{method:'POST',credentials:'same-origin'}).catch(()=>{});</script></body>")
    return HTMLResponse(_with_icp_footer(html), headers={"Cache-Control": "no-store"})

@app.get("/quant", response_class=HTMLResponse)
def quant_page():
    html = (Path(__file__).parent / "quant.html").read_text(encoding="utf-8")
    return HTMLResponse(_with_icp_footer(html, dark=True), headers={"Cache-Control": "no-store"})

@app.get("/portfolio-monitor", response_class=HTMLResponse)
def portfolio_monitor_page():
    html = (Path(__file__).parent / "portfolio_monitor.html").read_text(encoding="utf-8")
    return HTMLResponse(_with_icp_footer(html, dark=True), headers={"Cache-Control": "no-store"})

@app.get("/tick-panel", response_class=HTMLResponse)
def tick_panel_page():
    # Compatibility route: the old standalone shell is intentionally no longer
    # rendered.  There is one canonical quant page so data, AI and layout state
    # cannot drift between two UIs.
    return RedirectResponse(url="/quant", status_code=307)

@app.get("/assets/lightweight-charts.js", include_in_schema=False)
def lightweight_charts_asset():
    return FileResponse(
        Path(__file__).parent / "vendor" / "lightweight-charts.standalone.production.js",
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )

@app.get("/api/health")
def health():
    return {"ok":True,"service":"MyAgent","version":"0.2.0","model_configured":bool(settings.configured_provider_names())}

@app.get("/api/config", dependencies=[Depends(require_auth)])
def config():
    profiles=settings.providers()
    order=settings.provider_order()
    names=[*order,*[name for name in profiles if name not in order]]
    ready = bool(settings.configured_provider_names())
    if "shared" in profiles:
        try:
            ready = bool(shared_model_options().get("configured"))
        except HTTPException:
            ready = False
    return {"model":profiles.get(settings.model_provider, next(iter(profiles.values()))).model,"api_key_configured":ready,"providers":[{"name":name,"label":profiles[name].label,"model":profiles[name].model,"configured":(ready if name == "shared" else bool(profiles[name].api_key)),"priority":order.index(name) + 1 if name in order else None} for name in names],"tools":[{"name":n,"risk":registry.get(n).risk,"permission":registry.get(n).permission} for n in registry.names()],"shared_ai": "shared" in profiles,"timezone":settings.timezone,"limits":{"max_model_calls":settings.max_model_calls,"max_task_seconds":settings.max_task_seconds,"max_task_cost_usd":settings.max_task_cost_usd}}

@app.put("/api/providers/config/{provider_name}", dependencies=[Depends(require_auth)])
def update_provider(provider_name: str, req: ProviderUpdate):
    if "shared" in settings.providers():
        raise HTTPException(status_code=409, detail="此 Agent 已启用统一 AI 配置，请前往 /quant/settings?tab=ai 修改")
    try:
        provider_store.update_provider(provider_name, req.api_key, req.model, req.clear_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.log_event("WARNING", "provider_config_updated", f"provider={provider_name}, key_changed={req.api_key is not None or req.clear_key}", actor="admin")
    return {"ok": True, "message": "模型平台配置已保存；API Key 不会回显。"}

@app.put("/api/providers/order", dependencies=[Depends(require_auth)])
def update_provider_order(req: ProviderOrderUpdate):
    if "shared" in settings.providers():
        raise HTTPException(status_code=409, detail="此 Agent 已启用统一 AI 配置，请前往 /quant/settings?tab=ai 修改")
    try:
        provider_store.update_order(req.order)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.log_event("WARNING", "provider_order_updated", ",".join(req.order), actor="admin")
    return {"ok": True, "message": "模型主备顺序已保存。"}

@app.get("/api/providers/custom", dependencies=[Depends(require_auth)])
def list_custom_providers():
    return {"items": provider_store.list_custom_providers()}

@app.put("/api/providers/custom/{provider_name}", dependencies=[Depends(require_auth)])
def update_custom_provider(provider_name: str, req: CustomProviderUpdate):
    if "shared" in settings.providers():
        raise HTTPException(status_code=409, detail="此 Agent 已启用统一 AI 配置，请前往 /quant/settings?tab=ai 修改")
    if provider_name != req.name:
        raise HTTPException(status_code=400, detail="接口名称与路径不一致")
    provider_store.update_custom_provider(req.model_dump())
    return {"ok": True, "message": "自定义接口已保存；密钥不会回显。"}

@app.delete("/api/providers/custom/{provider_name}", dependencies=[Depends(require_auth)])
def delete_custom_provider(provider_name: str):
    if "shared" in settings.providers():
        raise HTTPException(status_code=409, detail="此 Agent 已启用统一 AI 配置，请前往 /quant/settings?tab=ai 修改")
    if not provider_store.delete_custom_provider(provider_name):
        raise HTTPException(status_code=404, detail="自定义接口不存在")
    return {"ok": True}

@app.get("/api/providers/usage", dependencies=[Depends(require_auth)])
def provider_usage():
    """Return non-secret usage data. Providers without a quota API report unknown."""
    profiles = settings.providers()
    items = []
    for name in settings.provider_order():
        profile = profiles.get(name)
        if profile:
            items.append({"name": name, "label": profile.label, "configured": bool(profile.api_key),
                          "used": None, "remaining": None, "unit": "额度", "source": "供应商未提供额度接口"})
    for item in provider_store.list_custom_providers():
        raw = provider_store.custom_provider_secret(item["name"])
        used, remaining, source = None, None, "需配置 usage/quota API"
        for url_key, field in (("usage_url", "used"), ("quota_url", "remaining")):
            url = str(raw.get(url_key) or "").strip()
            if not url or not url.startswith(("https://", "http://")):
                continue
            try:
                request = urllib.request.Request(url, headers={"Authorization": f"Bearer {raw.get('api_key', '')}", "Accept": "application/json"})
                with urllib.request.urlopen(request, timeout=4) as response:
                    payload = json.loads(response.read(512_000).decode("utf-8", "replace"))
                value = payload.get(field) if isinstance(payload, dict) else None
                if value is None and isinstance(payload, dict):
                    for key in ("total", "amount", "value", "balance", "remaining", "used"):
                        if key in payload:
                            value = payload[key]
                            break
                if field == "used":
                    used = value
                else:
                    remaining = value
                source = "自定义额度接口"
            except (OSError, ValueError, TypeError, urllib.error.URLError):
                source = "自定义额度接口读取失败"
        items.append({"name": item["name"], "label": item["label"], "configured": item["configured"],
                      "used": used, "remaining": remaining, "unit": "额度", "source": source})
    return {"items": items, "note": "未提供官方用量接口的模型，无法可靠推算余额；不会用猜测值冒充余量。"}

@app.get("/api/integrations/qq-mail", dependencies=[Depends(require_auth)])
def qq_mail_status():
    return email_store.qq_status()

@app.post("/api/integrations/qq-mail/connect", dependencies=[Depends(require_auth)])
def connect_qq_mail(req: QQMailConnectRequest):
    if not req.email.lower().endswith("@qq.com"):
        raise HTTPException(status_code=400, detail="当前连接器只支持 QQ 邮箱地址")
    try:
        result = qq_mail.test_connection(req.email.strip(), req.authorization_code.strip())
    except Exception as exc:
        db.log_event("WARNING", "qq_mail_connection_failed", type(exc).__name__, actor="admin")
        raise HTTPException(status_code=400, detail="QQ 邮箱连接失败：请确认已开启 IMAP/SMTP，并填写最新授权码") from exc
    email_store.save_qq(req.email.strip(), req.authorization_code.strip())
    db.log_event("INFO", "qq_mail_connected", "QQ Mail IMAP authorized", actor="admin")
    return {"ok": True, "message": "QQ 邮箱已连接", "message_count": result["message_count"]}

@app.post("/api/integrations/qq-mail/unread", dependencies=[Depends(require_auth)])
def qq_mail_unread():
    credentials = email_store.qq_credentials()
    if not credentials: raise HTTPException(status_code=400, detail="请先连接 QQ 邮箱")
    try:
        items = qq_mail.unread_headers(*credentials)
    except Exception as exc:
        db.log_event("WARNING", "qq_mail_sync_failed", type(exc).__name__, actor="admin")
        raise HTTPException(status_code=502, detail="读取 QQ 邮箱失败，请检查授权码是否已失效") from exc
    db.log_event("INFO", "qq_mail_unread_synced", f"count={len(items)}", actor="admin")
    return {"items": items}

@app.post("/api/integrations/qq-mail/messages", dependencies=[Depends(require_auth)])
def qq_mail_messages():
    credentials = email_store.qq_credentials()
    if not credentials: raise HTTPException(status_code=400, detail="请先连接 QQ 邮箱")
    try:
        items = qq_mail.inbox_headers(*credentials)
    except Exception as exc:
        db.log_event("WARNING", "qq_mail_inbox_failed", type(exc).__name__, actor="admin")
        raise HTTPException(status_code=502, detail="读取 QQ 邮箱失败，请检查授权码是否已失效") from exc
    return {"items": items}

@app.get("/api/integrations/qq-mail/messages/{message_id}", dependencies=[Depends(require_auth)])
def qq_mail_message_detail(message_id: str):
    credentials = email_store.qq_credentials()
    if not credentials: raise HTTPException(status_code=400, detail="请先连接 QQ 邮箱")
    try:
        return qq_mail.message_detail(*credentials, message_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.log_event("WARNING", "qq_mail_message_failed", type(exc).__name__, actor="admin")
        raise HTTPException(status_code=502, detail="读取邮件正文失败") from exc

@app.post("/api/integrations/qq-mail/mark-read", dependencies=[Depends(require_auth)])
def qq_mail_mark_read(req: MailMarkReadRequest):
    credentials = email_store.qq_credentials()
    if not credentials: raise HTTPException(status_code=400, detail="请先连接 QQ 邮箱")
    try:
        count = qq_mail.mark_read(*credentials, req.ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.log_event("WARNING", "qq_mail_mark_read_failed", type(exc).__name__, actor="admin")
        raise HTTPException(status_code=502, detail="标记已读失败，请稍后重试") from exc
    db.log_event("INFO", "qq_mail_mark_read", f"count={count}", actor="admin")
    return {"ok": True, "message": f"已标记 {count} 封邮件为已读"}

@app.post("/api/session", dependencies=[Depends(require_auth)])
def create_session(request: Request, response: Response):
    """Remember this trusted browser without exposing the admin token to JavaScript."""
    response.set_cookie(
        key=SESSION_COOKIE,
        value=settings.admin_token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        # Local development uses http://127.0.0.1; production HTTPS keeps Secure.
        secure=request.url.scheme == "https",
        samesite="strict",
        # Keep the trusted-browser session shared by agent.xdailab.com and
        # quant.xdailab.com, while leaving localhost cookies host-only.
        domain=".xdailab.com" if request.url.hostname and request.url.hostname.endswith(".xdailab.com") else None,
        path="/",
    )
    return {"ok": True, "expires_in_days": SESSION_DAYS}

@app.delete("/api/session")
def delete_session(request: Request, response: Response):
    # Match the Secure attribute used when creating the cookie. Otherwise an
    # HTTP localhost cookie cannot be removed by a Secure deletion cookie.
    response.delete_cookie(
        key=SESSION_COOKIE,
        path="/",
        secure=request.url.scheme == "https",
        httponly=True,
        samesite="strict",
        domain=".xdailab.com" if request.url.hostname and request.url.hostname.endswith(".xdailab.com") else None,
    )
    return {"ok": True}

@app.post("/api/chat", dependencies=[Depends(require_auth)])
def chat(req: ChatRequest):
    try:
        attachment_context, attachments = attachment_store.context(req.attachment_ids)
        image_data_urls = attachment_store.image_data_urls(req.attachment_ids)
        reply = run_agent(req.message, attachment_context=attachment_context, image_data_urls=image_data_urls, model_selection=req.model)
        return {"reply": reply, "attachments": attachments}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.log_event("ERROR","chat_error",type(exc).__name__)
        raise HTTPException(status_code=503,detail=str(exc)[:500])

@app.post("/api/uploads", dependencies=[Depends(require_auth)])
def upload(req: UploadRequest):
    try:
        item = attachment_store.save(req.filename, req.content_base64)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.log_event("INFO", "attachment_uploaded", f"kind={item['kind']}, bytes={item['bytes']}", actor="admin")
    return item

@app.get("/api/memories", dependencies=[Depends(require_auth)])
def memories(q: str = ""):
    return {"items":db.search_memories(q)}

@app.post("/api/memories", dependencies=[Depends(require_auth)])
def add_memory(req: MemoryRequest):
    mid=db.save_memory(req.content)
    db.log_event("INFO","memory_saved_ui",f"id={mid}")
    return {"ok":True,"id":mid}

@app.get("/api/tasks", dependencies=[Depends(require_auth)])
def tasks(): return {"items":db.list_tasks()}

@app.get("/api/approvals", dependencies=[Depends(require_auth)])
def approvals(): return {"items":db.list_approvals()}

@app.post("/api/approvals/{approval_id}/decision", dependencies=[Depends(require_auth)])
def approval_decision(approval_id: int, req: ApprovalDecision):
    approval = db.get_pending_approval(approval_id)
    if not approval: raise HTTPException(status_code=409,detail="审批不存在或已处理")
    if req.decision == "approve" and approval["action_type"] == "send_qq_mail":
        credentials = email_store.qq_credentials()
        if not credentials: raise HTTPException(status_code=400, detail="QQ 邮箱尚未连接，不能发送")
        payload = approval["payload"]
        try:
            qq_mail.send_message(*credentials, payload["recipient"], payload["subject"], payload["body"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            db.log_event("ERROR", "qq_mail_send_failed", type(exc).__name__, actor="admin")
            raise HTTPException(status_code=502, detail="邮件发送失败；审批仍保留，可检查 QQ 授权码后重试") from exc
        ok=db.decide_approval(approval_id,"approved",req.note,"admin")
        if not ok: raise HTTPException(status_code=409,detail="审批已被处理")
        db.mark_approval_executed(approval_id)
        db.log_event("WARNING","qq_mail_sent",f"approval={approval_id}, recipient={payload['recipient']}",actor="admin")
        return {"ok":True,"message":"邮件已发送"}
    ok=db.decide_approval(approval_id,"approved" if req.decision=="approve" else "rejected",req.note,"admin")
    if not ok: raise HTTPException(status_code=409,detail="审批不存在或已处理")
    db.log_event("WARNING","approval_decided",f"id={approval_id}, decision={req.decision}",actor="admin")
    return {"ok":True,"message":"审批决定已记录。"}

@app.get("/api/logs", dependencies=[Depends(require_auth)])
def logs(): return {"items":db.get_logs()}

@app.post("/api/quant/scan", dependencies=[Depends(require_auth)])
def quant_scan(req: QuantScanRequest):
    try:
        result = market.scan_low_turnover_volume_breakout(**req.model_dump())
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    result = dict(result)
    result["history_id"] = db.save_quant_scan(req.model_dump(), result)
    db.log_event("INFO", "quant_scan", f"matches={result['count']}, universe={result['universe_count']}", actor="admin")
    return result

def _run_quant_job(job_id: str, params: dict):
    with quant_jobs_lock:
        quant_jobs[job_id].update(status="running", started_at=time.time())
    try:
        result = market.scan_low_turnover_volume_breakout(**params)
        result = dict(result)
        result["history_id"] = db.save_quant_scan(params, result)
        with quant_jobs_lock:
            quant_jobs[job_id].update(status="complete", result=result, finished_at=time.time())
        db.log_event("INFO", "quant_scan", f"matches={result['count']}, universe={result['universe_count']}", actor="admin")
    except Exception as exc:
        with quant_jobs_lock:
            quant_jobs[job_id].update(status="failed", error=str(exc)[:500], finished_at=time.time())
        db.log_event("ERROR", "quant_scan_failed", type(exc).__name__, actor="admin")

@app.post("/api/quant/scan/start", dependencies=[Depends(require_auth)])
def quant_scan_start(req: QuantScanRequest):
    params = req.model_dump()
    signature = tuple(sorted((key, value) for key, value in params.items() if key != "force"))
    with quant_jobs_lock:
        for existing_id, job in quant_jobs.items():
            if job.get("signature") == signature and job.get("status") in {"pending", "running"}:
                return {"job_id": existing_id, "status": job["status"], "reused": True}
        job_id = uuid.uuid4().hex
        quant_jobs[job_id] = {"status":"pending", "created_at":time.time(), "signature":signature, "result":None, "error":None}
        completed = sorted((item for item in quant_jobs.items() if item[1]["status"] in {"complete", "failed"}), key=lambda item:item[1].get("finished_at", 0), reverse=True)
        for old_id, _ in completed[20:]:
            quant_jobs.pop(old_id, None)
    threading.Thread(target=_run_quant_job, args=(job_id, params), daemon=True, name=f"quant-{job_id[:8]}").start()
    return {"job_id":job_id, "status":"pending", "reused":False}

@app.get("/api/quant/scan/job/{job_id}", dependencies=[Depends(require_auth)])
def quant_scan_job(job_id: str):
    with quant_jobs_lock:
        job = quant_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="扫描任务不存在或服务已重启")
        now = time.time()
        started = job.get("started_at", job["created_at"])
        return {"job_id":job_id, "status":job["status"], "elapsed_seconds":round(now-started, 1), "result":job.get("result"), "error":job.get("error")}

@app.get("/api/quant/kline/{symbol}", dependencies=[Depends(require_auth)])
def quant_kline(symbol: str, limit: int = 120):
    try:
        return market.get_daily_kline(symbol, limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/intraday/{symbol}", dependencies=[Depends(require_auth)])
def quant_intraday(symbol: str, period: int = 1, limit: int = 240):
    try:
        return market.get_intraday_kline(symbol, period, limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/heatmap", dependencies=[Depends(require_auth)])
def quant_heatmap():
    try:
        return market.market_heatmap()
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/live", dependencies=[Depends(require_auth)])
def quant_live(symbols: str = ""):
    codes = [code.strip() for code in symbols.split(",") if code.strip()] if symbols else None
    if codes and (len(codes) > 300 or any(not code.isdigit() or len(code) != 6 for code in codes)):
        raise HTTPException(status_code=400, detail="股票代码列表不正确")
    try:
        return market.live_snapshot(codes)
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/indexes", dependencies=[Depends(require_auth)])
def quant_indexes():
    try:
        return market.index_snapshot()
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/depth/{symbol}", dependencies=[Depends(require_auth)])
def quant_depth(symbol: str):
    try:
        return market.depth_quote(symbol)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/live-stream", dependencies=[Depends(require_auth)])
def quant_live_stream(symbols: str = "", interval: int = 15):
    codes = [code.strip() for code in symbols.split(",") if code.strip()]
    if not codes or len(codes) > 100 or any(not code.isdigit() or len(code) != 6 for code in codes):
        raise HTTPException(status_code=400, detail="实时推送必须提供 1～100 个六位股票代码")
    interval = max(5, min(int(interval), 60))
    def events():
        while True:
            try:
                payload = market.live_snapshot(codes)
                yield "event: quotes\ndata: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
            except Exception as exc:
                yield "event: error\ndata: " + json.dumps({"detail": str(exc)}, ensure_ascii=False) + "\n\n"
            time.sleep(interval)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.get("/api/quant/layout/{name}", dependencies=[Depends(require_auth)])
def quant_layout_get(name: str):
    layout = db.get_quant_layout(name)
    return layout or {"name": name, "layout": "", "updated_at": None}

@app.put("/api/quant/layout/{name}", dependencies=[Depends(require_auth)])
def quant_layout_put(name: str, req: QuantLayoutRequest):
    db.save_quant_layout(name, req.layout)
    return {"ok": True, "name": name}

@app.get("/api/quant/watchlist", dependencies=[Depends(require_auth)])
def quant_watchlist():
    items = db.list_quant_watch()
    try:
        quotes = market.quote_symbols([item["symbol"] for item in items])
    except market.MarketDataError:
        quotes = {}
    return {"items": [{**item, **quotes.get(item["symbol"], {})} for item in items],
            "source": "腾讯公开行情（非QMT）"}

@app.put("/api/quant/watchlist/{symbol}", dependencies=[Depends(require_auth)])
def quant_watchlist_put(symbol: str, req: QuantWatchRequest):
    if symbol != req.symbol:
        raise HTTPException(status_code=400, detail="路径股票代码与内容不一致")
    db.upsert_quant_watch(req.symbol, req.name, req.sector, req.note)
    return {"ok": True, "symbol": req.symbol}

@app.delete("/api/quant/watchlist/{symbol}", dependencies=[Depends(require_auth)])
def quant_watchlist_delete(symbol: str):
    if not db.delete_quant_watch(symbol):
        raise HTTPException(status_code=404, detail="自选股不存在")
    return {"ok": True}

@app.get("/api/quant/fund-flow", dependencies=[Depends(require_auth)])
def quant_fund_flow():
    try:
        return market.fund_flow_snapshot()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/sentiment", dependencies=[Depends(require_auth)])
def quant_sentiment(refresh: bool = False, scope: str = "all"):
    try:
        current = market.market_sentiment(force=refresh, scope=scope)
        db.save_sentiment_snapshot(current)
        return {"current": current, "history": db.list_sentiment_snapshots()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/holdings", dependencies=[Depends(require_auth)])
def quant_holdings():
    holdings = db.list_quant_holdings()
    try:
        quotes = market.quote_symbols([item["symbol"] for item in holdings])
    except market.MarketDataError:
        quotes = {}
    items = []
    for item in holdings:
        quote = quotes.get(item["symbol"], {})
        price = float(quote.get("price") or 0)
        quantity = int(item["quantity"])
        cost = float(item["cost"])
        profit = (price - cost) * quantity if price and cost else 0
        items.append({**item, **quote, "market_value": round(price * quantity, 2),
                      "profit": round(profit, 2), "profit_pct": round((price / cost - 1) * 100, 2) if price and cost else 0})
    return {
        "items": items,
        "qmt_connected": False,
        "broker_connected": False,
        "notice": "当前持仓由 MyAgent 的手工/截图记录；尚未接入券商账户，不代表实时账户仓位。",
    }


_INITIAL_MONITOR = (
    ("159558.SZ", "半导体设备ETF易方达"),
    ("588080.SH", "科创50ETF易方达"),
    ("159246.SZ", "创业板人工智能ETF富国"),
    ("510210.SH", "上证指数ETF富国"),
    ("000938.SZ", "紫光股份"),
    ("515880.SH", "通信ETF国泰"),
    ("600939.SH", "重庆建工"),
)


def _qualified_symbol(value: str) -> str:
    value = value.strip().upper().replace(".SS", ".SH")
    if re.fullmatch(r"\d{6}", value):
        value += ".SH" if value.startswith(("5", "6")) else ".SZ"
    if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", value):
        raise HTTPException(status_code=400, detail="证券代码格式错误")
    return value


@app.get("/api/quant/portfolio/snapshot", dependencies=[Depends(require_auth)])
def quant_portfolio_snapshot():
    recorded = {_qualified_symbol(row["symbol"]): row for row in db.list_quant_holdings()}
    monitored = dict(_INITIAL_MONITOR)
    for symbol, row in recorded.items():
        monitored.setdefault(symbol, row["name"])
    try:
        market_data = market.get_tickflow_portfolio("portfolio-quotes", {"symbols": ",".join(monitored)})
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    quotes = {row["symbol"]: row for row in market_data.get("items", [])}
    items = []
    for symbol, expected_name in monitored.items():
        quote = quotes.get(symbol, {})
        holding = recorded.get(symbol)
        quantity = int(holding["quantity"]) if holding else None
        cost = float(holding["cost"]) if holding else None
        price = quote.get("price")
        prev = quote.get("prev_close")
        items.append({
            "symbol": symbol, "name": quote.get("name") or expected_name,
            "name_verified": bool(quote.get("name")), "holding_source": holding["source"] if holding else None,
            "quantity": quantity, "available_quantity": holding["available_quantity"] if holding else None,
            "cost": cost, "price": price, "prev_close": prev,
            "change_pct": round((price / prev - 1) * 100, 2) if price and prev else None,
            "high": quote.get("high"), "low": quote.get("low"),
            "volume": quote.get("volume"), "amount": quote.get("amount"),
            "market_value": round(quantity * price, 2) if quantity is not None and price else None,
            "today_pnl_estimate": round(quantity * (price-prev), 2) if quantity is not None and price and prev else None,
            "unrealized_pnl_estimate": round(quantity * (price-cost), 2) if quantity is not None and price and cost else None,
            "market_timestamp": quote.get("timestamp"),
            "board": portfolio_monitor.board_meta(symbol),
        })
    valued = [row for row in items if row["market_value"] is not None]
    account = {
        "source": "未连接券商账户",
        "total_assets": None,
        "cash_available": None,
        "position_ratio": None,
        "market_value_recorded": round(sum(row["market_value"] for row in valued), 2) if valued else None,
        "today_pnl_estimate": round(sum(row["today_pnl_estimate"] or 0 for row in valued), 2) if valued else None,
        "total_pnl_estimate": round(sum(row["unrealized_pnl_estimate"] or 0 for row in valued), 2) if valued else None,
    }
    recorded_items = [row for row in items if row["holding_source"]]
    return {
        "source": market_data.get("source"),
        "items": items,
        "holding_items": recorded_items,
        "recorded_count": len(recorded_items),
        "monitor_count": len(items),
        "account": account,
        # Keep these fields at the top level for the existing frontend contract.
        "account_source": account["source"],
        "account_verified": False,
        "data_status": {
            "broker_connected": False,
            "holdings_source": "myagent_recorded",
            "semantics": "行情可刷新；数量、成本和盈亏只对 MyAgent 已录入持仓计算，不代表券商实时账户。",
        },
        "notice": "默认七只仅作为监控标的；只有已录入到 MyAgent 持仓库的标的才会计算数量、成本和浮盈亏。未接入国金账户时不显示实时账户资产。",
    }


@app.get("/api/quant/terminal/history", dependencies=[Depends(require_auth)])
def quant_terminal_history(trade_date: str):
    try:
        return terminal_ledger.history(trade_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="交易日期格式不正确") from exc


@app.get("/api/quant/terminal/replay", dependencies=[Depends(require_auth)])
def quant_terminal_replay(trade_date: str, hindsight_quantity: int | None = None):
    if hindsight_quantity is not None and not 1 <= hindsight_quantity <= 100_000_000:
        raise HTTPException(status_code=400, detail="理论模拟数量必须在 1 到 100000000 之间")
    try:
        ledger = terminal_ledger.history(trade_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="交易日期格式不正确") from exc
    minute_data = {}
    for symbol in sorted({row["symbol"] for row in ledger["trades"]}):
        try:
            minute_data[symbol] = market.get_tickflow_portfolio(
                "portfolio-minute", {"symbol": symbol, "trade_date": trade_date})
        except market.MarketDataError as exc:
            minute_data[symbol] = {"source": "数据源未取得", "rows": [], "error": str(exc)}
    return terminal_ledger.replay_analysis(ledger, minute_data, hindsight_quantity=hindsight_quantity)


@app.post("/api/quant/terminal/trades", dependencies=[Depends(require_auth)])
def quant_terminal_add_trade(req: QuantTradeUpdate):
    try:
        trade, inserted = terminal_ledger.add_trade(
            trade_date=req.trade_date, trade_time=req.trade_time, symbol=req.symbol,
            side=req.side, quantity=req.quantity, price=req.price,
            source="manual_unverified", external_id=req.external_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.log_event("info", "quant_trade_manual_recorded", f"{trade['trade_date']} {trade['symbol']} {trade['fingerprint'][:12]}")
    return {"trade": trade, "inserted": inserted, "notice": "手工记录，未与券商成交核对"}


@app.get("/api/quant/portfolio/minute/{symbol}", dependencies=[Depends(require_auth)])
def quant_portfolio_minute(symbol: str, trade_date: str | None = None):
    qualified = _qualified_symbol(symbol)
    params = {"symbol": qualified}
    if trade_date:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", trade_date):
            raise HTTPException(status_code=400, detail="日期格式应为 YYYY-MM-DD")
        params["trade_date"] = trade_date
    try:
        return market.get_tickflow_portfolio("portfolio-minute", params)
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/quant/portfolio/minute-batch", dependencies=[Depends(require_auth)])
def quant_portfolio_minute_batch(trade_date: str | None = None):
    if trade_date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", trade_date):
        raise HTTPException(status_code=400, detail="日期格式应为 YYYY-MM-DD")
    monitored = list(dict(_INITIAL_MONITOR))
    for row in db.list_quant_holdings():
        symbol = _qualified_symbol(row["symbol"])
        if symbol not in monitored:
            monitored.append(symbol)
    if len(monitored) > 100:
        raise HTTPException(status_code=400, detail="单次最多 100 个标的")
    params = {"symbols": ",".join(monitored)}
    if trade_date:
        params["trade_date"] = trade_date
    try:
        return market.get_tickflow_portfolio("portfolio-minute-batch", params)
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/quant/portfolio/board/{symbol}", dependencies=[Depends(require_auth)])
def quant_portfolio_board(symbol: str, trade_date: str | None = None):
    if trade_date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", trade_date):
        raise HTTPException(status_code=400, detail="日期格式应为 YYYY-MM-DD")
    try:
        return portfolio_monitor.get_board(_qualified_symbol(symbol), trade_date)
    except (market.MarketDataError, httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="板块行情暂不可用") from exc

@app.get("/api/quant/news", dependencies=[Depends(require_auth)])
def quant_market_news(interval: int = 5):
    return quant_news.headlines(db.list_quant_holdings(), interval)

@app.get("/api/quant/quotes", dependencies=[Depends(require_auth)])
def quant_quotes(symbols: str):
    codes = list(dict.fromkeys(code.strip() for code in symbols.split(",") if code.strip()))
    if not codes or len(codes) > 300 or any(not code.isdigit() or len(code) != 6 for code in codes):
        raise HTTPException(status_code=400, detail="股票代码列表不正确")
    try:
        quotes = market.quote_symbols(codes)
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"items": list(quotes.values()), "source": "腾讯公开行情（非QMT）"}

@app.put("/api/quant/holdings/{symbol}", dependencies=[Depends(require_auth)])
def quant_holding_upsert(symbol: str, req: QuantHoldingUpdate):
    if symbol != req.symbol:
        raise HTTPException(status_code=400, detail="路径股票代码与内容不一致")
    sector = req.sector or sector_for_name(req.name)
    db.upsert_quant_holding(req.symbol, req.name, req.quantity, req.cost, sector, req.available_quantity, req.source)
    return {"ok": True, "symbol": req.symbol, "sector": sector}

@app.delete("/api/quant/holdings/{symbol}", dependencies=[Depends(require_auth)])
def quant_holding_delete(symbol: str):
    if not db.delete_quant_holding(symbol):
        raise HTTPException(status_code=404, detail="持仓不存在")
    return {"ok": True}

@app.get("/api/quant/sector/{sector_name}", dependencies=[Depends(require_auth)])
def quant_sector_stocks(sector_name: str):
    try:
        return market.sector_stocks(sector_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except market.MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/quant/history", dependencies=[Depends(require_auth)])
def quant_history(limit: int = 100):
    return {"items": db.list_quant_scans(limit)}

@app.get("/api/quant/history/{scan_id}", dependencies=[Depends(require_auth)])
def quant_history_detail(scan_id: int):
    item = db.get_quant_scan(scan_id)
    if not item:
        raise HTTPException(status_code=404, detail="历史筛选不存在")
    return item

@app.get("/api/quant/qmt/status", dependencies=[Depends(require_auth)])
def quant_qmt_status():
    return {"connected": False, "mode": "未连接", "message": "安装并运行本地QMT桥接器后，可启用全推快照、1/5/15分钟涨幅和五档盘口。"}

@app.get("/api/quant/tickflow/status", dependencies=[Depends(require_auth)])
def quant_tickflow_status():
    context = market.get_tickflow_context([])
    return {
        "connected": bool(context),
        "source": context.get("source", "TickFlow共享桥接") if context else "未连接",
        "as_of": context.get("as_of") or context.get("generated_at") if context else None,
        "market": context.get("market") if context else None,
        "message": "TickFlow数据已进入统一量化页" if context else "TickFlow桥接暂不可用，页面保留公开行情",
    }

@app.post("/api/quant/ai", dependencies=[Depends(require_auth)])
def quant_ai(req: QuantAIRequest):
    compact_context = str(req.context)[:6000]
    tickflow_context = market.get_tickflow_context([req.symbol])
    compact_tickflow = str(tickflow_context)[:10000]
    prompt = f"""你是A股盘中研究助手。用户正在查看 {req.name}（{req.symbol}）。
当前页面量化上下文：{compact_context}
TickFlow共享实时上下文（如有）：{compact_tickflow}
用户问题：{req.question}

必须遵守：
1. 先说明数据源和时点；公开行情不是交易所直连实时数据。
2. 区分拾贝初筛与进场确认。初筛通过不等于可以买入。
3. 用“观察、等待确认、条件满足/不满足”表达，不承诺收益，不代替用户下单。
4. 若问题涉及做T卖点但上下文没有实时五档盘口、最大卖单或QMT数据，必须明确说无法精准确认，只给条件式判断。
5. 输出简洁：结论、依据、触发条件、失效条件、还缺什么数据。"""
    try:
        attachment_context, attachments = attachment_store.context(req.attachment_ids)
        image_data_urls = attachment_store.image_data_urls(req.attachment_ids)
        return {"reply": run_agent(prompt, attachment_context=attachment_context, image_data_urls=image_data_urls), "attachments": attachments}
    except Exception as exc:
        db.log_event("ERROR", "quant_ai_error", type(exc).__name__, actor="admin")
        raise HTTPException(status_code=503, detail=str(exc)[:500]) from exc

@app.get("/api/quant/sectors", dependencies=[Depends(require_auth)])
def quant_sectors():
    return sector_payload()


@app.get("/api/ai/models", dependencies=[Depends(require_auth)])
def shared_model_options():
    profiles = settings.providers()
    if "shared" not in profiles:
        return {"data": []}
    import urllib.request
    import json
    profile = profiles["shared"]
    request = urllib.request.Request(profile.base_url + "/models", headers={"Authorization": "Bearer " + profile.api_key})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="统一 AI 服务暂不可用，请检查量化端 AI 设置") from exc
