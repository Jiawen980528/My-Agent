import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, ArrowDown, ArrowUp, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { api, type IndexInstrument, type KlineRow, type MinuteKlineRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { useCapabilities } from '@/lib/useSharedQueries'
import { EChartsCandlestick, type OHLC } from '@/components/EChartsCandlestick'
import { EChartsIntraday, EChartsMultiDayIntraday } from '@/components/EChartsIntraday'
import { useIndexWatchlist } from '@/lib/indexWatchlist'
import { MA_PERIODS, useMALines } from '@/lib/maLines'
import { resampleMinutes } from '@/lib/minuteResample'

function defaultRange() {
  const now = new Date()
  const end = now.toISOString().slice(0, 10)
  const s = new Date(now)
  s.setMonth(s.getMonth() - 6)
  return { start: s.toISOString().slice(0, 10), end }
}

function toOHLC(rows: KlineRow[]): OHLC[] {
  return rows
    .filter(r => r?.date != null && r.open != null && r.close != null)
    .map(r => ({
      date: typeof r.date === 'string' ? r.date.slice(0, 10) : String(r.date),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
      ma5: r.ma5 != null ? Number(r.ma5) : null,
      ma10: r.ma10 != null ? Number(r.ma10) : null,
      ma20: r.ma20 != null ? Number(r.ma20) : null,
      ma60: r.ma60 != null ? Number(r.ma60) : null,
      macd_dif: r.macd_dif != null ? Number(r.macd_dif) : null,
      macd_dea: r.macd_dea != null ? Number(r.macd_dea) : null,
      macd_hist: r.macd_hist != null ? Number(r.macd_hist) : null,
      rsi_6: r.rsi_6 != null ? Number(r.rsi_6) : null,
      rsi_14: r.rsi_14 != null ? Number(r.rsi_14) : null,
      rsi_24: r.rsi_24 != null ? Number(r.rsi_24) : null,
      kdj_k: r.kdj_k != null ? Number(r.kdj_k) : null,
      kdj_d: r.kdj_d != null ? Number(r.kdj_d) : null,
      kdj_j: r.kdj_j != null ? Number(r.kdj_j) : null,
      boll_upper: r.boll_upper != null ? Number(r.boll_upper) : null,
      boll_lower: r.boll_lower != null ? Number(r.boll_lower) : null,
    }))
}

function fmtPct(v: number | null | undefined) {
  if (v == null || Number.isNaN(Number(v))) return '--'
  return `${Number(v).toFixed(2)}%`
}

function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return '--'
  return Number(v).toFixed(digits)
}

function previousTradingDates(day: string, count: number): string[] {
  const date = new Date(`${day}T12:00:00+08:00`)
  const out = [day]
  while (out.length < count) {
    date.setDate(date.getDate() - 1)
    if (date.getDay() !== 0 && date.getDay() !== 6) out.push(date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))
  }
  return out
}

