import { useEffect, useMemo, useState } from 'react'
import { Search, RefreshCw, BookOpen, AlertTriangle, Upload, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type MyAgentResearchPool, type MyAgentResearchPoolItem, type PaperAccountSummary } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

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
type PoolItem = MyAgentResearchPoolItem
type PoolData = MyAgentResearchPool

const API = '/quant/api/myagent/quant'

export function PickModel() {
  const market = useQuery({ queryKey: QK.overviewMarket(), queryFn: () => api.overviewMarket(),
    refetchInterval: query => query.state.data?.quote_status?.is_trading_hours === false ? 60_000 : 5_000, staleTime: 3_000 })
  const conceptRotation = useQuery({ queryKey: QK.sectorRotation('concept', undefined, 1),
    queryFn: () => api.sectorRotation({ kind: 'concept', bucket: 1 }), refetchInterval: 30_000, staleTime: 20_000 })
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
  const [pool, setPool] = useState<PoolData>({ items: [], sources: [] })
  const [poolBusy, setPoolBusy] = useState(false)
  const [poolMessage, setPoolMessage] = useState('')
  const [allNews, setAllNews] = useState<SectorNews[]>([])
  const [paperAccounts, setPaperAccounts] = useState<PaperAccountSummary[]>([])
  const [paperCandidate, setPaperCandidate] = useState<Candidate | null>(null)
  const [paperAccount, setPaperAccount] = useState('')
  const [paperQty, setPaperQty] = useState(100)
  const [paperBusy, setPaperBusy] = useState(false)
  const [paperMessage, setPaperMessage] = useState('')
  const [focusFilter, setFocusFilter] = useState<'全部' | '创新药' | '物理AI' | '其他'>('全部')
  const activeSectors = useMemo(() => {
    const rotation = conceptRotation.data
    if (rotation?.status === 'ok' && rotation.date === market.data?.as_of?.slice(0, 10)) {
      return [...rotation.sectors].filter(row => row.pct_now != null)
        .sort((a, b) => Number(b.pct_now) - Number(a.pct_now))
        .slice(0, 12).map(row => ({ code: row.name, name: row.name, pct: Number(row.pct_now) * 100 }))
    }
    return strongSectors
  }, [conceptRotation.data, market.data?.as_of, strongSectors])
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
  useEffect(() => {
    let active = true
    void Promise.allSettled([
      api.myagentResearchPool(),
      fetchJson<{ items: SectorNews[] }>(`${API}/news`),
      api.paperAccounts(),
    ]).then(([poolResult, newsResult, accountResult]) => {
      if (!active) return
      if (poolResult.status === 'fulfilled') setPool(poolResult.value)
      else setPoolMessage('资料股票池暂不可用，请稍后重试。')
      if (newsResult.status === 'fulfilled') setAllNews(newsResult.value.items || [])
      if (accountResult.status === 'fulfilled') {
        const accounts = accountResult.value.accounts.filter(account => account.status === 'active')
        setPaperAccounts(accounts)
        setPaperAccount(accounts[0]?.id ?? '')
      }
    })
    const newsTimer = window.setInterval(() => {
      void fetchJson<{ items: SectorNews[] }>(`${API}/news`).then(result => {
        if (active) setAllNews(result.items || [])
      }).catch(() => {})
    }, 180_000)
    return () => { active = false; window.clearInterval(newsTimer) }
  }, [])
  const importPool = async (files: FileList | null) => {
    if (!files?.length) return
    setPoolBusy(true); setPoolMessage('')
    try {
      for (const file of Array.from(files)) {
        await api.myagentResearchPoolImport(file)
      }
      const result = await api.myagentResearchPool()
      setPool(result)
      setPoolMessage(`已导入 ${result.items.length} 条产业链 / 板块观察记录。`)
    } catch (error) {
      setPoolMessage(error instanceof Error ? `导入失败：${error.message}` : '导入失败')
      void api.myagentResearchPool().then(setPool).catch(() => {})
    }
    finally { setPoolBusy(false) }
  }
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
        question: '请按课堂拾贝规则核对长期地量、低换手、四种资金异动、回踩15/45日均线和7日观察期；结合当前大盘、板块与新闻，分开列出已验证与缺失的数据。最后只给“继续观察/等待买点/可考虑模拟买入”之一及触发和失效条件；旧课程的点位预测不能当作今日事实。不要给真实账户下单指令。',
        context: { model: '拾贝模型', sector: candidate.sectorQuote ? selectedSector : matchedStrongSector(candidate), candidate, sector_quote: candidate.sectorQuote,
          market: market.data ? { as_of: market.data.as_of, breadth: market.data.breadth, amount: market.data.amount,
            indices: market.data.indices, quote_status: market.data.quote_status } : null,
          news: matchedNews(candidate),
          research_pool: pool.items.filter(item => item.symbol && codeOf(item.symbol) === codeOf(candidate.symbol)),
          source: '公开行情、用户资料股票池与拾贝扫描' },
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
  const poolByCode = useMemo(() => {
    const map = new Map<string, PoolItem[]>()
    for (const row of pool.items) {
      if (!row.symbol) continue
      const code = codeOf(row.symbol)
      map.set(code, [...(map.get(code) || []), row])
    }
    return map
  }, [pool.items])
  const shortlist = useMemo(() => items.filter(item => {
    const rows = poolByCode.get(codeOf(item.symbol)) || []
    if (!rows.length) return false
    const isFocus = rows.some(row => row.theme.includes('创新药') || row.theme.includes('物理AI') || row.theme.includes('机器人'))
    return focusFilter === '全部' || (focusFilter === '其他' ? !isFocus : rows.some(row =>
      row.theme.includes(focusFilter) || (focusFilter === '物理AI' && row.theme.includes('机器人'))))
  }).sort((a, b) => Number(b.score ?? -1) - Number(a.score ?? -1) || Number(b.volume_multiple ?? 0) - Number(a.volume_multiple ?? 0))
    .slice(0, 5), [items, poolByCode, focusFilter])
  const matchedNews = (candidate: Candidate) => {
    const poolRows = poolByCode.get(codeOf(candidate.symbol)) || []
    const terms = [candidate.sector, ...poolRows.map(row => row.theme), ...poolRows.map(row => row.segment)].filter(Boolean) as string[]
    return allNews.filter(news => news.sector_names?.some(sector => terms.some(term => sector.includes(term) || term.includes(sector)))).slice(0, 3)
  }
  const matchedStrongSector = (candidate: Candidate) => {
    const terms = [candidate.sector, ...(poolByCode.get(codeOf(candidate.symbol)) || []).flatMap(row => [row.theme, row.segment])].filter(Boolean) as string[]
    return activeSectors.find(sector => terms.some(term => term.length >= 2 && (sector.name.includes(term) || term.includes(sector.name))))
  }
  const submitPaperBuy = async () => {
    if (!paperCandidate || !paperAccount || !Number.isInteger(paperQty) || paperQty < 100 || paperQty % 100 !== 0) {
      setPaperMessage('请选择模拟账户，并输入 100 股的整数倍。'); return
    }
    setPaperBusy(true); setPaperMessage('')
    try {
      const result = await api.paperOrderCreate({ symbol: paperCandidate.symbol, side: 'buy', qty: paperQty, order_type: 'market' }, paperAccount)
      setPaperMessage(`${paperCandidate.name}模拟买入委托已提交（${result.order.status}）。成交后可在模拟盘查看持仓。`)
      setPaperCandidate(null)
    } catch (error) { setPaperMessage(error instanceof Error ? error.message : '模拟下单失败') }
    finally { setPaperBusy(false) }
  }
  const filtered = items.filter(x => !query || `${x.symbol}${x.name}${x.sector || ''}`.includes(query))
  return <div className="h-full overflow-auto bg-base p-3">
    <div className="mb-3 flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-3">
      <div><div className="flex items-center gap-2 text-sm font-semibold"><BookOpen className="h-4 w-4 text-accent" />拾贝模型 · 地量异动候选</div><p className="mt-1 text-[11px] text-muted">长期低成交量 → 连续低换手 → 最近数日放量异动 → 回踩确认。结果是研究候选，不是自动买入指令。</p></div>
      <button onClick={scan} disabled={loading} className="inline-flex items-center gap-1 rounded-btn bg-accent px-3 py-2 text-xs text-white disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{loading ? '扫描中…' : '扫描全市场'}</button>
    </div>
    <section className="mb-3 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><b className="text-sm">资料股票池 × 拾贝扫描 · 待观察</b><p className="mt-1 text-[11px] text-muted">创新药、物理 AI 优先核对，也保留其他板块；只展示资料与扫描交集，按模型评分排序。新闻和板块是旁证，不能代替买点确认。</p></div><div className="flex items-center gap-2"><label className="inline-flex cursor-pointer items-center gap-1 rounded border border-accent/50 px-2 py-1 text-[11px] text-accent"><Upload className="h-3.5 w-3.5" />{poolBusy ? '导入中…' : '导入资料表'}<input type="file" multiple accept=".xlsx" className="hidden" disabled={poolBusy} onChange={event => { void importPool(event.target.files); event.target.value = '' }} /></label><Link to="/paper" className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-secondary"><Wallet className="h-3.5 w-3.5" />模拟盘</Link></div></div>
      <div className="mt-2 text-[10px] text-muted">已存 {pool.items.length} 条资料记录 · {new Set(pool.items.filter(item => item.symbol).map(item => codeOf(item.symbol!))).size} 只已识别股票 · {pool.items.filter(item => !item.symbol).length} 条待匹配代码 · 资料日期：{Array.from(new Set(pool.items.map(item => item.source_date).filter(Boolean))).join(' / ') || '未注明'} · 大盘快照：{market.data?.as_of || '不可用'}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">{(['全部', '创新药', '物理AI', '其他'] as const).map(value => <button key={value} type="button" onClick={() => setFocusFilter(value)} className={`rounded border px-2 py-1 ${focusFilter === value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted'}`}>{value}</button>)}<span className="ml-1 text-muted">按模型评分排序，每次最多显示 5 只</span></div>
      {pool.items.some(item => !item.symbol) && <details className="mt-2 text-[10px] text-muted"><summary className="cursor-pointer">查看待匹配代码的股票名称</summary><div className="mt-1 max-h-24 overflow-auto">{pool.items.filter(item => !item.symbol).slice(0, 100).map((item, index) => <span key={`${item.name}-${index}`} className="mr-2 inline-block">{item.name}（{item.theme}）</span>)}</div></details>}
      {poolMessage && <p className="mt-1 text-[11px] text-accent">{poolMessage}</p>}
      {!pool.items.length && <p className="mt-2 text-xs text-warning">先导入“创新药与物理AI产业链”表，以及课程压缩包中的“A股主流板块中军与辨识度补漏表”；资料保存在私有用户数据目录。</p>}
      {!!pool.items.length && !items.length && <p className="mt-2 text-xs text-muted">资料已就绪。点击“扫描全市场”后，才会从真实模型结果中筛出观察候选。</p>}
      {!!pool.items.length && !!items.length && !shortlist.length && <p className="mt-2 text-xs text-warning">当前筛选范围内没有同时通过资料池与拾贝扫描的股票，暂不输出个股。可切换方向或检查代码匹配情况。</p>}
      {!!shortlist.length && <div className="mt-2 grid gap-2 lg:grid-cols-2 xl:grid-cols-3">{shortlist.map(candidate => {
        const references = poolByCode.get(codeOf(candidate.symbol)) || []
        const sector = matchedStrongSector(candidate)
        const news = matchedNews(candidate)
        return <article key={candidate.symbol} className="rounded border border-border bg-base/60 p-2 text-xs"><div className="flex items-center justify-between gap-2"><b>{candidate.name} <span className="font-normal text-muted">{candidate.symbol}</span></b><span className="font-mono text-accent">拾贝 {candidate.score ?? '—'}</span></div><p className="mt-1 text-[10px] text-secondary">{Array.from(new Set(references.map(row => `${row.theme} / ${row.segment || row.role}`))).slice(0, 3).join(' · ')}</p><div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-muted"><span>模型：{candidate.entry_status || candidate.pattern || '待核'}</span><span>放量：{candidate.volume_multiple ?? '—'}×</span><span>板块：{sector ? `${sector.name} ${Number(sector.pct ?? 0).toFixed(2)}%` : '未匹配当日强势榜'}</span><span>新闻：{news.length ? `${news.length} 条关联` : '无已关联条目'}</span><span>行情日：{candidate.latest_date || '未知'}</span></div><p className="mt-1 text-[10px] text-muted">资料依据：{references[0]?.rationale || '待核对'}（{references[0]?.source_date || '日期未知'}）</p><div className="mt-2 flex flex-wrap gap-1"><button type="button" onClick={() => void analyzeCandidate(candidate)} disabled={aiLoading === candidate.symbol} className="rounded border border-accent/50 px-2 py-1 text-[10px] text-accent disabled:opacity-50">{aiLoading === candidate.symbol ? 'AI复核中…' : 'AI量化复核'}</button><button type="button" onClick={() => { setPaperCandidate(candidate); setPaperMessage('') }} disabled={!aiReplies[candidate.symbol] || aiReplies[candidate.symbol].startsWith('AI分析失败')} title="先完成 AI 量化复核" className="rounded border border-border px-2 py-1 text-[10px] text-secondary disabled:opacity-40">模拟买入…</button><Link to={`/stock-analysis?symbol=${encodeURIComponent(candidate.symbol)}`} className="rounded border border-border px-2 py-1 text-[10px] text-secondary">看走势</Link></div>{aiReplies[candidate.symbol] && <p className="mt-2 rounded bg-elevated p-2 text-[10px] leading-relaxed text-secondary">{aiReplies[candidate.symbol]}</p>}</article>
      })}</div>}
      {paperMessage && <p className="mt-2 text-[11px] text-accent">{paperMessage} <Link to="/paper" className="underline">查看模拟盘</Link></p>}
    </section>
    {paperCandidate && <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-sm rounded-card border border-border bg-surface p-4 text-xs"><b>模拟买入 · {paperCandidate.name}</b><p className="mt-2 text-muted">仅向虚拟账户提交委托。最新扫描日 {paperCandidate.latest_date || '未知'}；请先核对现价和 AI 复核结果。</p><label className="mt-3 grid gap-1">模拟账户<select value={paperAccount} onChange={event => setPaperAccount(event.target.value)} className="h-8 rounded border border-border bg-base px-2">{paperAccounts.map(account => <option key={account.id} value={account.id}>{account.name || account.id}</option>)}</select></label><label className="mt-3 grid gap-1">股数（100 股整数倍）<input type="number" min={100} step={100} value={paperQty} onChange={event => setPaperQty(Number(event.target.value))} className="h-8 rounded border border-border bg-base px-2" /></label>{!paperAccounts.length && <p className="mt-2 text-warning">还没有可用模拟账户。请先到模拟盘创建账户。</p>}{paperMessage && <p className="mt-2 text-danger">{paperMessage}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setPaperCandidate(null)} className="rounded border border-border px-3 py-1.5">取消</button><button type="button" onClick={() => void submitPaperBuy()} disabled={paperBusy || !paperAccount} className="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-50">{paperBusy ? '提交中…' : '确认模拟买入'}</button></div></div></div>}
    <div className="mb-3 grid grid-cols-2 gap-2 rounded-card border border-border bg-surface p-3 md:grid-cols-5">
      {([['baseline_days','长期地量天数'],['max_avg_turnover','每日换手上限%'],['recent_days','异动窗口天数'],['volume_multiple','放量倍数'],['max_market_cap_yi','放量前市值上限亿']] as const).map(([k,label]) => <label key={k} className="grid gap-1 text-[11px] text-muted">{label}<input type="number" value={form[k]} onChange={e => setForm({...form, [k]: Number(e.target.value)})} className="h-8 rounded border border-border bg-elevated px-2 text-xs text-foreground" /></label>)}
    </div>
    {error && <div className="mb-3 flex items-center gap-2 rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger"><AlertTriangle className="h-4 w-4" />{error}</div>}
    <section className="mb-3 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><b className="text-sm">最近强势板块 → 可核验个股</b><p className="mt-1 text-[11px] text-muted">先按公开板块涨幅选择，再与拾贝扫描结果和项目个股库交集；未通过交集校验的股票不会显示为推荐。</p></div><span className="text-[10px] text-warning">仅研究候选，不自动下单</span></div>
      <div className="mt-1 text-[10px] text-muted">{conceptRotation.data?.status === 'ok' && conceptRotation.data.date === market.data?.as_of?.slice(0, 10) ? `板块分钟轮动 ${conceptRotation.data.as_of || conceptRotation.data.date} · 约30秒更新` : '公开板块目录（可能延迟，暂无同日分钟轮动）'}</div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">{activeSectors.map(sector => <button key={sector.code} type="button" onClick={() => void selectSector(sector)} className={`rounded border px-2 py-1.5 text-left text-xs ${selectedSector?.code === sector.code ? 'border-accent bg-accent/15' : 'border-border bg-base hover:border-accent/60'}`}><div className="flex items-center justify-between gap-1"><b className="truncate">{sector.name}</b><span className={Number(sector.pct) >= 0 ? 'text-bull' : 'text-bear'}>{sector.pct == null ? '—' : `${Number(sector.pct).toFixed(2)}%`}</span></div><span className="text-[10px] text-muted">{sector.code}</span></button>)}{!activeSectors.length && <p className="text-xs text-muted">板块排行暂不可用，请稍后刷新。</p>}</div>
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
