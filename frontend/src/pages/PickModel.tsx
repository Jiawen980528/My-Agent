import { useEffect, useMemo, useState } from 'react'
import { Search, RefreshCw, BookOpen, AlertTriangle, Upload, Wallet, Activity } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MyAgentResearchPool, type MyAgentResearchPoolItem, type PaperAccountSummary } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { EChartsIntraday } from '@/components/EChartsIntraday'

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
type CandidateQuote = { symbol: string; name?: string; price?: number; previous_close?: number; pct?: number; turnover?: number; volume_ratio?: number }
type ScanResult = { items: Candidate[]; count: number; universe_count?: number; data_source?: string; generated_at?: string }
type ScanJob = { status: 'pending' | 'running' | 'complete' | 'failed'; elapsed_seconds?: number; result?: ScanResult | null; error?: string | null }
type RecommendationStage = '全部' | '集合竞价' | '盘中推荐' | '其他时间轮动'
type Cycle = '全部' | '短线' | '中线' | '长线'
const SCAN_JOB_KEY = 'myagent-pick-model-scan-job'

function savedScanJob(): string {
  try { return sessionStorage.getItem(SCAN_JOB_KEY) || '' } catch { return '' }
}

function aiVerdict(reply: string | undefined): '继续观察' | '等待买点' | '可考虑模拟买入' | null {
  const match = reply?.replace(/\*\*/g, '').match(/(?:^|\n)\s*结论[：:]\s*(继续观察|等待买点|可考虑模拟买入)/)
  return match ? match[1] as '继续观察' | '等待买点' | '可考虑模拟买入' : null
}

