import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

const API = '/quant/api/myagent/quant'
type Scan = { id: number; model_name: string; match_count: number; generated_at: string; criteria: Record<string, unknown> }
type Holding = { symbol: string; name: string; sector: string; quantity: number; cost: number; price?: number; profit?: number; profit_pct?: number }
type Sector = { sector: string; theme: string; anchors: string[]; watch: string[] }
type Tab = 'history' | 'holdings' | 'sectors' | 'guide'
function ManualHoldingForm({ visible, onSaved }: { visible: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({ symbol: '', name: '', quantity: '', cost: '', sector: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  if (!visible) return null
  async function save() {
    const symbol = form.symbol.trim().toUpperCase()
    const quantity = Number(form.quantity)
    const cost = Number(form.cost)
    if (!/^\d{6}(\.(SH|SZ|BJ|SS))?$/.test(symbol) || !form.name.trim() || !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(cost) || cost < 0) { setMessage('请填写正确的代码、名称、数量和成本'); return }
    setSaving(true); setMessage('')
    try {
      const code = symbol.slice(0, 6)
      const r = await fetch(`${API}/holdings/${code}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, name: form.name.trim(), quantity, cost, sector: form.sector.trim(), source: 'manual' }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw Error(d.detail || `保存失败 ${r.status}`)
      setForm({ symbol: '', name: '', quantity: '', cost: '', sector: '' }); setMessage('已保存到 MyAgent 持仓'); onSaved()
    } catch (e) { setMessage((e as Error).message) } finally { setSaving(false) }
  }
  return <div className="mb-3 rounded-card border border-accent/30 bg-accent/5 p-3"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><b className="text-sm">手动维护 MyAgent 持仓</b><span className="text-[11px] text-muted">数量和成本只保存到 MyAgent，不连接券商</span></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5"><input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value })} placeholder="代码，如 159995" className="rounded border border-border bg-base px-2 py-1.5 text-xs" /><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="名称" className="rounded border border-border bg-base px-2 py-1.5 text-xs" /><input value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} placeholder="持仓数量" type="number" min="0" className="rounded border border-border bg-base px-2 py-1.5 text-xs" /><input value={form.cost} onChange={e => setForm({ ...form, cost: e.target.value })} placeholder="持仓成本" type="number" min="0" step="0.001" className="rounded border border-border bg-base px-2 py-1.5 text-xs" /><input value={form.sector} onChange={e => setForm({ ...form, sector: e.target.value })} placeholder="板块（可选）" className="rounded border border-border bg-base px-2 py-1.5 text-xs" /></div><div className="mt-2 flex items-center gap-2"><button type="button" disabled={saving} onClick={() => void save()} className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">{saving ? '保存中…' : '保存持仓'}</button>{message && <span className="text-xs text-secondary">{message}</span>}</div></div>
}
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { credentials: 'include' })
  const d = await r.json()
  if (!r.ok) throw Error(d.detail || `请求失败 ${r.status}`)
  return d
}

export function MyAgentQuant() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab') as Tab | null
  const [tab, setTab] = useState<Tab>(requestedTab === 'history' ? 'history' : 'holdings')
  const [history, setHistory] = useState<Scan[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [sectors, setSectors] = useState<Sector[]>([])
  const [sector, setSector] = useState('')
  const [members, setMembers] = useState<any[]>([])
  const [holdingSource, setHoldingSource] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    setError(''); setBusy(true)
    const work = tab === 'history' ? get<{items: Scan[]}>('/history').then(d => setHistory(d.items))
      : tab === 'holdings' ? get<{items: Holding[]; source?: string}>('/holdings').then(async ledger => {
        // 手动维护的真实持仓底账是唯一优先级；行情快照只能补价格，绝不能覆盖数量/成本。
        if (ledger.items?.length) {
          setHoldingSource(ledger.source || 'MyAgent真实持仓底账（手动维护）')
          setHoldings(ledger.items)
          return
        }
        const snapshot = await get<{items: any[]; source?: string}>('/portfolio/snapshot')
        const verified = (snapshot.items || []).filter(x => x.holding_source || Number(x.quantity || 0) > 0)
        setHoldingSource(snapshot.source || 'MyAgent持仓快照（底账尚未录入）')
        setHoldings(verified.map(x => ({ symbol: x.symbol, name: x.name, sector: x.board?.name || '', quantity: Number(x.quantity || 0), cost: Number(x.cost || 0), price: x.price, profit: x.pnl, profit_pct: x.pnl != null && x.cost && x.quantity ? Number((x.pnl / (x.cost * x.quantity) * 100).toFixed(2)) : undefined })))
      })
      : tab === 'sectors' ? get<{items: Sector[]}>('/sectors').then(d => setSectors(d.items))
      : Promise.resolve()
    work.catch(e => setError(e.message)).finally(() => setBusy(false))
  }, [tab, reloadKey])
  useEffect(() => {
    if (requestedTab === 'holdings' && tab !== 'holdings') setTab('holdings')
  }, [requestedTab, tab])
  async function openScan(id: number) { try { setError(''); setSelected(await get<any>(`/history/${id}`)) } catch (e) { setError((e as Error).message) } }
  async function openSector(name: string) { try { setError(''); setSector(name); const d = await get<{items: any[]}>(`/sector/${encodeURIComponent(name)}`); setMembers(d.items) } catch (e) { setError((e as Error).message) } }
  return <div className="h-full overflow-auto bg-base p-3 text-foreground">
    <ManualHoldingForm visible={tab === 'holdings'} onSaved={() => setReloadKey(v => v + 1)} />
    <div className="mb-3 rounded-card border border-border bg-surface p-3"><h1 className="text-base font-semibold">MyAgent 量化</h1><p className="mt-1 text-xs text-muted">筛选记录、持仓、项目板块库和研究规则，直接在 TickFlow 内查看。行情使用各自标注的数据源。</p></div>
    <nav className="mb-3 flex flex-wrap gap-2">{([['history','筛选历史'],['holdings','持仓跟踪'],['sectors','板块库'],['guide','模型说明']] as const).map(([key,label]) => <button key={key} onClick={() => { setTab(key); setSearchParams(key === 'holdings' ? { tab: 'holdings' } : {}) }} className={`rounded-btn border px-3 py-1.5 text-xs ${tab === key ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-surface text-muted'}`}>{label}</button>)}<Link to="/pick-model" className="rounded-btn border border-border bg-surface px-3 py-1.5 text-xs text-accent">打开拾贝模型</Link><Link to="/fund-flow" className="rounded-btn border border-border bg-surface px-3 py-1.5 text-xs text-accent">查看资金流向</Link></nav>
    {error && <p className="mb-3 rounded border border-danger/40 p-2 text-xs text-danger">{error}</p>}{busy && <p className="text-xs text-muted">加载中…</p>}
    {tab === 'history' && <><div className="grid gap-2 md:grid-cols-2">{history.map(x => <button key={x.id} onClick={() => openScan(x.id)} className="rounded-card border border-border bg-surface p-3 text-left hover:border-accent"><b>{x.model_name}</b><span className="ml-3 text-accent">{x.match_count} 只</span><div className="mt-1 text-xs text-muted">{x.generated_at} · 地量 {String(x.criteria.baseline_days || '—')} 日 · 换手 ≤ {String(x.criteria.max_avg_turnover || '—')}%</div></button>)}</div>{!history.length && !busy && <p className="text-xs text-muted">暂无历史记录；在拾贝模型运行扫描后会自动保存。</p>}{selected && <section className="mt-3 rounded-card border border-border bg-surface p-3"><div className="mb-2 flex justify-between"><b>历史结果 #{selected.id} · {selected.match_count} 只</b><button onClick={() => setSelected(null)}>关闭</button></div><div className="max-h-80 overflow-auto text-xs">{(selected.result?.items || []).map((x: any) => <div key={x.symbol} className="flex gap-4 border-t border-border p-2"><span className="w-32">{x.name} {x.symbol}</span><span>{x.entry_status}</span><span>评分 {x.score}</span><span>{x.latest_date}</span></div>)}</div></section>}</>}
    {tab === 'holdings' && <><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted">数据源：{holdingSource || '读取中'}。这里只显示 MyAgent 已保存或账户快照明确标记的持仓，不会把券商截图或自选股当成真实持仓。</p><button type="button" onClick={() => setTab('holdings')} className="rounded border border-border px-2 py-1 text-[11px] text-accent">刷新</button></div><div className="grid gap-2 md:grid-cols-2">{holdings.map(x => <div key={x.symbol} className="rounded-card border border-border bg-surface p-3"><b>{x.name} <span className="text-muted">{x.symbol}</span></b><div className="mt-2 grid grid-cols-2 gap-2 text-xs"><span>板块 {x.sector || '待绑定'}</span><span>数量 {x.quantity}</span><span>成本 {x.cost}</span><span>现价 {x.price ?? '—'}</span><span>浮盈亏 {x.profit ?? '—'}</span><span>收益率 {x.profit_pct ?? '—'}%</span></div></div>)}</div>{!holdings.length && !busy && <div className="rounded-card border border-warning/30 bg-warning/5 p-4 text-xs text-secondary"><b className="text-warning">当前没有可显示的持仓</b><p className="mt-1">券商账户不会自动同步到这里。请先在 MyAgent 持仓库录入数量和成本，或配置账户只读数据源；录入后点击“刷新”即可看到持仓分析。</p><div className="mt-2 flex gap-2"><Link to="/decision-guide" className="rounded border border-border px-2 py-1 text-accent">查看持仓分析</Link><Link to="/watchlist" className="rounded border border-border px-2 py-1 text-accent">查看自选</Link></div></div>}</>}
    {tab === 'sectors' && <><div className="grid gap-2 md:grid-cols-3">{sectors.map(x => <button key={x.sector} onClick={() => openSector(x.sector)} className="rounded-card border border-border bg-surface p-3 text-left hover:border-accent"><b>{x.sector}</b><p className="text-xs text-muted">{x.theme}</p><p className="mt-2 text-xs">中军：{x.anchors.join('、')}</p><p className="mt-1 text-xs text-muted">观察：{x.watch.slice(0,5).join('、')}</p></button>)}</div>{sector && <section className="mt-3 rounded-card border border-border bg-surface p-3"><b>{sector} · 个股行情</b><div className="mt-2 grid gap-1 md:grid-cols-4">{members.map(x => <div key={x.symbol} className="border border-border p-2 text-xs">{x.name} {x.symbol}<span className="ml-2">{x.price} / {x.pct}%</span></div>)}</div></section>}</>}
    {tab === 'guide' && <div className="grid gap-3 md:grid-cols-2">{[
      ['拾贝初筛','长期地量；这段时间每个交易日的换手率都低于上限；放量前总市值低于上限。长期低量不强制阴跌，放量不作为初筛硬门槛。'],
      ['异动和回踩','打开候选后核查最近数日放量、形态、MA15/MA45、回踩缩量及小 K 线。A/B/C 是研究优先级，不代表可以买入。'],
      ['持仓做 T','先看板块联动和个股跟随；卖点结合分时均线与卖盘压力。没有可靠五档和账户同步时，仅提供条件式观察。'],
      ['数据说明','公开行情可能延迟，筛选历史按扫描时点保存。实时成交、盘口和账户持仓需由已连接的数据源提供。'],
    ].map(([title,body]) => <article key={title} className="rounded-card border border-border bg-surface p-4"><h2 className="mb-2 font-semibold">{title}</h2><p className="text-xs leading-6 text-muted">{body}</p></article>)}</div>}
  </div>
}
