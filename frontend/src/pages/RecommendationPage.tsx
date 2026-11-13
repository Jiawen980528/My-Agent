import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

// Dedicated daily recommendation view (deployment marker: 2026-11-12)

type RecordItem = { symbol: string; name: string; score?: number; price?: number; verdict?: string | null }
type RecordRow = { id: string; date: string; stage: string; createdAt: string; marketEmotion?: string; items: RecordItem[] }
type Quote = { symbol: string; price?: number; pct?: number }

export function RecommendationPage() {
  const [rows, setRows] = useState<RecordRow[]>([])
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [executeMessage, setExecuteMessage] = useState('')
  const [stage, setStage] = useState('全部')
  const load = () => {
    fetch('/quant/api/myagent/recommendations', { credentials: 'include' }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { items?: RecordRow[] }
      setRows(Array.isArray(body.items) ? body.items : [])
    }).catch(() => {
      try { setRows(JSON.parse(localStorage.getItem('myagent-recommendation-history') || '[]')) } catch { setRows([]) }
    })
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    const symbols = [...new Set(rows.flatMap(row => row.items.map(item => item.symbol)))].join(',')
    if (!symbols) { setQuotes({}); return }
    fetch(`/quant/api/myagent/quant/quotes?symbols=${encodeURIComponent(symbols)}`, { credentials: 'include' }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { items?: Quote[] }
      setQuotes(Object.fromEntries((body.items ?? []).map(item => [item.symbol, item])))
    }).catch(() => setQuotes({}))
  }, [rows])
  const today = new Date().toLocaleDateString('sv-SE')
  const visible = rows.filter(row => row.date === today && (stage === '全部' || row.stage === stage))
  const tracking = useMemo(() => visible.flatMap(row => row.items.map(item => ({ item, quote: quotes[item.symbol] }))).filter(x => Number.isFinite(Number(x.item.price)) && Number.isFinite(Number(x.quote?.price))), [visible, quotes])
  const wins = tracking.filter(x => Number(x.quote!.price) >= Number(x.item.price)).length
  const execute = async (id: string) => { setExecuteMessage('正在提交到暗黑模拟盘…'); try { const response = await fetch(`/quant/api/myagent/recommendations/${encodeURIComponent(id)}/paper-execute?account=default`, { method: 'POST', credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`); setExecuteMessage(`已提交 ${body.orders?.length ?? 0} 笔模拟委托，跳过 ${body.skipped?.length ?? 0} 笔`); } catch (error) { setExecuteMessage(`模拟执行失败：${error instanceof Error ? error.message : '未知错误'}`) } }
  return <div className="h-full overflow-auto bg-base p-3 text-foreground"><div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4"><div><h1 className="text-base font-semibold">今日推荐</h1><p className="mt-1 text-xs text-muted">集合竞价、盘中推荐和其他时间轮动的独立记录页；每条记录保留当时情绪和模型评分。</p></div><button type="button" onClick={load} className="rounded border border-accent/60 px-3 py-2 text-xs text-accent">刷新记录</button></div><div className="mb-3 flex flex-wrap gap-2">{['全部', '集合竞价', '盘中推荐', '其他时间轮动'].map(value => <button key={value} type="button" onClick={() => setStage(value)} className={`rounded border px-3 py-1.5 text-xs ${stage === value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted'}`}>{value}</button>)}<Link to="/pick-model" className="rounded border border-border px-3 py-1.5 text-xs text-accent">打开拾贝模型</Link></div>{executeMessage && <div className="mb-3 rounded border border-accent/30 bg-accent/5 p-2 text-xs text-accent">{executeMessage}</div>}<div className="mb-3 grid gap-2 sm:grid-cols-3"><div className="rounded border border-border bg-surface p-2 text-xs"><span className="text-muted">今日快照</span><b className="ml-2 text-accent">{visible.length} 条</b></div><div className="rounded border border-border bg-surface p-2 text-xs"><span className="text-muted">已取得当前价</span><b className="ml-2">{tracking.length} 只</b></div><div className="rounded border border-border bg-surface p-2 text-xs"><span className="text-muted">当前跟踪胜率</span><b className={wins >= tracking.length / 2 ? 'ml-2 text-bull' : 'ml-2 text-bear'}>{tracking.length ? `${(wins / tracking.length * 100).toFixed(1)}%` : '待取行情'}</b><span className="ml-1 text-[10px] text-muted">未到目标周期，仅作浮动跟踪</span></div></div><div className="space-y-2">{visible.map(row => <section key={row.id} className="rounded-card border border-border bg-surface p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><b>{row.stage}</b><span className="ml-2 text-[11px] text-muted">{row.createdAt.slice(11, 19)} · {row.marketEmotion || '情绪数据缺失'}</span></div><button type="button" onClick={() => void execute(row.id)} className="rounded border border-accent/60 px-2 py-1 text-[10px] text-accent">执行到暗黑模拟盘</button></div><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{row.items.map(item => { const quote = quotes[item.symbol]; const change = item.price && quote?.price ? (Number(quote.price) / Number(item.price) - 1) * 100 : null; return <Link key={item.symbol} to={`/stock-analysis?symbol=${encodeURIComponent(item.symbol)}&name=${encodeURIComponent(item.name)}`} className="rounded border border-border bg-base/50 p-2 text-xs hover:border-accent"><b>{item.name}</b><span className="ml-2 text-muted">{item.symbol}</span><div className="mt-1 text-accent">拾贝评分 {item.score ?? '—'}</div><div className="mt-1 text-[10px] text-muted">推荐 {item.price ?? '未记录'} · 当前 {quote?.price ?? '待取'}</div><div className={`mt-1 text-[10px] ${change == null || change >= 0 ? 'text-bull' : 'text-bear'}`}>{change == null ? '结果待跟踪' : `浮动 ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</div></Link> })}</div></section>)}{!visible.length && <div className="rounded-card border border-border bg-surface p-10 text-center text-xs text-muted">今天还没有推荐快照。请先在拾贝模型页运行扫描。</div>}</div></div>
}
