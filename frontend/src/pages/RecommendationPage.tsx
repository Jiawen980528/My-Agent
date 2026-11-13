import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

type Item = { symbol: string; name: string; score?: number; price?: number }
type Row = { id: string; date: string; stage: string; createdAt: string; marketEmotion?: string; items: Item[] }
type Quote = { symbol: string; price?: number }
type Auction = { state?: string; trade_date?: string; raw_items?: Array<{ thscode?: string; ticker?: string; name?: string; auction_pct?: number; tags?: string[] }> }

export function RecommendationPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [stage, setStage] = useState('全部')
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [auction, setAuction] = useState<Auction | null>(null)
  const [message, setMessage] = useState('')
  const [paper, setPaper] = useState<{ total?: number; total_pnl?: number; rounds?: number; pending?: number }>({})
  const load = () => {
    fetch('/quant/api/myagent/recommendations', { credentials: 'include' }).then(async r => { if (!r.ok) throw new Error(); const b = await r.json(); setRows(Array.isArray(b.items) ? b.items : []) }).catch(() => { try { setRows(JSON.parse(localStorage.getItem('myagent-recommendation-history') || '[]')) } catch { setRows([]) } })
    fetch('/quant/api/market-recap/auction-benchmark', { credentials: 'include' }).then(async r => r.ok ? r.json() : null).then(setAuction).catch(() => setAuction(null))
    Promise.all([fetch('/quant/api/paper/overview?account=default', { credentials: 'include' }).then(r => r.ok ? r.json() : null), fetch('/quant/api/paper/stats?account=default', { credentials: 'include' }).then(r => r.ok ? r.json() : null), fetch('/quant/api/paper/orders?status=pending&account=default', { credentials: 'include' }).then(r => r.ok ? r.json() : null)]).then(([o, s, p]) => setPaper({ total: o?.total, total_pnl: o?.total_pnl, rounds: s?.rounds, pending: p?.orders?.length ?? 0 })).catch(() => setPaper({}))
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    const refreshAuction = () => {
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      if (mins < 9 * 60 + 15 || mins > 9 * 60 + 25) return
      fetch('/quant/api/market-recap/auction-benchmark', { credentials: 'include' }).then(async r => r.ok ? r.json() : null).then(body => { if (body) setAuction(body) }).catch(() => undefined)
    }
    refreshAuction()
    const timer = window.setInterval(refreshAuction, 5_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => { const symbols = [...new Set(rows.flatMap(r => r.items.map(i => i.symbol)))].join(','); if (!symbols) return; fetch(`/quant/api/myagent/quant/quotes?symbols=${encodeURIComponent(symbols)}`, { credentials: 'include' }).then(r => r.json()).then(b => setQuotes(Object.fromEntries((b.items || []).map((x: Quote) => [x.symbol, x])))).catch(() => setQuotes({})) }, [rows])
  const today = new Date().toLocaleDateString('sv-SE')
  const visible = rows.filter(r => r.date === today && (stage === '全部' || r.stage === stage))
  const tracking = useMemo(() => visible.flatMap(r => r.items.map(item => ({ item, quote: quotes[item.symbol] }))).filter(x => x.item.price && x.quote?.price), [visible, quotes])
  const wins = tracking.filter(x => Number(x.quote!.price) >= Number(x.item.price)).length
  const execute = async (id: string) => { setMessage('正在提交到暗黑模拟盘…'); try { const r = await fetch(`/quant/api/myagent/recommendations/${encodeURIComponent(id)}/paper-execute?account=default`, { method: 'POST', credentials: 'include' }); const b = await r.json(); if (!r.ok) throw new Error(b.detail || `HTTP ${r.status}`); setMessage(`已提交 ${b.orders?.length ?? 0} 笔模拟委托，跳过 ${b.skipped?.length ?? 0} 笔`); load() } catch (e) { setMessage(`模拟执行失败：${e instanceof Error ? e.message : '未知错误'}`) } }
  return <div className="h-full overflow-auto bg-base p-3 text-foreground"><div className="mb-3 flex items-center justify-between rounded-card border border-border bg-surface p-4"><div><h1 className="text-base font-semibold">今日推荐</h1><p className="mt-1 text-xs text-muted">集合竞价、盘中推荐和轮动推荐分开记录；拾贝只作为候选池参考。</p></div><button onClick={load} className="rounded border border-accent/60 px-3 py-2 text-xs text-accent">刷新数据</button></div><section className="mb-3 rounded-card border border-warning/30 bg-warning/5 p-3"><div className="flex justify-between"><b className="text-warning">集合竞价风向标（独立于拾贝）</b><span className="text-[10px] text-muted">{auction?.trade_date || '今日'} · {auction?.state || '读取中'}</span></div>{auction?.state === 'ok' && auction.raw_items?.length ? <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{auction.raw_items.slice(0, 10).map(x => { const s = x.thscode || x.ticker || ''; return <Link key={s || x.name} to={`/stock-analysis?symbol=${encodeURIComponent(s)}`} className="rounded border border-border bg-base/50 p-2 text-xs"><b>{x.name || x.ticker || '未命名'}</b><div className="text-muted">{s || '代码缺失'}</div><div className="text-warning">竞价涨幅 {x.auction_pct == null ? '—' : `${Number(x.auction_pct).toFixed(2)}%`}</div><div className="text-[10px] text-muted">{(x.tags || []).slice(0, 2).join(' · ') || '暂无标签'}</div></Link> })}</div> : <p className="mt-2 text-xs text-secondary">当前没有可核验的竞价名单，未使用拾贝结果替代；请检查竞价数据源配置。</p>}</section><div className="mb-3 flex gap-2">{['全部', '集合竞价', '盘中推荐', '其他时间轮动'].map(v => <button key={v} onClick={() => setStage(v)} className={`rounded border px-3 py-1.5 text-xs ${stage === v ? 'border-accent text-accent' : 'border-border text-muted'}`}>{v}</button>)}<Link to="/pick-model" className="rounded border border-border px-3 py-1.5 text-xs text-accent">打开拾贝模型</Link></div>{message && <div className="mb-3 rounded border border-accent/30 p-2 text-xs text-accent">{message}</div>}<div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6"><div className="rounded border border-border bg-surface p-2 text-xs">今日快照 <b className="text-accent">{visible.length}</b></div><div className="rounded border border-border bg-surface p-2 text-xs">当前价 <b>{tracking.length}</b></div><div className="rounded border border-border bg-surface p-2 text-xs">浮动胜率 <b>{tracking.length ? `${(wins / tracking.length * 100).toFixed(1)}%` : '待取'}</b></div><div className="rounded border border-border bg-surface p-2 text-xs">暗黑盘资产 <b>{paper.total == null ? '未创建' : Number(paper.total).toFixed(2)}</b></div><div className="rounded border border-border bg-surface p-2 text-xs">暗黑盘盈亏 <b>{paper.total_pnl == null ? '—' : Number(paper.total_pnl).toFixed(2)}</b></div><div className="rounded border border-border bg-surface p-2 text-xs">待成交/回合 <b>{paper.pending ?? 0}/{paper.rounds ?? 0}</b></div></div><div className="space-y-2">{visible.map(row => <section key={row.id} className="rounded-card border border-border bg-surface p-3"><div className="flex justify-between"><b>{row.stage}</b><button onClick={() => void execute(row.id)} className="rounded border border-accent/60 px-2 py-1 text-[10px] text-accent">执行到暗黑模拟盘</button></div><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{row.items.map(item => { const q = quotes[item.symbol]; const change = item.price && q?.price ? (Number(q.price) / Number(item.price) - 1) * 100 : null; return <Link key={item.symbol} to={`/stock-analysis?symbol=${encodeURIComponent(item.symbol)}`} className="rounded border border-border p-2 text-xs"><b>{item.name}</b><span className="ml-2 text-muted">{item.symbol}</span><div className="text-accent">拾贝评分 {item.score ?? '—'}</div><div className="text-[10px] text-muted">推荐 {item.price ?? '—'} · 当前 {q?.price ?? '—'}</div><div className={change == null || change >= 0 ? 'text-bull' : 'text-bear'}>{change == null ? '待跟踪' : `浮动 ${change.toFixed(2)}%`}</div></Link> })}</div></section>)}{!visible.length && <div className="rounded-card border border-border p-10 text-center text-xs text-muted">今天还没有拾贝快照；集合竞价请看上方独立风向标。</div>}</div></div>
}
