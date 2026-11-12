import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

// Dedicated daily recommendation view (deployment marker: 2026-11-12)

type RecordItem = { symbol: string; name: string; score?: number; price?: number; verdict?: string | null }
type RecordRow = { id: string; date: string; stage: string; createdAt: string; marketEmotion?: string; items: RecordItem[] }

export function RecommendationPage() {
  const [rows, setRows] = useState<RecordRow[]>([])
  const [stage, setStage] = useState('全部')
  const load = () => { try { setRows(JSON.parse(localStorage.getItem('myagent-recommendation-history') || '[]')) } catch { setRows([]) } }
  useEffect(() => { load() }, [])
  const today = new Date().toISOString().slice(0, 10)
  const visible = rows.filter(row => row.date === today && (stage === '全部' || row.stage === stage))
  return <div className="h-full overflow-auto bg-base p-3 text-foreground"><div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4"><div><h1 className="text-base font-semibold">今日推荐</h1><p className="mt-1 text-xs text-muted">集合竞价、盘中推荐和其他时间轮动的独立记录页；每条记录保留当时情绪和模型评分。</p></div><button type="button" onClick={load} className="rounded border border-accent/60 px-3 py-2 text-xs text-accent">刷新记录</button></div><div className="mb-3 flex flex-wrap gap-2">{['全部', '集合竞价', '盘中推荐', '其他时间轮动'].map(value => <button key={value} type="button" onClick={() => setStage(value)} className={`rounded border px-3 py-1.5 text-xs ${stage === value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted'}`}>{value}</button>)}<Link to="/pick-model" className="rounded border border-border px-3 py-1.5 text-xs text-accent">打开拾贝模型</Link></div><div className="space-y-2">{visible.map(row => <section key={row.id} className="rounded-card border border-border bg-surface p-3"><div className="flex flex-wrap items-center justify-between gap-2"><b>{row.stage}</b><span className="text-[11px] text-muted">{row.createdAt.slice(11, 19)} · {row.marketEmotion || '情绪数据缺失'}</span></div><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{row.items.map(item => <Link key={item.symbol} to={`/stock-analysis?symbol=${encodeURIComponent(item.symbol)}&name=${encodeURIComponent(item.name)}`} className="rounded border border-border bg-base/50 p-2 text-xs hover:border-accent"><b>{item.name}</b><span className="ml-2 text-muted">{item.symbol}</span><div className="mt-1 text-accent">拾贝评分 {item.score ?? '—'}</div><div className="mt-1 text-[10px] text-muted">推荐时价格 {item.price ?? '未记录'}</div></Link>)}</div></section>)}{!visible.length && <div className="rounded-card border border-border bg-surface p-10 text-center text-xs text-muted">今天还没有推荐快照。请先在拾贝模型页运行扫描。</div>}</div></div>
}