export function Indices() {
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const symbolParam = searchParams.get('symbol') ?? ''
  const [selected, setSelected] = useState<string>(symbolParam)
  const [range, setRange] = useState(defaultRange)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [linkedPrice, setLinkedPrice] = useState<number | null>(null)
  const [savedIndexes, saveIndexes] = useIndexWatchlist()
  const [visibleMAs, saveVisibleMAs] = useMALines()
  const [indexSearch, setIndexSearch] = useState('')
  const [sortMode, setSortMode] = useState<'manual' | 'codeAsc' | 'codeDesc' | 'pctAsc' | 'pctDesc'>('manual')
  const [minutePeriod, setMinutePeriod] = useState(1)
  const [minuteDays, setMinuteDays] = useState(1)
  const [minuteSource, setMinuteSource] = useState<'auto' | 'configured' | 'public'>(() => {
    const saved = localStorage.getItem('indices-minute-source')
    return saved === 'configured' || saved === 'public' ? saved : 'auto'
  })

  useEffect(() => { localStorage.setItem('indices-minute-source', minuteSource) }, [minuteSource])

  const caps = useCapabilities()
  const hasMinuteCap = !!(caps.data?.capabilities?.['kline.minute.by_symbol'] || caps.data?.capabilities?.['kline.minute.batch'])

  const topRows: IndexInstrument[] = savedIndexes.map(p => ({
    symbol: p.symbol, name: p.name, asset_type: 'index' as const,
  }))

  const indexMatches = useQuery({
    queryKey: QK.instrumentSearch(indexSearch.trim(), 'index'),
    queryFn: () => api.instrumentSearch(indexSearch.trim(), 20, 'index'),
    enabled: indexSearch.trim().length >= 2,
  })

  const selectedSymbol = selected || topRows[0]?.symbol || ''

  useEffect(() => {
    if (symbolParam && symbolParam !== selected) setSelected(symbolParam)
  }, [selected, symbolParam])

  const selectIndex = (symbol: string) => {
    setSelected(symbol)
    setSearchParams({ symbol })
  }
  const addIndex = (symbol: string, name: string) => {
    const normalized = symbol.trim().toUpperCase()
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(normalized) || savedIndexes.some(row => row.symbol === normalized)) return
    saveIndexes([...savedIndexes, { symbol: normalized, name: name || normalized }])
    setIndexSearch('')
    selectIndex(normalized)
  }
  const removeIndex = (symbol: string) => {
    const next = savedIndexes.filter(row => row.symbol !== symbol)
    saveIndexes(next)
    if (selectedSymbol === symbol) {
      setSelected(next[0]?.symbol ?? '')
      setSearchParams(next[0] ? { symbol: next[0].symbol } : {})
    }
  }
  const moveIndex = (symbol: string, step: number) => {
    const next = [...savedIndexes]
    const from = next.findIndex(row => row.symbol === symbol)
    const to = from + step
    if (from < 0 || to < 0 || to >= next.length) return
    ;[next[from], next[to]] = [next[to], next[from]]
    saveIndexes(next)
  }

  const quotes = useQuery({
    queryKey: QK.indexQuotes,
    queryFn: () => api.indexQuotes(),
    placeholderData: (prev) => prev,
  })

  const daily = useQuery({
    queryKey: QK.indexDaily(selectedSymbol, range.start, range.end),
    queryFn: () => api.indexDaily(selectedSymbol, 180, range),
    enabled: !!selectedSymbol,
    placeholderData: (prev) => prev,
  })

  const minute = useQuery({
    queryKey: QK.indexMinute(selectedSymbol, selectedDate ?? ''),
    queryFn: () => api.indexMinute(selectedSymbol, selectedDate ?? undefined),
    enabled: !!selectedSymbol && !!selectedDate && hasMinuteCap && minuteSource !== 'public',
  })
  const publicMinute = useQuery({
    queryKey: ['index-public-minute', selectedSymbol, selectedDate],
    queryFn: () => api.indexPublicMinute(selectedSymbol, selectedDate ?? undefined),
    enabled: !!selectedSymbol && !!selectedDate && (minuteSource === 'public' || (minuteSource === 'auto' && (!hasMinuteCap || minute.isError || (minute.isSuccess && !minute.data?.rows?.length)))),
    refetchInterval: 60_000,
  })
  const historicalMinuteDates = useMemo(() => selectedDate && minuteDays > 1 ? previousTradingDates(selectedDate, minuteDays) : [], [selectedDate, minuteDays])
  const historicalMinuteQueries = useQueries({ queries: historicalMinuteDates.map(date => ({
    queryKey: ['index-minute-range', selectedSymbol, date, minuteSource],
    queryFn: async () => {
      if (minuteSource === 'public' || !hasMinuteCap) return api.indexPublicMinute(selectedSymbol, date)
      return api.indexMinute(selectedSymbol, date)
    },
    enabled: !!selectedSymbol && !!selectedDate && minuteDays > 1,
  })) })

  const syncDaily = useMutation({
    mutationFn: () => api.syncIndexDaily(365),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.indexQuotes })
      qc.invalidateQueries({ queryKey: ['index-daily'] })
    },
  })

  const quoteBySymbol = useMemo(() => {
    const m = new Map<string, any>()
    for (const q of quotes.data?.rows ?? []) m.set(q.symbol, q)
    return m
  }, [quotes.data?.rows])
  const sortedRows = useMemo(() => {
    const rows = [...topRows]
    if (sortMode === 'codeAsc') rows.sort((a, b) => a.symbol.localeCompare(b.symbol))
    if (sortMode === 'codeDesc') rows.sort((a, b) => b.symbol.localeCompare(a.symbol))
    if (sortMode === 'pctAsc' || sortMode === 'pctDesc') {
      const pct = (symbol: string) => Number(quoteBySymbol.get(symbol)?.change_pct ?? quoteBySymbol.get(symbol)?.pct ?? 0)
      rows.sort((a, b) => (pct(a.symbol) - pct(b.symbol)) * (sortMode === 'pctAsc' ? 1 : -1))
    }
    return rows
  }, [savedIndexes, sortMode, quoteBySymbol])
  const selectedQuote = selectedSymbol ? quoteBySymbol.get(selectedSymbol) : null
  const selectedQuoteValue = selectedQuote?.last_price ?? selectedQuote?.price ?? selectedQuote?.close
  const selectedQuotePct = selectedQuote?.change_pct ?? selectedQuote?.pct

  const chartRows = useMemo(() => toOHLC(daily.data?.rows ?? []), [daily.data?.rows])
  const visibleChartRows = useMemo(() => chartRows.map(row => ({
    ...row,
    ma5: visibleMAs.includes(5) ? row.ma5 : null,
    ma10: visibleMAs.includes(10) ? row.ma10 : null,
    ma20: visibleMAs.includes(20) ? row.ma20 : null,
    ma60: visibleMAs.includes(60) ? row.ma60 : null,
  })), [chartRows, visibleMAs])
  const selectedInfo = topRows.find(r => r.symbol === selectedSymbol) || daily.data?.index_info
  const licensedMinuteRows: MinuteKlineRow[] = minute.data?.symbol === selectedSymbol
    && minute.data?.date === selectedDate ? minute.data.rows : []
  const useLicensedMinute = minuteSource !== 'public' && licensedMinuteRows.length > 0
  const minuteRows: MinuteKlineRow[] = useLicensedMinute ? licensedMinuteRows
    : minuteSource !== 'configured' && publicMinute.data?.symbol === selectedSymbol && publicMinute.data?.date === selectedDate
      ? publicMinute.data.rows : []
  const publicAveragePrices = useMemo(() => minuteRows.map(row => {
    const value = row.avg_price
    return value != null && Number.isFinite(value) && value > 0 ? value : null
  }), [minuteRows])
  const hasPublicAverage = !useLicensedMinute && publicAveragePrices.some(value => value != null)
  const periodRows = useMemo(() => minutePeriod === 1 ? [] : resampleMinutes(minuteRows, minutePeriod), [minuteRows, minutePeriod])
  const multiDayMinuteRows = useMemo(() => historicalMinuteQueries.flatMap(query => query.data?.rows ?? []).sort((a, b) => a.datetime.localeCompare(b.datetime)), [historicalMinuteQueries])
  const selectedIdx = selectedDate ? chartRows.findIndex(r => r.date === selectedDate) : -1
  const prevClose = selectedIdx > 0
    ? chartRows[selectedIdx - 1].close
    : chartRows.length >= 2
      ? chartRows[chartRows.length - 2].close
      : undefined

  useEffect(() => {
    setSelectedDate(null)
    setLinkedPrice(null)
  }, [selectedSymbol])

  useEffect(() => {
    if ((!selectedDate || !chartRows.some(r => r.date === selectedDate)) && chartRows.length > 0 && daily.data?.symbol === selectedSymbol) {
      setSelectedDate(chartRows[chartRows.length - 1].date)
    }
  }, [chartRows, daily.data?.symbol, selectedDate, selectedSymbol])
  const renderIndexItem = (item: IndexInstrument) => {
    const q = quoteBySymbol.get(item.symbol)
    const pct = q?.change_pct ?? q?.pct
    const current = q?.last_price ?? q?.price ?? q?.close
    const active = item.symbol === selectedSymbol
    return (
      <div key={item.symbol} className="flex items-center gap-0.5">
      <button
        onClick={() => selectIndex(item.symbol)}
        className={`min-w-0 flex-1 rounded-btn px-2 py-2 text-left transition-colors ${active ? 'bg-accent/15 text-foreground' : 'hover:bg-elevated text-secondary'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium">{item.name || item.symbol}</span>
          <span className={`text-[10px] font-mono ${Number(pct ?? 0) >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtPct(pct)}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[10px] font-mono text-muted">
          <span>{item.symbol}</span>
          <span>{fmtNum(current)}</span>
        </div>
      </button>
      <div className="flex flex-col">
        <button type="button" onClick={() => moveIndex(item.symbol, -1)} aria-label={`上移${item.name}`} title="上移" className="p-0.5 text-muted hover:text-foreground"><ArrowUp className="h-3 w-3" /></button>
        <button type="button" onClick={() => moveIndex(item.symbol, 1)} aria-label={`下移${item.name}`} title="下移" className="p-0.5 text-muted hover:text-foreground"><ArrowDown className="h-3 w-3" /></button>
        <button type="button" onClick={() => removeIndex(item.symbol)} aria-label={`删除${item.name}`} title="删除" className="p-0.5 text-muted hover:text-danger"><X className="h-3 w-3" /></button>
      </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-base p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">指数</h1>
          <p className="mt-1 text-xs text-muted">
            指数使用独立 kline_index_* parquet，不进入股票策略链路。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncDaily.mutate()}
            disabled={syncDaily.isPending}
            className="inline-flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {syncDaily.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            同步指数日K
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="rounded-card border border-border bg-surface p-3">
          <div className="mb-2 px-1 text-xs text-muted">我的指数 · {savedIndexes.length} 只</div>
          <div className="mb-2 flex gap-1">
            <input value={indexSearch} onChange={e => setIndexSearch(e.target.value)} placeholder="搜索代码或名称" aria-label="搜索指数"
              className="min-w-0 flex-1 rounded-btn border border-border bg-base px-2 py-1 text-xs text-foreground" />
            <button type="button" title="按代码添加" aria-label="添加指数"
              onClick={() => addIndex(indexSearch, indexSearch)}
              className="rounded-btn border border-border p-1 text-accent hover:bg-elevated"><Plus className="h-4 w-4" /></button>
          </div>
          {!!indexSearch.trim() && <div className="mb-2 max-h-44 overflow-auto rounded-btn border border-border bg-base">
            {(indexMatches.data?.results ?? []).filter(row => !savedIndexes.some(saved => saved.symbol === row.symbol)).map(row => (
              <button key={row.symbol} type="button" onClick={() => addIndex(row.symbol, row.name)} className="block w-full px-2 py-1.5 text-left text-xs hover:bg-elevated">
                {row.name} <span className="text-muted">{row.symbol}</span>
              </button>
            ))}
          </div>}
          <select value={sortMode} onChange={e => setSortMode(e.target.value as typeof sortMode)} aria-label="指数排序"
            className="mb-2 w-full rounded-btn border border-border bg-base px-2 py-1 text-xs text-foreground">
            <option value="manual">手动顺序</option><option value="codeAsc">代码升序</option><option value="codeDesc">代码降序</option>
            <option value="pctAsc">涨跌幅升序</option><option value="pctDesc">涨跌幅降序</option>
          </select>
          <div className="space-y-1">
            {sortedRows.map(renderIndexItem)}
          </div>
        </aside>

        <main className="min-w-0 rounded-card border border-border bg-surface p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-accent" />
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {selectedInfo?.name || selectedSymbol || '未选择指数'}
                </h2>
                {selectedSymbol && <span className="font-mono text-xs text-muted">{selectedSymbol}</span>}
                {selectedSymbol && <span className="font-mono text-xs text-foreground">{fmtNum(selectedQuoteValue)}</span>}
                {selectedSymbol && <span className={`font-mono text-xs ${Number(selectedQuotePct ?? 0) >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtPct(selectedQuotePct)}</span>}
              </div>
              <div className="mt-1 text-xs text-muted">
                实时缓存 {quotes.data?.count ?? 0} 只指数 · 日K来源 {daily.data?.source ?? '--'}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <input
                type="date"
                value={range.start}
                onChange={e => setRange(r => ({ ...r, start: e.target.value }))}
                className="rounded-btn border border-border bg-base px-2 py-1 text-secondary outline-none focus:border-accent"
              />
              <span className="text-muted">至</span>
              <input
                type="date"
                value={range.end}
                onChange={e => setRange(r => ({ ...r, end: e.target.value }))}
                className="rounded-btn border border-border bg-base px-2 py-1 text-secondary outline-none focus:border-accent"
              />
            </div>
          </div>

          {daily.isLoading && <div className="py-10 text-center text-sm text-muted">日K加载中…</div>}
          {daily.isError && <div className="py-4 text-sm text-danger">指数日K加载失败</div>}
          {!daily.isLoading && !daily.isError && chartRows.length === 0 && (
            <div className="rounded-card bg-elevated p-6 text-center text-sm text-muted">
              暂无日K数据。可以先同步指数日K，或选择其他指数。
            </div>
          )}
          {chartRows.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-3 text-xs text-secondary">
              {MA_PERIODS.map(period => <label key={period} className="flex cursor-pointer items-center gap-1">
                <input type="checkbox" checked={visibleMAs.includes(period)}
                  onChange={() => saveVisibleMAs(visibleMAs.includes(period) ? visibleMAs.filter(p => p !== period) : [...visibleMAs, period])} />
                MA{period}
              </label>)}
            </div>
          )}
          {chartRows.length > 0 && (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <EChartsCandlestick
                  data={visibleChartRows}
                  height={620}
                  showMA={true}
                  showInfoBar={true}
                  showMarkers={false}
                  symbol={selectedSymbol}
                  linkedPrice={linkedPrice}
                  onDateClick={(date) => {
                    setSelectedDate(date)
                    setLinkedPrice(null)
                  }}
                  visibleBars={48}
                  activeIndicators={['vol', 'macd']}
                />
              </div>
              <div className="min-w-0 flex-1 border-l border-border pl-3" style={{ height: 620 }}>
                <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                  <span className="text-secondary">{useLicensedMinute ? selectedDate : publicMinute.data?.display_date ?? selectedDate ?? '今日'} 分时 · {useLicensedMinute ? '已配置分钟数据源' : minuteSource === 'configured' ? '已配置分钟源暂无数据' : '东方财富公开行情（可能延迟）'}</span>
                  <button type="button" onClick={() => setSelectedDate(chartRows[chartRows.length - 1]?.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))}
                    className="shrink-0 text-accent hover:underline">今日分时</button>
                </div>
                <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                  <label htmlFor="index-minute-source">分时接口</label>
                  <select id="index-minute-source" value={minuteSource} onChange={event => setMinuteSource(event.target.value as typeof minuteSource)}
                    className="rounded-btn border border-border bg-base px-2 py-1 text-foreground">
                    <option value="auto">自动：优先已配置分钟源</option>
                    <option value="configured">仅已配置分钟源</option>
                    <option value="public">仅东方财富公开源</option>
                  </select>
                  <a href="/quant/settings?tab=data-sources" className="text-accent hover:underline">配置分钟源</a>
                </div>
                <div className="mb-1 flex flex-wrap gap-1" aria-label="分钟图周期">
                  {[1, 5, 10, 15, 30, 60].map(value => <button key={value} type="button" aria-pressed={minutePeriod === value}
                    onClick={() => setMinutePeriod(value)} className={`rounded px-2 py-0.5 text-xs ${minutePeriod === value ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-elevated'}`}>
                    {value}分
                  </button>)}
                </div>
                <div className="mb-1 flex flex-wrap items-center gap-1 text-[11px]" aria-label="分钟图范围">
                  <span className="text-muted">范围</span>
                  {[1, 5, 10, 20].map(value => <button key={value} type="button" aria-pressed={minuteDays === value}
                    onClick={() => setMinuteDays(value)} className={`rounded px-2 py-0.5 ${minuteDays === value ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-elevated'}`}>
                    {value === 1 ? '当日' : `近${value}日`}
                  </button>)}
                  {minuteDays > 1 && <span className="text-[10px] text-muted">历史分钟按交易日合并展示</span>}
                </div>
                {((minuteSource !== 'public' && minute.isLoading) || (minuteSource !== 'configured' && publicMinute.isLoading)) && <div className="py-2 text-xs text-muted">分时加载中…</div>}
                {minuteRows.length === 0 && !(minuteSource !== 'public' && minute.isLoading) && !(minuteSource !== 'configured' && publicMinute.isLoading) && (
                  <div className="flex h-[530px] flex-col items-center justify-center gap-2 text-center text-xs text-muted">
                    <span>{minuteSource === 'configured' && !hasMinuteCap ? '当前未检测到已配置的分钟权限' : minuteSource === 'configured' && minute.isError ? '已配置分钟源请求失败' : publicMinute.isError ? '公开分时源请求失败' : '该日期暂无可用分时数据'}</span>
                    <span>公开源仅提供最近几个交易日；历史日需在「设置 → 数据源」配置分钟 K 接口。</span>
                    {!!publicMinute.data?.latest_available_date && <span>公开源最新日期：{publicMinute.data.latest_available_date}</span>}
                    <a href="/quant/settings?tab=data-sources" className="text-accent hover:underline">打开数据源设置</a>
                  </div>
                )}
                {minuteDays > 1 && multiDayMinuteRows.length > 0 && <EChartsMultiDayIntraday data={multiDayMinuteRows} height={550} />}
                {minuteDays === 1 && minuteRows.length > 0 && (
                  minutePeriod === 1 ? <EChartsIntraday
                    key={`${selectedSymbol}:${selectedDate}:${useLicensedMinute ? 'configured' : 'public'}`}
                    data={minuteRows}
                    height={550}
                    prevClose={useLicensedMinute ? prevClose : Number(publicMinute.data?.prev_close ?? prevClose)}
                    date={useLicensedMinute ? selectedDate ?? undefined : publicMinute.data?.display_date ?? selectedDate ?? undefined}
                    showLimitLines={false}
                    showAvgLine={hasPublicAverage}
                    averagePrices={hasPublicAverage ? publicAveragePrices : undefined}
                    onPriceHover={setLinkedPrice}
                  /> : <EChartsCandlestick data={periodRows} height={550} showMA={false} showInfoBar={false}
                    showMarkers={false} activeIndicators={['vol']} visibleBars="all" />
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
