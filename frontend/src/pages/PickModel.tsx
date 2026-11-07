import { useState } from 'react'
import { Search, RefreshCw, BookOpen, AlertTriangle } from 'lucide-react'

type Candidate = {
  symbol: string; name: string; sector?: string; price?: number; pct?: number
  score?: number; priority?: string; entry_status?: string; pattern?: string
  max_turnover?: number; volume_multiple?: number; pre_market_cap_yi?: number
  ma_distance_pct?: number; latest_date?: string
}

const API = '/quant/api/myagent/quant'

export function PickModel() {
  const [form, setForm] = useState({ baseline_days: 60, max_avg_turnover: 1.5, recent_days: 5, volume_multiple: 2, max_market_cap_yi: 100 })
  const [items, setItems] = useState<Candidate[]>([])
  const [meta, setMeta] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const scan = async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch(`${API}/scan`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, force: true }) })
      const d = await r.json(); if (!r.ok) throw new Error(d.detail || '扫描失败')
      setItems(d.items || []); setMeta(d)
    } catch (e) { setError(e instanceof Error ? e.message : '扫描失败') } finally { setLoading(false) }
  }
  const filtered = items.filter(x => !query || `${x.symbol}${x.name}${x.sector || ''}`.includes(query))
  return <div className="h-full overflow-auto bg-base p-3">
    <div className="mb-3 flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-3">
      <div><div className="flex items-center gap-2 text-sm font-semibold"><BookOpen className="h-4 w-4 text-accent" />拾贝模型 · 地量异动候选</div><p className="mt-1 text-[11px] text-muted">长期低成交量 → 连续低换手 → 最近数日放量异动 → 回踩确认。结果是研究候选，不是自动买入指令。</p></div>
      <button onClick={scan} disabled={loading} className="inline-flex items-center gap-1 rounded-btn bg-accent px-3 py-2 text-xs text-white disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{loading ? '扫描中…' : '扫描全市场'}</button>
    </div>
    <div className="mb-3 grid grid-cols-2 gap-2 rounded-card border border-border bg-surface p-3 md:grid-cols-5">
      {([['baseline_days','长期地量天数'],['max_avg_turnover','每日换手上限%'],['recent_days','异动窗口天数'],['volume_multiple','放量倍数'],['max_market_cap_yi','放量前市值上限亿']] as const).map(([k,label]) => <label key={k} className="grid gap-1 text-[11px] text-muted">{label}<input type="number" value={form[k]} onChange={e => setForm({...form, [k]: Number(e.target.value)})} className="h-8 rounded border border-border bg-elevated px-2 text-xs text-foreground" /></label>)}
    </div>
    {error && <div className="mb-3 flex items-center gap-2 rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger"><AlertTriangle className="h-4 w-4" />{error}</div>}
    <div className="mb-2 flex items-center justify-between text-xs text-muted"><span>候选 {meta?.count ?? items.length} 只 · 全市场样本 {meta?.universe_count ?? '—'} · {meta?.data_source ?? '尚未扫描'}</span><label className="flex items-center gap-1"><Search className="h-3.5 w-3.5" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索代码 / 名称 / 板块" className="h-7 w-48 rounded border border-border bg-elevated px-2 text-xs text-foreground" /></label></div>
    <div className="overflow-auto rounded-card border border-border bg-surface"><table className="w-full min-w-[980px] text-xs"><thead className="bg-elevated text-muted"><tr>{['股票 / 板块','现价','涨跌','评分','优先级','模型阶段','放量倍数','最高换手','放量前市值','均线距离','形态'].map(x => <th key={x} className="whitespace-nowrap px-3 py-2 text-left font-medium">{x}</th>)}</tr></thead><tbody>{filtered.map(x => <tr key={x.symbol} className="border-t border-border/60 hover:bg-elevated"><td className="px-3 py-2"><b>{x.name}</b><small className="ml-2 text-muted">{x.symbol} · {x.sector || '其他'}</small></td><td className="px-3 py-2">{Number(x.price || 0).toFixed(2)}</td><td className={Number(x.pct) >= 0 ? 'px-3 py-2 text-bull' : 'px-3 py-2 text-bear'}>{Number(x.pct || 0).toFixed(2)}%</td><td className="px-3 py-2 font-semibold text-accent">{x.score ?? '—'}</td><td className="px-3 py-2">{x.priority || '—'}</td><td className="px-3 py-2">{x.entry_status || '—'}</td><td className="px-3 py-2">{x.volume_multiple ? `${x.volume_multiple}x` : '—'}</td><td className="px-3 py-2">{x.max_turnover ?? '—'}%</td><td className="px-3 py-2">{x.pre_market_cap_yi ?? '—'}亿</td><td className="px-3 py-2">{x.ma_distance_pct ?? '—'}%</td><td className="px-3 py-2">{x.pattern || '—'}</td></tr>)}</tbody></table>{!loading && !filtered.length && <div className="p-10 text-center text-xs text-muted">点击“扫描全市场”获取拾贝模型候选</div>}</div>
  </div>
}
