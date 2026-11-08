"""SQLite repository. UTC is stored internally; user scheduling timezone is recorded."""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from .config import settings

def utc_now(): return datetime.now(timezone.utc).replace(microsecond=0).isoformat()
def _connect():
    Path(settings.database_path).parent.mkdir(parents=True, exist_ok=True)
    c=sqlite3.connect(settings.database_path, check_same_thread=False); c.row_factory=sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA foreign_keys=ON"); return c
@contextmanager
def session():
    c=_connect()
    try: yield c; c.commit()
    finally: c.close()

def init_db():
    with session() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')), content TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'one_time', run_at_utc TEXT, schedule_expr TEXT, timezone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, payload TEXT NOT NULL DEFAULT '{}', last_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, action_type TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', idempotency_key TEXT NOT NULL UNIQUE, requester TEXT NOT NULL DEFAULT 'agent', created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, decision_note TEXT, executed_at TEXT);
        CREATE TABLE IF NOT EXISTS tool_calls(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, tool_name TEXT NOT NULL, arguments TEXT NOT NULL, result TEXT, status TEXT NOT NULL, risk TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT);
        CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, event TEXT NOT NULL, details TEXT, task_id INTEGER, actor TEXT NOT NULL DEFAULT 'system', created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS finance_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, amount_cents INTEGER NOT NULL, category TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS market_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, provider TEXT NOT NULL, payload TEXT NOT NULL, captured_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS quant_scan_runs(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model_name TEXT NOT NULL DEFAULT '拾贝模型',
            criteria TEXT NOT NULL,
            result TEXT NOT NULL,
            match_count INTEGER NOT NULL DEFAULT 0,
            generated_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quant_holdings(
            symbol TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 0,
            available_quantity INTEGER NOT NULL DEFAULT 0,
            cost REAL NOT NULL DEFAULT 0,
            sector TEXT NOT NULL DEFAULT '待绑定',
            source TEXT NOT NULL DEFAULT 'manual',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS market_sentiment_snapshots(
            trade_date TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            captured_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quant_layouts(
            name TEXT PRIMARY KEY,
            layout TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quant_watchlist(
            symbol TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sector TEXT NOT NULL DEFAULT '待绑定',
            note TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quant_news_items(
            url TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source TEXT NOT NULL,
            published_at TEXT NOT NULL,
            fetched_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quant_news_published ON quant_news_items(published_at DESC);
        CREATE TABLE IF NOT EXISTS quant_trade_events(
            fingerprint TEXT PRIMARY KEY,
            trade_date TEXT NOT NULL,
            trade_time TEXT NOT NULL,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('buy','sell')),
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            price TEXT NOT NULL,
            commission TEXT NOT NULL,
            source TEXT NOT NULL,
            verified INTEGER NOT NULL DEFAULT 0,
            external_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quant_trades_day ON quant_trade_events(trade_date,symbol,trade_time);
        CREATE TABLE IF NOT EXISTS quant_account_history(
            snapshot_date TEXT PRIMARY KEY,
            total_assets TEXT,
            position_value TEXT,
            cash_available TEXT,
            total_pnl TEXT,
            day_pnl TEXT,
            source TEXT NOT NULL,
            verified INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quant_holding_history(
            snapshot_date TEXT NOT NULL,
            symbol TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            source TEXT NOT NULL,
            verified INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            PRIMARY KEY(snapshot_date,symbol)
        );
        """)
        c.execute("INSERT OR IGNORE INTO schema_migrations VALUES(1,?)", (utc_now(),))
        c.execute("INSERT OR IGNORE INTO schema_migrations VALUES(2,?)", (utc_now(),))

def log_event(level,event,details="",task_id=None,actor="system"):
    with session() as c: c.execute("INSERT INTO audit_logs(level,event,details,task_id,actor,created_at) VALUES(?,?,?,?,?,?)",(level,event,str(details)[:4000],task_id,actor,utc_now()))
def save_memory(content,source="user"):
    now=utc_now()
    with session() as c:
        cur=c.execute("INSERT INTO memories(content,source,created_at,updated_at) VALUES(?,?,?,?)",(content[:4000],source,now,now)); return cur.lastrowid
def search_memories(query="",limit=10):
    with session() as c:
        if query.strip(): rows=c.execute("SELECT * FROM memories WHERE content LIKE ? ORDER BY updated_at DESC LIMIT ?",(f"%{query[:100]}%",limit)).fetchall()
        else: rows=c.execute("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?",(limit,)).fetchall()
        return [dict(r) for r in rows]
def save_conversation(role,content):
    with session() as c:
        c.execute("INSERT INTO conversations(role,content,created_at) VALUES(?,?,?)",(role,content[:12000],utc_now()))
        c.execute("DELETE FROM conversations WHERE id NOT IN (SELECT id FROM conversations ORDER BY id DESC LIMIT 500)")
def recent_conversation(limit=12):
    with session() as c:
        rows=c.execute("SELECT role,content FROM conversations ORDER BY id DESC LIMIT ?",(limit,)).fetchall(); return [dict(r) for r in reversed(rows)]
def create_task(title,run_at_utc,timezone_name,payload=None,kind="one_time",schedule_expr=None):
    now=utc_now()
    with session() as c:
        cur=c.execute("INSERT INTO tasks(title,kind,run_at_utc,schedule_expr,timezone,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(title[:200],kind,run_at_utc,schedule_expr,timezone_name,json.dumps(payload or {},ensure_ascii=False),now,now)); return cur.lastrowid
def list_tasks():
    with session() as c: return [dict(r) for r in c.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT 100").fetchall()]
def due_tasks(now):
    with session() as c: return [dict(r) for r in c.execute("SELECT * FROM tasks WHERE status='pending' AND run_at_utc IS NOT NULL AND run_at_utc<=?",(now,)).fetchall()]
def finish_task(task_id,result,status="done"):
    with session() as c: c.execute("UPDATE tasks SET status=?,last_result=?,attempts=attempts+1,updated_at=? WHERE id=?",(status,str(result)[:4000],utc_now(),task_id))
def restore_incomplete_tasks():
    with session() as c: c.execute("UPDATE tasks SET status='pending',updated_at=? WHERE status='running'",(utc_now(),))
def create_approval(action_type,target,payload,risk,idempotency_key,requester="agent"):
    with session() as c:
        cur=c.execute("INSERT INTO approvals(action_type,target,payload,risk,idempotency_key,requester,created_at) VALUES(?,?,?,?,?,?,?)",(action_type[:100],target[:500],json.dumps(payload,ensure_ascii=False),risk,idempotency_key,requester,utc_now())); return cur.lastrowid
def list_approvals():
    with session() as c:
        return [{**dict(r),"payload":json.loads(r["payload"])} for r in c.execute("SELECT * FROM approvals ORDER BY id DESC LIMIT 100").fetchall()]
def get_pending_approval(approval_id):
    with session() as c:
        row=c.execute("SELECT * FROM approvals WHERE id=? AND status='pending'",(approval_id,)).fetchone()
        return ({**dict(row),"payload":json.loads(row["payload"])} if row else None)
def decide_approval(approval_id,status,note,actor):
    with session() as c:
        cur=c.execute("UPDATE approvals SET status=?,decided_at=?,decided_by=?,decision_note=? WHERE id=? AND status='pending'",(status,utc_now(),actor[:100],note[:1000],approval_id)); return cur.rowcount==1
def mark_approval_executed(approval_id):
    with session() as c:
        c.execute("UPDATE approvals SET executed_at=? WHERE id=? AND status='approved'",(utc_now(),approval_id))
def record_tool_start(task_id,name,arguments,risk):
    with session() as c:
        cur=c.execute("INSERT INTO tool_calls(task_id,tool_name,arguments,status,risk,started_at) VALUES(?,?,?,?,?,?)",(task_id,name,json.dumps(arguments,ensure_ascii=False),"running",risk,utc_now())); return cur.lastrowid
def record_tool_finish(call_id,result,status="success",error_code=None):
    with session() as c: c.execute("UPDATE tool_calls SET result=?,status=?,finished_at=?,error_code=? WHERE id=?",(json.dumps(result,ensure_ascii=False,default=str)[:8000],status,utc_now(),error_code,call_id))
def get_logs(limit=100):
    with session() as c: return [dict(r) for r in c.execute("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?",(limit,)).fetchall()]

def save_quant_scan(criteria, result, model_name="拾贝模型"):
    now=utc_now()
    with session() as c:
        cur=c.execute(
            "INSERT INTO quant_scan_runs(model_name,criteria,result,match_count,generated_at,created_at) VALUES(?,?,?,?,?,?)",
            (model_name[:100],json.dumps(criteria,ensure_ascii=False,default=str),json.dumps(result,ensure_ascii=False,default=str),int(result.get("count",0)),result.get("generated_at"),now),
        )
        return cur.lastrowid

def list_quant_scans(limit=100):
    with session() as c:
        rows=c.execute("SELECT id,model_name,criteria,match_count,generated_at,created_at FROM quant_scan_runs ORDER BY id DESC LIMIT ?",(max(1,min(int(limit),500)),)).fetchall()
        return [{**dict(r),"criteria":json.loads(r["criteria"])} for r in rows]

def get_quant_scan(scan_id):
    with session() as c:
        row=c.execute("SELECT * FROM quant_scan_runs WHERE id=?",(scan_id,)).fetchone()
        return ({**dict(row),"criteria":json.loads(row["criteria"]),"result":json.loads(row["result"])} if row else None)

def upsert_quant_holding(symbol,name,quantity,cost,sector,available_quantity=None,source="manual"):
    now=utc_now(); available=quantity if available_quantity is None else available_quantity
    with session() as c:
        c.execute("""INSERT INTO quant_holdings(symbol,name,quantity,available_quantity,cost,sector,source,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET name=excluded.name,quantity=excluded.quantity,
        available_quantity=excluded.available_quantity,cost=excluded.cost,sector=excluded.sector,source=excluded.source,updated_at=excluded.updated_at""",
        (symbol,name,int(quantity),int(available),float(cost),sector,source,now))

def list_quant_holdings():
    with session() as c: return [dict(r) for r in c.execute("SELECT * FROM quant_holdings ORDER BY updated_at DESC").fetchall()]

def delete_quant_holding(symbol):
    with session() as c: return c.execute("DELETE FROM quant_holdings WHERE symbol=?",(symbol,)).rowcount==1

def save_sentiment_snapshot(payload):
    trade_date=str(payload.get("trade_date") or "")[:10]
    if not trade_date: return
    with session() as c:
        c.execute("""INSERT INTO market_sentiment_snapshots(trade_date,payload,captured_at) VALUES(?,?,?)
        ON CONFLICT(trade_date) DO UPDATE SET payload=excluded.payload,captured_at=excluded.captured_at""",
        (trade_date,json.dumps(payload,ensure_ascii=False,default=str),utc_now()))

def list_sentiment_snapshots(limit=120):
    with session() as c:
        rows=c.execute("SELECT payload FROM market_sentiment_snapshots ORDER BY trade_date DESC LIMIT ?",(max(1,min(int(limit),500)),)).fetchall()
        return [json.loads(r["payload"]) for r in reversed(rows)]

def save_quant_layout(name, layout):
    with session() as c:
        c.execute("""INSERT INTO quant_layouts(name,layout,updated_at) VALUES(?,?,?)
        ON CONFLICT(name) DO UPDATE SET layout=excluded.layout,updated_at=excluded.updated_at""",
        (str(name)[:80], str(layout)[:500000], utc_now()))

def get_quant_layout(name):
    with session() as c:
        row=c.execute("SELECT name,layout,updated_at FROM quant_layouts WHERE name=?",(str(name)[:80],)).fetchone()
        return dict(row) if row else None

def upsert_quant_watch(symbol, name, sector='待绑定', note=''):
    with session() as c:
        c.execute("""INSERT INTO quant_watchlist(symbol,name,sector,note,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(symbol) DO UPDATE SET name=excluded.name,sector=excluded.sector,note=excluded.note,updated_at=excluded.updated_at""",
        (str(symbol), str(name)[:80], str(sector or '待绑定')[:80], str(note or '')[:500], utc_now()))

def list_quant_watch():
    with session() as c: return [dict(r) for r in c.execute("SELECT * FROM quant_watchlist ORDER BY updated_at DESC").fetchall()]

def delete_quant_watch(symbol):
    with session() as c: return c.execute("DELETE FROM quant_watchlist WHERE symbol=?",(str(symbol),)).rowcount==1
