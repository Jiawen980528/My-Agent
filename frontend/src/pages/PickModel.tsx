import { useEffect, useMemo, useState } from 'react'
import { Search, RefreshCw, BookOpen, AlertTriangle } from 'lucide-react'

type Candidate = {
  symbol: string; name: string; sector?: string; price?: number; pct?: number
  score?: number; priority?: string; entry_status?: string; pattern?: string
  max_turnover?: number; volume_multiple?: number; pre_market_cap_yi?: number
  ma_distance_pct?: number; latest_date?: string
}

type StrongSector = { code: string; name: string; pct?: number | null; net_yi?: number | null }
type ModelSector = { sector: string; theme: string; anchors: string[]; watch: string[] }
type SectorStock = { symbol: string; name: string; sector: string; price?: number; pct?: number; turnover?: number; volume_ratio?: number; market_cap_yi?: number }
type SectorNews = { title: string; url: string; source: string; sector_names?: string[]; bias?: string }

const API = '/quant/api/myagent/quant'

export function PickModel() {
  const [form, setForm] = useState({ baseline_days: 60, max_avg_turnover: 1.5, recent_days: 5, volume_multiple: 2, max_market_cap_yi: 100 })
  const [items, setItems] = useState<Candidate[]>([])
  const [meta, setMeta] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [strongSectors, setStrongSectors] = useState<StrongSector[]>([])
  const [modelSectors, setModelSectors] = useState<ModelSector[]>([])
  const [selectedSector, setSelectedSector] = useState<StrongSector | null>(null)
  const [sectorStocks, setSectorStocks] = useState<SectorStock[]>([])
  const [sectorNews, setSectorNews] = useState<SectorNews[]>([])
  const [sectorLoading, setSectorLoading] = useState(false)
  const [sectorError, setSectorError] = useState('')
  const [aiReplies, setAiReplies] = useState<Record<string, string>>({})
  const [aiLoading, setAiLoading] = useState('')
  const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, { credentials: 'include', ...init })
    const body = await response.json()
    if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`)
    return body as T
  }
  useEffect(() => {
    let active = true
    void Promise.all([
      fetchJson<{ items: StrongSector[] }>(`/quant/api/myagent/fund-flow/sectors?limit=1200`),
      fetchJson<{ items: ModelSector[] }>(`${API}/sectors`),
    ]).then(([ranked, models]) => {
      if (!active) return
      setStrongSectors((ranked.items || []).filter(row => row.pct != null).sort((a, b) => Number(b.pct) - Number(a.pct)).slice(0, 12))
      setModelSectors(models.items || [])
    }).catch(error => { if (active) setSectorError(error instanceof Error ? error.message : '板块读取失败') })
    return () => { active = false }
  }, [])
  const matchedModelSector = useMemo(() => {
    if (!selectedSector) return null
    const name = selectedSector.name
    return modelSectors.find(row => row.sector === name) || modelSectors.find(row => name.includes(row.sector) || row.sector.includes(name)) || null
  }, [modelSectors, selectedSector])
  const selectSector = async (sector: StrongSector) => {
    setSelectedSector(sector); setSectorStocks([]); setAiReplies({}); setSectorError('')
    const model = modelSectors.find(row => row.sector === sector.name) || modelSectors.find(row => sector.name.includes(row.sector) || row.sector.includes(sector.name))
    if (!model) return
    setSectorLoading(true)
    try {
      const [stocks, news] = await Promise.all([
        fetchJson<{ items: SectorStock[] }>(`${API}/sector/${encodeURIComponent(model.sector)}`),
        fetchJson<{ items: SectorNews[] }>(`${API}/news`),
      ])
      setSectorStocks(stocks.items || [])
      setSectorNews((news.items || []).filter(item => item.sector_names?.some(name => name === sector.name || name.includes(sector.name) || sector.name.includes(name))).slice(0, 5))
    } catch (error) { setSectorError(error instanceof Error ? error.message : '候选池读取失败') }
    finally { setSectorLoading(false) }
  }
  const codeOf = (symbol: string) => symbol.replace(/\.(SH|SZ|SS|BJ)$/i, '')
  const recommendations = useMemo(() => {
    if (!matchedModelSector || !sectorStocks.length) return []
    const stockCodes = new Set(sectorStocks.map(stock => codeOf(stock.symbol)))
    return items.filter(item => stockCodes.has(codeOf(item.symbol)) && (item.sector === matchedModelSector.sector || !item.sector))
      .map(item => ({ ...item, sectorQuote: sectorStocks.find(stock => codeOf(stock.symbol) === codeOf(item.symbol)) }))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.pct || 0) - Number(a.pct || 0))
      .slice(0, 8)
  }, [items, matchedModelSector, sectorStocks])
  const analyzeCandidate = async (candidate: Candidate & { sectorQuote?: SectorStock }) => {
    if (aiLoading) return
    setAiLoading(candidate.symbol)
    try {
      const reply = await fetchJson<{ reply: string }>(`${API}/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        symbol: candidate.symbol, name: candidate.name,
        question: '请严格评估这只股票是否值得进入研究清单，不要直接推荐买入。按“结论、拾贝条件、量价关系、板块与新闻、触发条件、失效条件、还缺什么数据”输出；任何数据不足都明确写出。',
        context: { model: '拾贝模型', sector: selectedSector, candidate, sector_quote: candidate.sectorQuote, news: sectorNews, source: '公开行情与项目个股库' },
      }), })
      setAiReplies(current => ({ ...current, [candidate.symbol]: reply.reply }))
    } catch (error) { setAiReplies(current => ({ ...current, [candidate.symbol]: error instanceof Error ? `AI分析失败：${error.message}` : 'AI分析失败' })) }
    finally { setAiLoading('') }
  }
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
    <section className="mb-3 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><b className="text-sm">最近强势板块 → 可核验个股</b><p className="mt-1 text-[11px] text-muted">先按公开板块涨幅选择，再与拾贝扫描结果和项目个股库交集；未通过交集校验的股票不会显示为推荐。</p></div><span className="text-[10px] text-warning">仅研究候选，不自动下单</span></div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">{strongSectors.map(sector => <button key={sector.code} type="button" onClick={() => void selectSector(sector)} className={`rounded border px-2 py-1.5 text-left text-xs ${selectedSector?.code === sector.code ? 'border-accent bg-accent/15' : 'border-border bg-base hover:border-accent/60'}`}><div className="flex items-center justify-between gap-1"><b className="truncate">{sector.name}</b><span className={Number(sector.pct) >= 0 ? 'text-bull' : 'text-bear'}>{sector.pct == null ? '—' : `${Number(sector.pct).toFixed(2)}%`}</span></div><span className="text-[10px] text-muted">{sector.code}</span></button>)}{!strongSectors.length && <p className="text-xs text-muted">板块排行暂不可用，请稍后刷新。</p>}</div>
      {selectedSector && <div className="mt-2 rounded border border-border/70 bg-base/50 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><b>{selectedSector.name}</b><span className="text-muted">公开板块涨幅 {selectedSector.pct == null ? '—' : `${Number(selectedSector.pct).toFixed(2)}%`} · {matchedModelSector ? `拾贝个股库：${matchedModelSector.sector}` : '项目个股库暂无精确板块映射'}</span></div>
        {sectorLoading && <p className="mt-2 text-xs text-accent">正在读取个股库、新闻和量价数据…</p>}
        {sectorError && <p className="mt-2 text-xs text-danger">{sectorError}</p>}
        {!sectorLoading && matchedModelSector && !items.length && <p className="mt-2 text-xs text-warning">请先点击上方“扫描全市场”，没有拾贝扫描结果就不输出个股推荐。</p>}
        {!sectorLoading && matchedModelSector && items.length && !recommendations.length && <p className="mt-2 text-xs text-warning">当前板块没有同时通过“拾贝扫描 + 项目个股库”交集校验的标的，因此不推荐。</p>}
        {!sectorLoading && !matchedModelSector && <p className="mt-2 text-xs text-warning">该强势板块未被项目个股库覆盖，不做跨板块猜测；可换一个板块或补充个股库。</p>}
        {!!recommendations.length && <div className="mt-2 grid gap-1.5 lg:grid-cols-2">{recommendations.map(candidate => <article key={candidate.symbol} className="rounded border border-border bg-surface p-2 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><div><b>{candidate.name}</b><span className="ml-2 text-muted">{candidate.symbol}</span></div><span className="font-semibold text-accent">拾贝评分 {candidate.score ?? '—'}</span></div><div className="mt-1 grid grid-cols-2 gap-1 text-[10px] text-muted sm:grid-cols-4"><span>涨跌 {candidate.pct == null ? '—' : `${candidate.pct.toFixed(2)}%`}</span><span>放量 {candidate.volume_multiple == null ? '—' : `${candidate.volume_multiple}x`}</span><span>量比 {candidate.sectorQuote?.volume_ratio == null ? '—' : candidate.sectorQuote.volume_ratio.toFixed(2)}</span><span>换手 {candidate.sectorQuote?.turnover == null ? '—' : `${candidate.sectorQuote.turnover.toFixed(2)}%`}</span></div><p className="mt-1 text-[10px] text-secondary">筛选依据：拾贝阶段 {candidate.entry_status || '—'} · 量价形态 {candidate.pattern || '—'} · 板块 {selectedSector.name} · 新闻 {sectorNews.length ? '有可核对条目' : '暂无可核对条目'}</p><button type="button" onClick={() => void analyzeCandidate(candidate)} disabled={aiLoading === candidate.symbol} className="mt-1 rounded border border-accent/50 px-2 py-1 text-[10px] text-accent disabled:opacity-50">{aiLoading === candidate.symbol ? 'AI分析中…' : 'AI量化复核'}</button>{aiReplies[candidate.symbol] && <p className="mt-1 rounded bg-accent/5 p-1.5 text-[10px] leading-relaxed text-secondary"><b className="text-accent">AI：</b>{aiReplies[candidate.symbol]}</p>}</article>)}</div>}
      </div>}
    </section>
    <div className="mb-2 flex items-center justify-between text-xs text-muted"><span>候选 {meta?.count ?? items.length} 只 · 全市场样本 {meta?.universe_count ?? '—'} · {meta?.data_source ?? '尚未扫描'}</span><label className="flex items-center gap-1"><Search className="h-3.5 w-3.5" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索代码 / 名称 / 板块" className="h-7 w-48 rounded border border-border bg-elevated px-2 text-xs text-foreground" /></label></div>
    <div className="overflow-auto rounded-card border border-border bg-surface"><table className="w-full min-w-[980px] text-xs"><thead className="bg-elevated text-muted"><tr>{['股票 / 板块','现价','涨跌','评分','优先级','模型阶段','放量倍数','最高换手','放量前市值','均线距离','形态'].map(x => <th key={x} className="whitespace-nowrap px-3 py-2 text-left font-medium">{x}</th>)}</tr></thead><tbody>{filtered.map(x => <tr key={x.symbol} className="border-t border-border/60 hover:bg-elevated"><td className="px-3 py-2"><b>{x.name}</b><small className="ml-2 text-muted">{x.symbol} · {x.sector || '其他'}</small></td><td className="px-3 py-2">{Number(x.price || 0).toFixed(2)}</td><td className={Number(x.pct) >= 0 ? 'px-3 py-2 text-bull' : 'px-3 py-2 text-bear'}>{Number(x.pct || 0).toFixed(2)}%</td><td className="px-3 py-2 font-semibold text-accent">{x.score ?? '—'}</td><td className="px-3 py-2">{x.priority || '—'}</td><td className="px-3 py-2">{x.entry_status || '—'}</td><td className="px-3 py-2">{x.volume_multiple ? `${x.volume_multiple}x` : '—'}</td><td className="px-3 py-2">{x.max_turnover ?? '—'}%</td><td className="px-3 py-2">{x.pre_market_cap_yi ?? '—'}亿</td><td className="px-3 py-2">{x.ma_distance_pct ?? '—'}%</td><td className="px-3 py-2">{x.pattern || '—'}</td></tr>)}</tbody></table>{!loading && !filtered.length && <div className="p-10 text-center text-xs text-muted">点击“扫描全市场”获取拾贝模型候选</div>}</div>
  </div>
}
