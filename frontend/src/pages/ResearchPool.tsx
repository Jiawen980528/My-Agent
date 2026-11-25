import { useEffect, useState } from 'react'

const API = '/quant/api/myagent/quant/research-pool'
type Item = { symbol: string; name: string; theme?: string; sub_theme?: string; role?: string; logic?: string; evidence_source?: string; focus_level?: string; updated_at?: string }
const empty: Item = { symbol: '', name: '', theme: '', sub_theme: '', role: '观察', logic: '', evidence_source: '', focus_level: '普通' }

async function read<T>(response: Response): Promise<T> {
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || `请求失败 ${response.status}`)
  return body as T
}

export function ResearchPool() {
  const [items, setItems] = useState<Item[]>([])
  const [draft, setDraft] = useState<Item>(empty)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = async (q = query) => {
    setBusy(true); setError('')
    try { const body = await read<{ items: Item[] }>(await fetch(`${API}?query=${encodeURIComponent(q)}`, { credentials: 'include' })); setItems(body.items || []) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '股票池读取失败') }
    finally { setBusy(false) }
  }
  useEffect(() => { void load('') }, [])
  const save = async () => {
    if (!/^\d{6}$/.test(draft.symbol) || !draft.name.trim()) { setError('请输入六位股票代码和名称'); return }
    setBusy(true); setError('')
    try { await read(await fetch(API, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, name: draft.name.trim() }) })); setDraft(empty); await load('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { setBusy(false) }
  }
  const remove = async (symbol: string) => {
    if (!window.confirm(`从研究股票池移除 ${symbol}？`)) return
    setBusy(true); setError('')
    try { await read(await fetch(`${API}/${symbol}`, { method: 'DELETE', credentials: 'include' })); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败') }
    finally { setBusy(false) }
  }
  const set = (key: keyof Item, value: string) => setDraft(current => ({ ...current, [key]: value }))
  return <div className="h-full overflow-auto bg-base p-3 text-foreground">
    <header className="mb-3 rounded-card border border-border bg-surface p-3"><h1 className="text-base font-semibold">我的股票池</h1><p className="mt-1 text-xs text-muted">手工研究标签，只用于候选重合、题材和证据标记；不会限制全市场扫描，也不会写入真实持仓。</p></header>
    <section className="mb-3 rounded-card border border-border bg-surface p-3">
      <div className="mb-2 text-xs font-semibold">添加 / 修改研究标的</div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {([['symbol','代码'],['name','名称'],['theme','题材'],['sub_theme','细分方向']] as const).map(([key,label]) => <label key={key} className="grid gap-1 text-[11px] text-muted">{label}<input value={draft[key] || ''} onChange={e => set(key, e.target.value)} placeholder={key === 'symbol' ? '如 688798' : ''} className="h-8 rounded border border-border bg-base px-2 text-xs text-foreground" /></label>)}
        <label className="grid gap-1 text-[11px] text-muted">角色<select value={draft.role} onChange={e => set('role', e.target.value)} className="h-8 rounded border border-border bg-base px-2 text-xs text-foreground">{['龙头','跟随','观察'].map(x => <option key={x}>{x}</option>)}</select></label>
        <label className="grid gap-1 text-[11px] text-muted">关注级别<select value={draft.focus_level} onChange={e => set('focus_level', e.target.value)} className="h-8 rounded border border-border bg-base px-2 text-xs text-foreground">{['重点','普通','暂缓'].map(x => <option key={x}>{x}</option>)}</select></label>
        <label className="grid gap-1 text-[11px] text-muted sm:col-span-2">逻辑 / 备注<input value={draft.logic || ''} onChange={e => set('logic', e.target.value)} className="h-8 rounded border border-border bg-base px-2 text-xs text-foreground" /></label>
        <label className="grid gap-1 text-[11px] text-muted sm:col-span-2">证据来源<input value={draft.evidence_source || ''} onChange={e => set('evidence_source', e.target.value)} placeholder="文档、公告或链接说明" className="h-8 rounded border border-border bg-base px-2 text-xs text-foreground" /></label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void save()} className="rounded-btn bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">保存到股票池</button><button type="button" onClick={() => setDraft(empty)} className="rounded-btn border border-border px-3 py-1.5 text-xs text-muted">清空</button></div>
    </section>
    <section className="rounded-card border border-border bg-surface p-3"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><b className="text-xs">研究池列表 · {items.length} 只</b><div className="flex gap-2"><input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void load() }} placeholder="搜索代码、名称、题材" className="h-8 w-48 rounded border border-border bg-base px-2 text-xs" /><button type="button" onClick={() => void load()} className="rounded border border-border px-2 text-xs text-accent">搜索</button></div></div>{error && <p className="mb-2 rounded border border-danger/40 bg-danger/5 p-2 text-xs text-danger">{error}</p>}{busy && <p className="mb-2 text-xs text-muted">处理中…</p>}<div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{items.map(item => <article key={item.symbol} className="rounded border border-border/70 bg-base/40 p-3 text-xs"><div className="flex items-start justify-between gap-2"><div><b>{item.name}</b><span className="ml-2 font-mono text-muted">{item.symbol}</span></div><span className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] text-accent">{item.focus_level || '普通'}</span></div><div className="mt-2 text-muted">{item.theme || '未标注题材'}{item.sub_theme ? ` · ${item.sub_theme}` : ''} · {item.role || '观察'}</div>{item.logic && <p className="mt-2 leading-5">{item.logic}</p>}{item.evidence_source && <p className="mt-1 truncate text-[10px] text-muted" title={item.evidence_source}>证据：{item.evidence_source}</p>}<div className="mt-2 flex justify-end"><button type="button" onClick={() => void remove(item.symbol)} className="text-[11px] text-danger hover:underline">移除</button></div></article>)}{!items.length && !busy && <p className="col-span-full p-8 text-center text-xs text-muted">暂无研究股票池标的</p>}</div></section>
  </div>
}