function SectorTrend({ values, buckets }: { values: (number | null)[]; buckets: string[] }) {
  const points = values.map((value, index) => value == null ? null : { x: index, y: value * 100 }).filter((point): point is { x: number; y: number } => point !== null)
  if (points.length < 2) return <div className="flex h-24 items-center justify-center text-xs text-muted">暂无对应板块分钟走势</div>
  const min = Math.min(...points.map(point => point.y))
  const max = Math.max(...points.map(point => point.y))
  const span = Math.max(max - min, 0.2)
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${(point.x / Math.max(1, values.length - 1) * 600).toFixed(1)},${(105 - (point.y - min) / span * 90).toFixed(1)}`).join(' ')
  return <div><svg viewBox="0 0 600 120" preserveAspectRatio="none" className="h-24 w-full" role="img" aria-label="板块分钟涨跌幅走势"><path d={path} fill="none" stroke="#f59e0b" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg><div className="flex justify-between text-[10px] text-muted"><span>{buckets[0] || '开盘'}</span><span>最新 {points.at(-1)!.y.toFixed(2)}%</span><span>{buckets.at(-1) || '最新'}</span></div></div>
}

const API = '/quant/api/myagent/quant'

export function PickModel() {
  const queryClient = useQueryClient()
  const market = useQuery({ queryKey: QK.overviewMarket(), queryFn: () => api.overviewMarket(),
    refetchInterval: query => query.state.data?.quote_status?.is_trading_hours === false ? 60_000 : 5_000, staleTime: 3_000 })
  const portfolio = useQuery({ queryKey: ['myagent', 'portfolio-snapshot'], queryFn: () => typeof (api as any).portfolioSnapshot === 'function' ? api.portfolioSnapshot() : Promise.resolve({ items: [], source: 'unavailable' }), refetchInterval: 10_000, staleTime: 5_000 })
  const conceptRotation = useQuery({ queryKey: QK.sectorRotation('concept', undefined, 1),
    queryFn: () => api.sectorRotation({ kind: 'concept', bucket: 1 }), refetchInterval: 30_000, staleTime: 20_000 })
  const [form, setForm] = useState({ baseline_days: 60, max_avg_turnover: 1.5, recent_days: 5, volume_multiple: 2, max_market_cap_yi: 100 })
  const [items, setItems] = useState<Candidate[]>([])
  const [meta, setMeta] = useState<any>(null)
  const [loading, setLoading] = useState(() => !!savedScanJob())
  const [scanJobId, setScanJobId] = useState(savedScanJob)
  const [hasScanResult, setHasScanResult] = useState(false)
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
  const [aiReviewBasis, setAiReviewBasis] = useState<Record<string, { quotePrice: number; scanDate: string; reviewedAt: number }>>({})
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
  const [recommendationStage, setRecommendationStage] = useState<RecommendationStage>('全部')
  const [cycleFilter, setCycleFilter] = useState<Cycle>('全部')
  const [focusSymbol, setFocusSymbol] = useState<string | null>(null)
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
  const scanJob = useQuery({
    queryKey: QK.pickModelScanJob(scanJobId),
    queryFn: () => fetchJson<ScanJob>(`${API}/scan/job/${encodeURIComponent(scanJobId)}`),
    enabled: !!scanJobId,
    refetchInterval: query => query.state.data?.status === 'complete' || query.state.data?.status === 'failed' ? false : 3_000,
    retry: false,
  })
  const scanHistory = useQuery({
    queryKey: QK.pickModelHistory,
    queryFn: async () => {
      const list = await fetchJson<{ items: { id: number }[] }>(`${API}/history?limit=1`)
      if (!list.items?.length) return null
      const detail = await fetchJson<{ result: ScanResult }>(`${API}/history/${list.items[0].id}`)
      return detail.result
    },
    staleTime: 60_000,
    retry: false,
  })
  useEffect(() => {
    if (loading || hasScanResult || !scanHistory.data) return
    setItems(scanHistory.data.items ?? [])
    setMeta(scanHistory.data)
    setHasScanResult(true)
  }, [hasScanResult, loading, scanHistory.data])
  useEffect(() => {
    if (!scanJobId) return
    if (scanJob.isError) {
      setError(scanJob.error instanceof Error ? scanJob.error.message : '扫描状态读取失败')
      setLoading(false); setScanJobId('')
    } else if (scanJob.data?.status === 'complete') {
      setItems(scanJob.data.result?.items ?? [])
      setMeta(scanJob.data.result ?? null)
      setPoolMessage(current => current.replace('正在运行拾贝扫描', '拾贝扫描已完成'))
      queryClient.setQueryData(QK.pickModelHistory, scanJob.data.result ?? null)
      setHasScanResult(true)
      setLoading(false); setScanJobId('')
    } else if (scanJob.data?.status === 'failed') {
      setError(scanJob.data.error || '扫描失败')
      setPoolMessage(current => current.replace('正在运行拾贝扫描', '拾贝扫描失败'))
      setLoading(false); setScanJobId('')
    }
  }, [queryClient, scanJob.data, scanJob.error, scanJob.isError, scanJobId])
  useEffect(() => {
    try {
      if (scanJobId) sessionStorage.setItem(SCAN_JOB_KEY, scanJobId)
      else sessionStorage.removeItem(SCAN_JOB_KEY)
    } catch { /* 浏览器禁用会话存储时，页面内扫描仍可继续 */ }
  }, [scanJobId])
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
      const imported: string[] = []
      for (const file of Array.from(files)) {
        if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error(`${file.name}：仅支持 .xlsx，请先解压压缩包`)
        const result = await api.myagentResearchPoolImport(file)
        imported.push(`${file.name}：识别 ${result.imported} 条`)
      }
      const result = await api.myagentResearchPool()
      setPool(result)
      setFocusFilter('全部')
      setPoolMessage(`${imported.join('；')}。资料池共 ${result.items.length} 条，其中 ${result.items.filter(item => !item.symbol).length} 条待匹配代码；正在运行拾贝扫描。`)
      await scan()
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
  const qualifiedSymbol = (symbol: string) => {
    if (/^\d{6}\.(SH|SZ|BJ)$/i.test(symbol)) return symbol.toUpperCase()
    const code = codeOf(symbol)
    return `${code}.${code.startsWith('6') ? 'SH' : code.startsWith('4') || code.startsWith('8') || code.startsWith('9') ? 'BJ' : 'SZ'}`
  }
  const stockUrl = (candidate: Candidate) => `/stock-analysis?symbol=${encodeURIComponent(qualifiedSymbol(candidate.symbol))}&name=${encodeURIComponent(candidate.name)}`
  const poolByCode = useMemo(() => {
    const map = new Map<string, PoolItem[]>()
    for (const row of pool.items) {
      if (!row.symbol) continue
      const code = codeOf(row.symbol)
      map.set(code, [...(map.get(code) || []), row])
    }
    return map
  }, [pool.items])
  const sectorLeaders = useMemo(() => [...sectorStocks]
    .sort((a, b) => Number(b.pct ?? -999) - Number(a.pct ?? -999)
      || Number(b.volume_ratio ?? 0) - Number(a.volume_ratio ?? 0))
    .slice(0, 8), [sectorStocks])
  const recommendations = useMemo(() => {
    if (!matchedModelSector || !sectorStocks.length) return []
    const stockCodes = new Set(sectorStocks.map(stock => codeOf(stock.symbol)))
    return items.filter(item => stockCodes.has(codeOf(item.symbol)) && poolByCode.has(codeOf(item.symbol))
      && (item.sector === matchedModelSector.sector || !item.sector))
      .map(item => ({ ...item, sectorQuote: sectorStocks.find(stock => codeOf(stock.symbol) === codeOf(item.symbol)) }))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.pct || 0) - Number(a.pct || 0))
      .slice(0, 8)
  }, [items, matchedModelSector, poolByCode, sectorStocks])
  const analyzeCandidate = async (candidate: Candidate & { sectorQuote?: SectorStock }) => {
    if (aiLoading) return
    const quotePrice = quoteByCode.get(codeOf(candidate.symbol))?.price
    if (!quotePrice || !Number.isFinite(quotePrice)) {
      setAiReplies(current => ({ ...current, [candidate.symbol]: 'AI分析暂不可用：尚未取得可核验的公开行情快照。' }))
      return
    }
    setAiLoading(candidate.symbol)
    try {
      const reply = await fetchJson<{ reply: string }>(`${API}/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        symbol: codeOf(candidate.symbol), name: candidate.name,
        question: '请按课堂拾贝规则核对长期地量、低换手、四种资金异动、回踩15/45日均线和7日观察期；结合当前大盘、板块与新闻，分开列出已验证与缺失的数据。第一行必须且只能写“结论：继续观察”、“结论：等待买点”或“结论：可考虑模拟买入”之一；随后列出证据、缺失数据、触发条件和失效条件。数据不足时只能继续观察，旧课程的点位预测不能当作今日事实。不要给真实账户下单指令。',
        context: { model: '拾贝模型', full_symbol: qualifiedSymbol(candidate.symbol), sector: candidate.sectorQuote ? selectedSector : matchedStrongSector(candidate), candidate, sector_quote: candidate.sectorQuote,
          market: market.data ? { as_of: market.data.as_of, breadth: market.data.breadth, amount: market.data.amount,
            indices: market.data.indices, quote_status: market.data.quote_status } : null,
          news: matchedNews(candidate),
          public_quote: quoteByCode.get(codeOf(candidate.symbol)) ?? null,
          research_pool: pool.items.filter(item => item.symbol && codeOf(item.symbol) === codeOf(candidate.symbol)),
          source: '公开行情、用户资料股票池与拾贝扫描' },
      }), })
      setAiReplies(current => ({ ...current, [candidate.symbol]: reply.reply }))
      setAiReviewBasis(current => ({ ...current, [candidate.symbol]: { quotePrice, scanDate: candidate.latest_date ?? '', reviewedAt: Date.now() } }))
    } catch (error) { setAiReplies(current => ({ ...current, [candidate.symbol]: error instanceof Error ? `AI分析失败：${error.message}` : 'AI分析失败' })) }
    finally { setAiLoading('') }
  }
  const scan = async () => {
    setLoading(true); setError(''); setItems([]); setMeta(null); setHasScanResult(true); setAiReplies({}); setAiReviewBasis({})
    try {
      const started = await fetchJson<{ job_id: string }>(`${API}/scan/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, force: true }) })
      setScanJobId(started.job_id)
    } catch (e) { setError(e instanceof Error ? e.message : '扫描失败'); setLoading(false) }
  }
  const shortlist = useMemo(() => items.filter(item => {
    const rows = poolByCode.get(codeOf(item.symbol)) || []
    if (!rows.length) return false
    const isFocus = rows.some(row => row.theme.includes('创新药') || row.theme.includes('物理AI') || row.theme.includes('机器人'))
    return focusFilter === '全部' || (focusFilter === '其他' ? !isFocus : rows.some(row =>
      row.theme.includes(focusFilter) || (focusFilter === '物理AI' && row.theme.includes('机器人'))))
  }).filter(item => {
    const status = `${item.entry_status || ''}${item.pattern || ''}`
    const stage: RecommendationStage = /竞价|集合|盘前/.test(status) ? '集合竞价' : Number(item.pct ?? 0) >= 2 || Number(item.volume_multiple ?? 0) >= 2 ? '盘中推荐' : '其他时间轮动'
    if (recommendationStage !== '全部' && stage !== recommendationStage) return false
    if (cycleFilter === '短线') return Number(item.score ?? 0) >= 80 || Number(item.volume_multiple ?? 0) >= 2
    if (cycleFilter === '中线') return Number(item.score ?? 0) >= 70 && Number(item.score ?? 0) < 80
    if (cycleFilter === '长线') return Number(item.score ?? 0) < 70
    return true
  }).sort((a, b) => Number(b.score ?? -1) - Number(a.score ?? -1) || Number(b.volume_multiple ?? 0) - Number(a.volume_multiple ?? 0))
    .slice(0, 5), [items, poolByCode, focusFilter, recommendationStage, cycleFilter])
  // console.debug('pick shortlist', items.length, pool.items.length, shortlist.length, recommendationStage, cycleFilter)
  const quoteCodes = shortlist.map(item => codeOf(item.symbol)).join(',')
  const quotes = useQuery({
    queryKey: QK.pickModelQuotes(quoteCodes),
    queryFn: () => fetchJson<{ items: CandidateQuote[]; source?: string }>(`${API}/quotes?symbols=${encodeURIComponent(quoteCodes)}`),
    enabled: !!quoteCodes,
    refetchInterval: market.data?.quote_status?.is_trading_hours ? 5_000 : 60_000,
    staleTime: 4_000,
  })
  const quoteByCode = useMemo(() => new Map((quotes.data?.items ?? []).map(item => [codeOf(item.symbol), item])), [quotes.data?.items])
  const focusCandidate = shortlist.find(item => item.symbol === focusSymbol) ?? shortlist[0]
  const focusedMinute = useQuery({
    queryKey: QK.pickModelMinute(focusCandidate ? qualifiedSymbol(focusCandidate.symbol) : ''),
    queryFn: () => api.klineMinute(qualifiedSymbol(focusCandidate!.symbol), undefined, true),
    enabled: !!focusCandidate,
    refetchInterval: market.data?.quote_status?.is_trading_hours ? 5_000 : 60_000,
    staleTime: 4_000,
  })
  const matchedNews = (candidate: Candidate) => {
    const poolRows = poolByCode.get(codeOf(candidate.symbol)) || []
    const terms = [candidate.sector, ...poolRows.map(row => row.theme), ...poolRows.map(row => row.segment)].filter(Boolean) as string[]
    return allNews.filter(news => news.sector_names?.some(sector => terms.some(term => sector.includes(term) || term.includes(sector)))).slice(0, 3)
  }
  const matchedStrongSector = (candidate: Candidate) => {
    const terms = [candidate.sector, ...(poolByCode.get(codeOf(candidate.symbol)) || []).flatMap(row => [row.theme, row.segment])].filter(Boolean) as string[]
    return activeSectors.find(sector => terms.some(term => term.length >= 2 && (sector.name.includes(term) || term.includes(sector.name))))
  }
  const focusSector = focusCandidate ? matchedStrongSector(focusCandidate) : undefined
  const focusedSectorMinute = useQuery({
    queryKey: QK.sectorRotation('concept', undefined, 1, focusSector?.name ?? ''),
    queryFn: () => api.sectorRotation({ kind: 'concept', bucket: 1, seriesNames: [focusSector!.name] }),
    enabled: !!focusSector,
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
  const sectorSeries = focusedSectorMinute.data?.series
  const sectorSeriesIndex = sectorSeries?.sectors.findIndex(name => name === focusSector?.name) ?? -1
  const focusedSectorValues = focusedSectorMinute.data?.date === focusedMinute.data?.date && sectorSeriesIndex >= 0
    ? sectorSeries?.matrix[sectorSeriesIndex] ?? [] : []
  const canSimulate = (candidate: Candidate) => {
    const basis = aiReviewBasis[candidate.symbol]
    const quotePrice = quoteByCode.get(codeOf(candidate.symbol))?.price
    return aiVerdict(aiReplies[candidate.symbol]) === '可考虑模拟买入' && !!basis &&
      !!quotePrice && Number.isFinite(quotePrice) && basis.scanDate === (candidate.latest_date ?? '') &&
      Date.now() - basis.reviewedAt < 120_000 && Math.abs(quotePrice / basis.quotePrice - 1) <= 0.01
  }
  const submitPaperBuy = async () => {
    if (!paperCandidate || !canSimulate(paperCandidate)) {
      setPaperMessage('需要有效且未过期的行情快照，以及 AI 明确给出“可考虑模拟买入”。请重新复核。'); return
    }
    if (!paperAccount || !Number.isInteger(paperQty) || paperQty < 100 || paperQty % 100 !== 0) {
      setPaperMessage('请选择模拟账户，并输入 100 股的整数倍。'); return
    }
    setPaperBusy(true); setPaperMessage('')
    try {
      const result = await api.paperOrderCreate({ symbol: qualifiedSymbol(paperCandidate.symbol), side: 'buy', qty: paperQty, order_type: 'market' }, paperAccount)
      setPaperMessage(`${paperCandidate.name}模拟买入委托已提交（${result.order.status}）。成交后可在模拟盘查看持仓。`)
      setPaperCandidate(null)
    } catch (error) { setPaperMessage(error instanceof Error ? error.message : '模拟下单失败') }
    finally { setPaperBusy(false) }
  }
  const filtered = items.filter(x => !query || `${x.symbol}${x.name}${x.sector || ''}`.includes(query))
  return <div className="h-full overflow-auto bg-base p-3">
    <div className="mb-3 flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-3">
      <div><div className="flex items-center gap-2 text-sm font-semibold"><BookOpen className="h-4 w-4 text-accent" />个股观察 · 拾贝模型</div><p className="mt-1 text-[11px] text-muted">资料股票池 → 地量异动扫描 → 公开行情与板块核对 → AI复核 → 模拟盘。研究候选需逐只验证。</p></div>
      <button onClick={scan} disabled={loading} className="inline-flex items-center gap-1 rounded-btn bg-accent px-3 py-2 text-xs text-white disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{loading ? `后台扫描中 ${scanJob.data?.elapsed_seconds ? `${Math.round(scanJob.data.elapsed_seconds)} 秒` : '…'}` : '扫描全市场'}</button>
    </div>
    <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
      <div className="rounded border border-border bg-surface p-2 text-xs"><span className="text-muted">资料股票池</span><b className="mt-1 block font-mono text-sm">{pool.items.length} 条</b><span className="text-[10px] text-muted">{pool.items.length ? '已入私有数据' : '等待导入'}</span></div>
      <div className="rounded border border-border bg-surface p-2 text-xs"><span className="text-muted">拾贝扫描</span><b className="mt-1 block font-mono text-sm">{meta?.count ?? items.length} 只</b><span className="text-[10px] text-muted">{loading ? `后台任务 ${scanJob.data?.status || '提交中'}` : meta?.generated_at || meta?.data_source || '尚未扫描'}</span></div>
      <div className="rounded border border-border bg-surface p-2 text-xs"><span className="text-muted">可核验候选</span><b className="mt-1 block font-mono text-sm">{shortlist.length} 只</b><span className="text-[10px] text-muted">资料与模型交集 · 最多 5 只</span></div>
      <div className="rounded border border-border bg-surface p-2 text-xs"><span className="text-muted">市场 / 新闻</span><b className="mt-1 block text-sm">{market.data?.as_of?.slice(0, 16) || '市场不可用'}</b><span className="text-[10px] text-muted">新闻 {allNews.length} 条 · 数据时间见详情</span></div>
    </div>
    <div className="mb-3 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><b className="text-sm">我的持仓 · 实时分析</b><p className="mt-1 text-[11px] text-muted">持仓只读接入 MyAgent；缺少数量或成本时明确标记，不推断数据。</p></div><Link to="/holdings" className="text-[11px] text-accent hover:underline">打开持仓首页 ↗</Link></div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{(portfolio.data?.items ?? []).slice(0, 8).map(item => {
        const cost = Number(item.cost); const price = Number(item.price); const qty = Number(item.quantity)
        const breakEven = Number.isFinite(cost) && Number.isFinite(price) && Number.isFinite(qty) && qty > 0 ? cost : null
        return <Link key={item.symbol} to={`/stock-analysis?symbol=${encodeURIComponent(item.symbol)}&name=${encodeURIComponent(item.name)}`} className="rounded border border-border bg-base/60 p-2 text-xs hover:border-accent/60"><div className="flex justify-between gap-2"><b className="truncate">{item.name}</b><span className={Number(item.change_pct) >= 0 ? 'text-bull' : 'text-bear'}>{item.change_pct == null ? '—' : `${Number(item.change_pct).toFixed(2)}%`}</span></div><div className="mt-1 grid grid-cols-2 gap-1 text-[10px] text-muted"><span>现价 {item.price ?? '缺失'}</span><span>数量 {item.quantity ?? '缺失'}</span><span>成本 {item.cost ?? '缺失'}</span><span>浮盈亏 {item.pnl == null ? '缺失' : Number(item.pnl).toFixed(2)}</span></div>{breakEven == null ? <span className="mt-1 block text-[10px] text-warning">回本计算：成本/数量缺失</span> : <span className="mt-1 block text-[10px] text-accent">回本价 {breakEven.toFixed(2)} · 补仓需在个股页计算</span>}</Link>
      })}{!portfolio.isLoading && !(portfolio.data?.items?.length) && <p className="text-xs text-muted">暂无已接入持仓，或持仓数据源暂不可用。</p>}</div>
    </div>
    <section className="mb-3 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><b className="text-sm">资料股票池 × 拾贝扫描 · 待观察</b><p className="mt-1 text-[11px] text-muted">创新药、物理 AI 优先核对，也保留其他板块；只展示资料与扫描交集，按模型评分排序。新闻和板块是旁证，不能代替买点确认。</p></div><Link to="/paper" className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-secondary"><Wallet className="h-3.5 w-3.5" />模拟盘</Link></div>
      <div className="mt-2 text-[10px] text-muted">已存 {pool.items.length} 条资料记录 · {new Set(pool.items.filter(item => item.symbol).map(item => codeOf(item.symbol!))).size} 只已识别股票 · {pool.items.filter(item => !item.symbol).length} 条待匹配代码 · 资料日期：{Array.from(new Set(pool.items.map(item => item.source_date).filter(Boolean))).join(' / ') || '未注明'} · 大盘快照：{market.data?.as_of || '不可用'}</div>
      <div className={`mt-2 flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 ${pool.items.length ? 'border-border bg-base/50' : 'border-warning/50 bg-warning/5'}`}>
        <p className={`min-w-0 text-xs ${pool.items.length ? 'text-muted' : 'text-warning'}`}>{pool.items.length ? '可以继续导入或更新研究资料，文件按名称覆盖旧版本。' : '资料池为空：请先导入你给我的“创新药与物理AI产业链”Excel。'}</p>
        <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded bg-accent px-3 py-2 text-xs font-medium text-white hover:brightness-110">
          <Upload className="h-4 w-4" />{poolBusy ? '正在导入…' : '导入 Excel'}
          <input aria-label="选择研究资料 Excel" type="file" multiple accept=".xlsx" className="hidden" disabled={poolBusy} onChange={event => { void importPool(event.target.files); event.target.value = '' }} />
        </label>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">{(['全部', '创新药', '物理AI', '其他'] as const).map(value => <button key={value} type="button" disabled={!pool.items.length} onClick={() => setFocusFilter(value)} className={`rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${focusFilter === value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted'}`}>{value}</button>)}<span className="ml-1 text-muted">当前阶段最多显示 5 只；资金、情绪、新闻缺失会单独标记</span></div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]"><span className="mr-1 text-muted">推荐时段</span>{(['全部', '集合竞价', '盘中推荐', '其他时间轮动'] as RecommendationStage[]).map(value => <button key={value} type="button" onClick={() => setRecommendationStage(value)} className={`rounded border px-2 py-1 ${recommendationStage === value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted'}`}>{value}</button>)}<span className="mx-1 text-muted">周期</span>{(['全部', '短线', '中线', '长线'] as Cycle[]).map(value => <button key={value} type="button" onClick={() => setCycleFilter(value)} className={`rounded border px-2 py-1 ${cycleFilter === value ? 'border-sky-400/70 bg-sky-400/10 text-sky-300' : 'border-border text-muted'}`}>{value}</button>)}</div>
      {!!pool.sources.length && <p className="mt-1 text-[10px] text-muted">已导入：{pool.sources.join('、')}</p>}
      {pool.items.some(item => !item.symbol) && <details className="mt-2 text-[10px] text-muted"><summary className="cursor-pointer">查看待匹配代码的股票名称</summary><div className="mt-1 max-h-24 overflow-auto">{pool.items.filter(item => !item.symbol).slice(0, 100).map((item, index) => <span key={`${item.name}-${index}`} className="mr-2 inline-block">{item.name}（{item.theme}）</span>)}</div></details>}
      {poolMessage && <p className="mt-1 text-[11px] text-accent">{poolMessage}</p>}
      {!pool.items.length && <p className="mt-2 text-xs text-warning">主题筛选尚无内容。支持 .xlsx；课程压缩包请先解压后选择其中的 .xlsx。下方扫描股票仍可点击查看个股走势。</p>}
      {!!pool.items.length && !items.length && <p className="mt-2 text-xs text-muted">资料已就绪。点击“扫描全市场”后，才会从真实模型结果中筛出观察候选。</p>}
      {!!pool.items.length && !!items.length && !shortlist.length && <p className="mt-2 text-xs text-warning">拾贝初筛 {items.length} 只 → 文档代码匹配 0 只 → 本次展示 0 只。没有匹配就不输出个股。</p>}
      {!!shortlist.length && <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(250px,0.75fr)_minmax(0,1.6fr)]">
        <div className="grid content-start gap-2" aria-label="待观察个股">
          {shortlist.map((candidate, index) => {
            const quote = quoteByCode.get(codeOf(candidate.symbol))
            const sector = matchedStrongSector(candidate)
            const verdict = aiVerdict(aiReplies[candidate.symbol])
            return <button key={candidate.symbol} type="button" onClick={() => setFocusSymbol(candidate.symbol)} className={`rounded border p-3 text-left ${focusCandidate?.symbol === candidate.symbol ? 'border-accent bg-accent/10' : 'border-border bg-base/60 hover:border-accent/60'}`}>
              <div className="flex items-start justify-between gap-2"><div><span className="mr-2 text-[10px] text-muted">#{index + 1}</span><b className="text-sm">{candidate.name}</b><span className="ml-1 text-[10px] text-muted">{candidate.symbol}</span></div><b className="whitespace-nowrap font-mono text-accent">{candidate.score ?? '—'} 分</b></div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"><span>公开快照 <b className="font-mono">{quote?.price ? quote.price.toFixed(2) : '—'}</b></span><span className={Number(quote?.pct) >= 0 ? 'text-bull' : 'text-bear'}>{quote?.pct == null ? '涨跌待取' : `${quote.pct.toFixed(2)}%`}</span><span className="text-muted">{sector ? `${sector.name} ${sector.pct == null ? '' : `${Number(sector.pct).toFixed(2)}%`}` : '板块待核'}</span></div>
              <div className="mt-2 flex flex-wrap gap-1 text-[10px]"><span className="rounded bg-elevated px-1.5 py-0.5">{candidate.entry_status || '模型阶段待核'}</span><span className="rounded bg-elevated px-1.5 py-0.5">放量 {candidate.volume_multiple ?? '—'}×</span><span className="rounded bg-elevated px-1.5 py-0.5">{verdict ? `AI：${verdict}` : '待 AI 复核'}</span></div>
            </button>
          })}
        </div>
        {focusCandidate && <div className="min-w-0 rounded border border-border bg-base/60 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex items-center gap-2"><Activity className="h-4 w-4 text-accent" /><b className="text-sm">{focusCandidate.name} · 个股观察</b></div><p className="mt-1 text-[10px] text-muted">{qualifiedSymbol(focusCandidate.symbol)} · 拾贝扫描日 {focusCandidate.latest_date || '未知'} · {quotes.data?.source || '公开快照暂不可用'}</p></div><div className="flex gap-1"><button type="button" onClick={() => void analyzeCandidate(focusCandidate)} disabled={aiLoading === focusCandidate.symbol} className="rounded border border-accent/50 px-2 py-1 text-[11px] text-accent disabled:opacity-50">{aiLoading === focusCandidate.symbol ? 'AI复核中…' : 'AI量化复核'}</button><Link to={stockUrl(focusCandidate)} className="rounded border border-border px-2 py-1 text-[11px]">完整走势</Link></div></div>
          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(240px,0.8fr)]">
            <div className="min-w-0 rounded border border-border bg-surface p-2"><div className="flex justify-between text-xs"><b>个股分时与成交量</b><span className="text-muted">{focusedMinute.data?.date || '读取中'}</span></div>{focusedMinute.data?.rows?.length ? <EChartsIntraday data={focusedMinute.data.rows} assetType={focusedMinute.data.asset_type ?? 'stock'} height={310} date={focusedMinute.data.date ?? undefined} prevClose={focusedMinute.data.prev_close ?? undefined} priceLimit={focusedMinute.data.price_limit ?? undefined} /> : <div className="flex h-[310px] items-center justify-center text-xs text-muted">{focusedMinute.isLoading ? '正在读取分钟走势…' : '当前分钟数据不可用'}</div>}<p className="text-[10px] text-muted">来源：{focusedMinute.data?.source || '未取得'} · 最后行情：{focusedMinute.data?.rows?.at(-1)?.datetime || '—'}</p></div>
            <div className="grid content-start gap-2"><div className="rounded border border-border bg-surface p-2"><div className="flex justify-between text-xs"><b>{focusSector?.name || '关联板块待核'} · 分钟走势</b><span className="text-muted">{focusedSectorMinute.data?.date || '—'}</span></div><SectorTrend values={focusedSectorValues} buckets={sectorSeries?.buckets ?? []} /><p className="text-[10px] text-muted">{focusSector ? '概念成分股等权涨跌幅；只有同交易日且名称匹配才显示' : '资料板块未与实时概念板块匹配，不推断走势'}</p></div><div className="rounded border border-border bg-surface p-2 text-[11px]"><b>量价核对</b><div className="mt-1 grid grid-cols-2 gap-1 text-muted"><span>放量 {focusCandidate.volume_multiple ?? '—'}×</span><span>最高换手 {focusCandidate.max_turnover ?? '—'}%</span><span>均线距离 {focusCandidate.ma_distance_pct ?? '—'}%</span><span>量比 {quoteByCode.get(codeOf(focusCandidate.symbol))?.volume_ratio ?? '—'}</span></div><p className="mt-1 text-[10px] text-muted">{focusCandidate.pattern || focusCandidate.entry_status || '形态尚未核验'}</p></div></div>
          </div>
          <div className="mt-2 grid gap-2 lg:grid-cols-2"><div className="rounded border border-border bg-surface p-2 text-[11px]"><b>资料与板块依据</b>{(poolByCode.get(codeOf(focusCandidate.symbol)) || []).slice(0, 3).map((row, index) => <p key={`${row.theme}-${index}`} className="mt-1 text-muted">{row.theme} / {row.segment || row.role}：{row.rationale || '资料未写明逻辑'} <span className="text-[10px]">（{row.source_date || '日期未知'}）</span></p>)}</div><div className="rounded border border-border bg-surface p-2 text-[11px]"><b>相关新闻</b>{matchedNews(focusCandidate).length ? matchedNews(focusCandidate).map((item, index) => <a key={`${item.url}-${index}`} href={item.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-accent hover:underline">{item.title} · {item.source}</a>) : <p className="mt-1 text-muted">暂无可核对的关联新闻，不补写新闻理由。</p>}</div></div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface p-2 text-[11px]"><div><b>AI复核：{aiVerdict(aiReplies[focusCandidate.symbol]) || '未完成'}</b><p className="mt-1 text-muted">只有明确给出“可考虑模拟买入”，且复核未超过 2 分钟、行情偏离不超过 1%，才开放模拟委托。</p></div><button type="button" onClick={() => { setPaperCandidate(focusCandidate); setPaperMessage('') }} disabled={!canSimulate(focusCandidate)} className="rounded border border-accent px-2 py-1 text-accent disabled:cursor-not-allowed disabled:opacity-40">模拟买入…</button></div>
          {aiReplies[focusCandidate.symbol] && <p className="mt-2 whitespace-pre-wrap rounded bg-elevated p-2 text-[11px] leading-relaxed text-secondary">{aiReplies[focusCandidate.symbol]}</p>}
        </div>}
      </div>}
      {paperMessage && <p className="mt-2 text-[11px] text-accent">{paperMessage} <Link to="/paper" className="underline">查看模拟盘</Link></p>}
    </section>
    {paperCandidate && <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-sm rounded-card border border-border bg-surface p-4 text-xs"><b>模拟买入 · {paperCandidate.name}</b><p className="mt-2 text-muted">仅向虚拟账户提交委托，不连接真实券商。扫描日 {paperCandidate.latest_date || '未知'}；公开行情快照 {quoteByCode.get(codeOf(paperCandidate.symbol))?.price?.toFixed(2) ?? '不可用'}，AI 结论：{aiVerdict(aiReplies[paperCandidate.symbol]) || '无'}。</p><label className="mt-3 grid gap-1">模拟账户<select value={paperAccount} onChange={event => setPaperAccount(event.target.value)} className="h-8 rounded border border-border bg-base px-2">{paperAccounts.map(account => <option key={account.id} value={account.id}>{account.name || account.id}</option>)}</select></label><label className="mt-3 grid gap-1">股数（100 股整数倍）<input type="number" min={100} step={100} value={paperQty} onChange={event => setPaperQty(Number(event.target.value))} className="h-8 rounded border border-border bg-base px-2" /></label>{!paperAccounts.length && <p className="mt-2 text-warning">还没有可用模拟账户。请先到模拟盘创建账户。</p>}{paperMessage && <p className="mt-2 text-danger">{paperMessage}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setPaperCandidate(null)} className="rounded border border-border px-3 py-1.5">取消</button><button type="button" onClick={() => void submitPaperBuy()} disabled={paperBusy || !paperAccount || !canSimulate(paperCandidate)} className="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-50">{paperBusy ? '提交中…' : '确认模拟买入'}</button></div></div></div>}
    <div className="mb-3 grid grid-cols-2 gap-2 rounded-card border border-border bg-surface p-3 md:grid-cols-5">
      {([['baseline_days','长期地量天数'],['max_avg_turnover','每日换手上限%'],['recent_days','异动窗口天数'],['volume_multiple','放量倍数'],['max_market_cap_yi','放量前市值上限亿']] as const).map(([k,label]) => <label key={k} className="grid gap-1 text-[11px] text-muted">{label}<input type="number" value={form[k]} onChange={e => setForm({...form, [k]: Number(e.target.value)})} className="h-8 rounded border border-border bg-elevated px-2 text-xs text-foreground" /></label>)}
    </div>
    {error && <div className="mb-3 flex items-center gap-2 rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger"><AlertTriangle className="h-4 w-4" />{error}</div>}
    <section className="mb-3 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><b className="text-sm">最近强势板块 · 独立行情榜</b><p className="mt-1 text-[11px] text-muted">板块强弱来自实时轮动，独立于拾贝模型。点击板块先看成分股异动；只有同时通过拾贝和资料池匹配的股票，才进入下方共振候选。</p></div><span className="text-[10px] text-warning">行情层 ≠ 拾贝筛选</span></div>
      <div className="mt-1 text-[10px] text-muted">{conceptRotation.data?.status === 'ok' && conceptRotation.data.date === market.data?.as_of?.slice(0, 10) ? `板块分钟轮动 ${conceptRotation.data.as_of || conceptRotation.data.date} · 约30秒更新` : '公开板块目录（可能延迟，暂无同日分钟轮动）'}</div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">{activeSectors.map(sector => <button key={sector.code} type="button" onClick={() => void selectSector(sector)} className={`rounded border px-2 py-1.5 text-left text-xs ${selectedSector?.code === sector.code ? 'border-accent bg-accent/15' : 'border-border bg-base hover:border-accent/60'}`}><div className="flex items-center justify-between gap-1"><b className="truncate">{sector.name}</b><span className={Number(sector.pct) >= 0 ? 'text-bull' : 'text-bear'}>{sector.pct == null ? '—' : `${Number(sector.pct).toFixed(2)}%`}</span></div><span className="text-[10px] text-muted">{sector.code}</span></button>)}{!activeSectors.length && <p className="text-xs text-muted">板块排行暂不可用，请稍后刷新。</p>}</div>
      {selectedSector && <div className="mt-2 rounded border border-border/70 bg-base/50 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><b>{selectedSector.name}</b><span className="text-muted">公开板块涨幅 {selectedSector.pct == null ? '—' : `${Number(selectedSector.pct).toFixed(2)}%`} · {matchedModelSector ? `成分股映射：${matchedModelSector.sector}` : '项目资料暂无精确板块映射'}</span></div>
        {sectorLoading && <p className="mt-2 text-xs text-accent">正在读取个股库、新闻和量价数据…</p>}
        {sectorError && <p className="mt-2 text-xs text-danger">{sectorError}</p>}
        {!!sectorLeaders.length && <div className="mt-2"><div className="mb-1 text-[11px] font-medium">板块成分股异动榜 <span className="font-normal text-muted">（仅展示行情事实）</span></div><div className="grid gap-1.5 lg:grid-cols-2">{sectorLeaders.map(stock => {
          const scanCandidate = items.find(item => codeOf(item.symbol) === codeOf(stock.symbol))
          const inResearchPool = poolByCode.has(codeOf(stock.symbol))
          return <article key={stock.symbol} className="rounded border border-border bg-surface p-2 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><div><Link to={stockUrl(stock)} className="font-semibold hover:text-accent">{stock.name}</Link><span className="ml-2 text-muted">{stock.symbol}</span></div><span className={Number(stock.pct) >= 0 ? 'font-semibold text-bull' : 'font-semibold text-bear'}>{stock.pct == null ? '—' : `${stock.pct.toFixed(2)}%`}</span></div><div className="mt-1 flex flex-wrap gap-1 text-[10px]"><span className="rounded bg-elevated px-1.5 py-0.5 text-muted">量比 {stock.volume_ratio == null ? '—' : stock.volume_ratio.toFixed(2)}</span><span className="rounded bg-elevated px-1.5 py-0.5 text-muted">换手 {stock.turnover == null ? '—' : `${stock.turnover.toFixed(2)}%`}</span>{scanCandidate && <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-sky-300">拾贝通过 {scanCandidate.score ?? '—'}分</span>}{inResearchPool && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-300">资料匹配</span>}</div></article>
        })}</div></div>}
        {!sectorLoading && matchedModelSector && !sectorLeaders.length && <p className="mt-2 text-xs text-warning">该板块成分股行情暂不可用，请稍后刷新。</p>}
        {!sectorLoading && !matchedModelSector && <p className="mt-2 text-xs text-warning">该强势板块暂未建立成分股映射，只显示板块强弱，不猜测关联股票。</p>}
        <div className="mt-3 border-t border-border/60 pt-2 text-[11px] font-medium">板块 × 拾贝 × 资料池共振候选</div>
        {!items.length && <p className="mt-1 text-xs text-muted">尚无拾贝扫描结果；上面的板块异动榜仍可独立查看。</p>}
        {!!items.length && !recommendations.length && <p className="mt-1 text-xs text-warning">当前板块没有同时通过“拾贝扫描 + 文档代码匹配”的股票，本轮不输出共振候选。</p>}
        {!!recommendations.length && <div className="mt-2 grid gap-1.5 lg:grid-cols-2">{recommendations.map(candidate => <article key={candidate.symbol} className="rounded border border-accent/30 bg-accent/[0.04] p-2 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><div><b>{candidate.name}</b><span className="ml-2 text-muted">{candidate.symbol}</span></div><span className="font-semibold text-accent">拾贝评分 {candidate.score ?? '—'}</span></div><div className="mt-1 grid grid-cols-2 gap-1 text-[10px] text-muted sm:grid-cols-4"><span>涨跌 {candidate.pct == null ? '—' : `${candidate.pct.toFixed(2)}%`}</span><span>放量 {candidate.volume_multiple == null ? '—' : `${candidate.volume_multiple}x`}</span><span>量比 {candidate.sectorQuote?.volume_ratio == null ? '—' : candidate.sectorQuote.volume_ratio.toFixed(2)}</span><span>换手 {candidate.sectorQuote?.turnover == null ? '—' : `${candidate.sectorQuote.turnover.toFixed(2)}%`}</span></div><p className="mt-1 text-[10px] text-secondary">共振依据：强势板块 {selectedSector.name} · 拾贝阶段 {candidate.entry_status || '—'} · 文档已匹配 · 新闻 {sectorNews.length ? '有可核对条目' : '暂无可核对条目'}</p><button type="button" onClick={() => void analyzeCandidate(candidate)} disabled={aiLoading === candidate.symbol} className="mt-1 rounded border border-accent/50 px-2 py-1 text-[10px] text-accent disabled:opacity-50">{aiLoading === candidate.symbol ? 'AI分析中…' : 'AI量化复核'}</button>{aiReplies[candidate.symbol] && <p className="mt-1 rounded bg-accent/5 p-1.5 text-[10px] leading-relaxed text-secondary"><b className="text-accent">AI：</b>{aiReplies[candidate.symbol]}</p>}</article>)}</div>}
      </div>}
    </section>
    <div className="mb-2 flex items-center justify-between text-xs text-muted"><span>候选 {meta?.count ?? items.length} 只 · 全市场样本 {meta?.universe_count ?? '—'} · {meta?.data_source ?? '尚未扫描'}</span><label className="flex items-center gap-1"><Search className="h-3.5 w-3.5" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索代码 / 名称 / 板块" className="h-7 w-48 rounded border border-border bg-elevated px-2 text-xs text-foreground" /></label></div>
    <div className="overflow-auto rounded-card border border-border bg-surface"><table className="w-full min-w-[980px] text-xs"><thead className="bg-elevated text-muted"><tr>{['股票 / 板块','现价','涨跌','评分','优先级','模型阶段','放量倍数','最高换手','放量前市值','均线距离','形态','操作'].map(x => <th key={x} className="whitespace-nowrap px-3 py-2 text-left font-medium">{x}</th>)}</tr></thead><tbody>{filtered.map(x => <tr key={x.symbol} className="border-t border-border/60 hover:bg-elevated"><td className="px-3 py-2"><Link to={stockUrl(x)} className="font-semibold text-accent hover:underline">{x.name}</Link><small className="ml-2 text-muted">{x.symbol} · {x.sector || '其他'}</small></td><td className="px-3 py-2">{Number(x.price || 0).toFixed(2)}</td><td className={Number(x.pct) >= 0 ? 'px-3 py-2 text-bull' : 'px-3 py-2 text-bear'}>{Number(x.pct || 0).toFixed(2)}%</td><td className="px-3 py-2 font-semibold text-accent">{x.score ?? '—'}</td><td className="px-3 py-2">{x.priority || '—'}</td><td className="px-3 py-2">{x.entry_status || '—'}</td><td className="px-3 py-2">{x.volume_multiple ? `${x.volume_multiple}x` : '—'}</td><td className="px-3 py-2">{x.max_turnover ?? '—'}%</td><td className="px-3 py-2">{x.pre_market_cap_yi ?? '—'}亿</td><td className="px-3 py-2">{x.ma_distance_pct ?? '—'}%</td><td className="px-3 py-2">{x.pattern || '—'}</td><td className="px-3 py-2"><Link to={stockUrl(x)} className="whitespace-nowrap text-accent hover:underline">查看走势</Link></td></tr>)}</tbody></table>{!loading && !filtered.length && <div className="p-10 text-center text-xs text-muted">点击“扫描全市场”获取拾贝模型候选</div>}</div>
  </div>
}
