import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { Link } from 'react-router-dom'
import { getFontScale } from '@/lib/fontScale'

type FlowRow = { time: string; main: number; super: number; big: number; medium: number; small: number }
type RankedSector = { code: string; name: string; net_yi: number; pct: number | null }
type FlowData = {
  mode: 'market' | 'sector'; sector: string | null; sector_name: string | null
  rows: FlowRow[]; latest_time: string; fetched_at: string
  is_today: boolean; stale: boolean; source: string
  inflow: RankedSector[]; outflow: RankedSector[]
}
type HistoryData = Pick<FlowData, 'mode' | 'sector' | 'rows' | 'latest_time' | 'fetched_at' | 'stale' | 'source'>
type DayResponse = ({ status: 'ok'; date: string } & HistoryData) | { status: 'not_recorded'; date: string; rows: []; notice: string }
type PriceBar = { time: string; open: number; high: number; low: number; close: number; volume: number; pct: number | null }
type KlinePeriod = 'daily' | '1m' | '5m' | '15m'
type KlineData = { sector: string; name: string; period: KlinePeriod; rows: PriceBar[]; latest_time: string; fetched_at: string; stale: boolean; source: string }

const seriesInfo = [
  { key: 'main', label: '主力', color: '#6ea8ff' },
  { key: 'super', label: '超大单', color: '#f5b95e' },
  { key: 'big', label: '大单', color: '#f46c80' },
  { key: 'medium', label: '中单', color: '#a489ed' },
  { key: 'small', label: '小单', color: '#37c3a6' },
] as const

function formatYi(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)} 亿`
}

function FlowChart({ data, compact = false, historical = false, onSelectDate }: { data: FlowData | HistoryData; compact?: boolean; historical?: boolean; onSelectDate?: (date: string) => void }) {
  const holder = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = holder.current
    if (!element) return
    const chart = echarts.init(element, undefined, { renderer: 'canvas' })
    const textScale = getFontScale()
    const zoomStart = historical && data.rows.length > 60 ? 100 - 6000 / data.rows.length : 0
    chart.setOption({
      backgroundColor: 'transparent',
      color: seriesInfo.map(x => x.color),
      animation: false,
      grid: { left: 58, right: 18, top: 44, bottom: 56 },
      legend: {
        top: 4, left: 4, textStyle: { color: '#a7b5c8', fontSize: Math.round(13 * textScale) },
        selected: data.mode === 'sector' ? { 主力: true, 超大单: false, 大单: false, 中单: false, 小单: false } : undefined,
      },
      tooltip: {
        trigger: 'axis', backgroundColor: '#101c2b', borderColor: '#334357',
        textStyle: { color: '#e8f0fa', fontSize: Math.round(13 * textScale) }, valueFormatter: (value: unknown) => formatYi(Number(value)),
      },
      xAxis: {
        type: 'category', boundaryGap: false,
        data: data.rows.map(x => historical ? x.time.slice(5) : x.time.slice(11)),
        axisLabel: { color: '#8396ad', fontSize: Math.round(12 * textScale), interval: Math.max(1, Math.floor((historical ? Math.min(data.rows.length, 60) : data.rows.length) / 7)) },
        axisLine: { lineStyle: { color: '#334357' } }, axisTick: { show: false },
      },
      yAxis: {
        type: 'value', name: '亿元', nameTextStyle: { color: '#8396ad', fontSize: Math.round(12 * textScale) },
        axisLabel: { color: '#8396ad', fontSize: Math.round(12 * textScale) },
        splitLine: { lineStyle: { color: '#243448', type: 'dashed' } },
      },
      dataZoom: [
        { type: 'inside', start: zoomStart, end: 100 },
        { type: 'slider', start: zoomStart, end: 100, height: 16, bottom: 9, borderColor: '#334357', textStyle: { color: '#8396ad' },
          fillerColor: 'rgba(64,122,204,.18)', backgroundColor: '#142234', showDetail: false },
      ],
      series: seriesInfo.map(x => ({
        name: x.label, type: 'line' as const, showSymbol: false, smooth: false,
        lineStyle: { width: x.key === 'main' ? 2.5 : 1.5 },
        data: data.rows.map(row => row[x.key]),
      })),
    })
    if (historical && onSelectDate) chart.on('click', params => {
      const selected = data.rows[params.dataIndex]
      if (selected) onSelectDate(selected.time.slice(0, 10))
    })
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(element)
    const refreshFont = () => {
      const scale = getFontScale()
      chart.setOption({
        legend: { textStyle: { fontSize: Math.round(13 * scale) } },
        tooltip: { textStyle: { fontSize: Math.round(13 * scale) } },
        xAxis: { axisLabel: { fontSize: Math.round(12 * scale) } },
        yAxis: { axisLabel: { fontSize: Math.round(12 * scale) }, nameTextStyle: { fontSize: Math.round(12 * scale) } },
      })
      chart.resize()
    }
    window.addEventListener('resize', refreshFont)
    return () => { window.removeEventListener('resize', refreshFont); observer.disconnect(); chart.dispose() }
  }, [data, historical, onSelectDate])
  return <div ref={holder} className={compact ? 'h-[220px] w-full' : 'h-[310px] w-full'} role="img" aria-label={`${historical ? '历史每日' : '当日分时'}资金净流入曲线，单位亿元`} />
}

function SectorKline({ sector, compact }: { sector: string; compact: boolean }) {
  const [period, setPeriod] = useState<KlinePeriod>('daily')
  const [data, setData] = useState<KlineData | null>(null)
  const [error, setError] = useState('')
  const holder = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    setData(null)
    const load = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const response = await fetch(`/quant/api/myagent/fund-flow/sector-kline?sector=${sector}&period=${period}&days=120`, { credentials: 'include' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.detail || `板块行情请求失败 ${response.status}`)
        if (active) { setData(body as KlineData); setError('') }
      } catch (err) { if (active) setError((err as Error).message) }
    }
    void load()
    const timer = window.setInterval(() => void load(), period === 'daily' ? 300_000 : 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [sector, period])
  useEffect(() => {
    const element = holder.current
    if (!element || !data?.rows.length) return
    const chart = echarts.init(element, undefined, { renderer: 'canvas' })
    const daily = data.period === 'daily'
    chart.setOption({ animation: false, backgroundColor: 'transparent',
      grid: { left: 60, right: 16, top: 25, bottom: 55 },
      tooltip: { trigger: 'axis', backgroundColor: '#101c2b', borderColor: '#334357', textStyle: { color: '#e8f0fa' } },
      xAxis: { type: 'category', data: data.rows.map(x => x.time.slice(5)),
        axisLabel: { color: '#8396ad', interval: Math.max(1, Math.floor(data.rows.length / 7)) }, axisLine: { lineStyle: { color: '#334357' } } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#8396ad' }, splitLine: { lineStyle: { color: '#243448', type: 'dashed' } } },
      dataZoom: [{ type: 'inside', start: daily ? 55 : 0, end: 100 },
        { type: 'slider', height: 15, bottom: 10, start: daily ? 55 : 0, end: 100, showDetail: false }],
      series: [{ name: daily ? '日K' : `${data.period} K`, type: 'candlestick', data: data.rows.map(x => [x.open, x.close, x.low, x.high]),
        itemStyle: { color: '#ef5968', color0: '#21bf93', borderColor: '#ef5968', borderColor0: '#21bf93' } }],
    })
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(element)
    return () => { observer.disconnect(); chart.dispose() }
  }, [data])
  return <section className="mt-3 rounded-card border border-border bg-base/40 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">{data?.name || sector} · 板块行情</h3><p className="text-xs text-muted">{data?.source || '东方财富公开板块行情'} · {data?.latest_time || '读取中'}{data?.stale ? ' · 缓存' : ''}</p></div>
      <div className="flex gap-1 text-xs">{(['daily', '1m', '5m', '15m'] as const).map(value => <button key={value} type="button" onClick={() => setPeriod(value)} className={`rounded border px-2 py-1 ${period === value ? 'border-accent text-accent' : 'border-border'}`}>{value === 'daily' ? '日K' : value === '1m' ? '1分K' : value === '5m' ? '5分K' : '15分K'}</button>)}</div></div>
    {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    {data?.rows.length ? <div ref={holder} className={compact ? 'h-[240px] w-full' : 'h-[340px] w-full'} role="img" aria-label={`${data.name}${period === 'daily' ? '日K' : `${period} K`}行情图`} /> : <p className="py-8 text-center text-xs text-muted">{error || '正在读取板块行情…'}</p>}
    <p className="text-xs text-muted">获取于 {data?.fetched_at?.slice(11, 19) || '—'}；{period === 'daily' ? '当日日K可能尚未收盘。' : '分钟K时间为区间标记，最后一根可能尚未完成。'}</p>
  </section>
}

export function FundFlowPanel({ compact = false }: { compact?: boolean }) {
  const [sector, setSector] = useState<string | null>(null)
  const [sectorName, setSectorName] = useState('')
  const [view, setView] = useState<'intraday' | 'history'>('intraday')
  const [days, setDays] = useState(60)
  const [data, setData] = useState<FlowData | null>(null)
  const [history, setHistory] = useState<HistoryData | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [dayCurve, setDayCurve] = useState<DayResponse | null>(null)
  const [dayLoading, setDayLoading] = useState(false)
  const [dayError, setDayError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [trackedSectors, setTrackedSectors] = useState<{ code: string; name: string }[]>(() => {
    try { return JSON.parse(localStorage.getItem('fund-flow-tracked-sectors') || '[]') }
    catch { return [] }
  })
  const toggleTracked = (item: RankedSector) => {
    const next = trackedSectors.some(row => row.code === item.code)
      ? trackedSectors.filter(row => row.code !== item.code)
      : [...trackedSectors, { code: item.code, name: item.name }].slice(-6)
    setTrackedSectors(next)
    localStorage.setItem('fund-flow-tracked-sectors', JSON.stringify(next))
  }

  useEffect(() => {
    let active = true
    const load = async () => {
      if (document.visibilityState === 'hidden') return
      setLoading(true)
      try {
        const query = sector ? `?sector=${encodeURIComponent(sector)}` : ''
        const response = await fetch(`/quant/api/myagent/fund-flow/live${query}`, { credentials: 'include' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.detail || `资金流请求失败 ${response.status}`)
        if (active) { setData(body as FlowData); setError('') }
      } catch (err) {
        if (active) setError((err as Error).message)
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [sector, revision])

  useEffect(() => {
    if (view !== 'history') return
    let active = true
    setHistoryLoading(true)
    setHistory(null)
    const load = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const query = new URLSearchParams({ days: String(days) })
        if (sector) query.set('sector', sector)
        const response = await fetch(`/quant/api/myagent/fund-flow/history?${query}`, { credentials: 'include' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.detail || `历史资金请求失败 ${response.status}`)
        if (active) { setHistory(body as HistoryData); setHistoryError('') }
      } catch (err) { if (active) setHistoryError((err as Error).message) }
      finally { if (active) setHistoryLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [view, sector, days, revision])

  useEffect(() => { setSelectedDate(null); setDayCurve(null) }, [sector, days])

  useEffect(() => {
    if (view !== 'history' || !selectedDate) return
    let active = true
    setDayLoading(true)
    setDayCurve(null)
    const load = async () => {
      try {
        const query = new URLSearchParams({ date: selectedDate })
        if (sector) query.set('sector', sector)
        const response = await fetch(`/quant/api/myagent/fund-flow/day?${query}`, { credentials: 'include' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.detail || `单日资金请求失败 ${response.status}`)
        if (active) { setDayCurve(body as DayResponse); setDayError('') }
      } catch (err) { if (active) setDayError((err as Error).message) }
      finally { if (active) setDayLoading(false) }
    }
    void load()
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const timer = selectedDate === today ? window.setInterval(() => void load(), 60_000) : undefined
    return () => { active = false; if (timer) window.clearInterval(timer) }
  }, [view, selectedDate, sector, revision])

  const activeData = view === 'history' ? history : data
  const latest = activeData?.rows[activeData.rows.length - 1]
  const rank = (items: RankedSector[], title: string) => <div className="min-w-0 rounded-card border border-border bg-base/40 p-3">
    <h3 className="mb-2 text-xs font-semibold">{title} <span className="font-normal text-muted">{items.length} 个板块</span></h3>
    <div className={compact ? 'max-h-[170px] overflow-y-auto overscroll-contain pr-1' : 'max-h-[420px] overflow-y-auto'}>{items.length ? items.slice(0, compact ? 8 : undefined).map(x => <div key={x.code} className={`flex items-center gap-1 border-t border-border py-1.5 text-xs ${sector === x.code ? 'text-accent' : ''}`}>
      <button type="button" onClick={() => { setSector(x.code); setSectorName(x.name) }} className="min-w-0 flex-1 truncate text-left hover:text-accent">{x.name}</button>
      <span className={x.pct == null ? 'text-muted' : Number(x.pct) >= 0 ? 'text-danger' : 'text-success'}>{x.pct == null ? '—' : `${Number(x.pct) > 0 ? '+' : ''}${Number(x.pct).toFixed(2)}%`}</span>
      <span className={x.net_yi >= 0 ? 'text-danger' : 'text-success'}>{formatYi(x.net_yi)}</span>
      <button type="button" aria-label={`${trackedSectors.some(row => row.code === x.code) ? '移除' : '添加'}${x.name}曲线`} onClick={() => toggleTracked(x)} className="w-5 rounded border border-border text-accent hover:bg-elevated">{trackedSectors.some(row => row.code === x.code) ? '−' : '+'}</button>
    </div>) : <p className="text-xs text-muted">暂无板块排行</p>}</div>
  </div>

  return <section className={`${compact ? 'h-full overflow-auto' : 'mb-3'} rounded-card border border-border bg-surface p-3`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="text-sm font-semibold">资金流向 · {sector ? data?.sector_name || sectorName || sector : '沪深两市'}</h2>
        <p className="mt-1 text-xs text-muted">{view === 'history' ? '东方财富历史日资金流' : data?.source || '东方财富公开延迟资金流'} · 盘中每 60 秒检查更新 · 曲线可缩放、悬停查看</p></div>
      <div className="flex items-center gap-2 text-xs">
        {compact && <Link to="/fund-flow" className="rounded-btn border border-border px-2 py-1 text-accent">展开</Link>}
        {sector && <button className="rounded-btn border border-border px-2 py-1" onClick={() => { setSector(null); setSectorName('') }}>返回大盘</button>}
        <button className="rounded-btn border border-border px-2 py-1" onClick={() => setRevision(x => x + 1)} disabled={loading}>刷新</button>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs"><span className="text-muted">资金视图</span>
      <button type="button" onClick={() => setView('intraday')} className={`rounded border px-2 py-1 ${view === 'intraday' ? 'border-accent text-accent' : 'border-border'}`}>盘中分时</button>
      <button type="button" onClick={() => setView('history')} className={`rounded border px-2 py-1 ${view === 'history' ? 'border-accent text-accent' : 'border-border'}`}>历史日线</button>
      {view === 'history' && <select aria-label="历史资金天数" value={days} onChange={event => setDays(Number(event.target.value))} className="rounded border border-border bg-base px-2 py-1"><option value={20}>近20交易日</option><option value={60}>近60交易日</option><option value={120}>近120交易日</option></select>}
    </div>
    {error && <p className="mt-2 rounded border border-danger/40 p-2 text-xs text-danger">盘中数据：{error}</p>}
    {activeData ? <>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-y border-border py-2 text-xs">
        <span className="text-muted">{view === 'history' ? '已完成交易日历史' : data?.is_today ? '今日盘中数据' : '最近交易日快照'}{activeData.stale ? ' · 缓存数据' : ''}</span>
        <span>数据截至 {activeData.latest_time}</span><span className="text-muted">获取于 {activeData.fetched_at.slice(11, 19)}</span>
        <span className={Number(latest?.main) >= 0 ? 'text-danger' : 'text-success'}>主力净额 {formatYi(latest?.main)}</span>
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_250px]">
        <div className="min-w-0"><FlowChart data={activeData} compact={compact} historical={view === 'history'} onSelectDate={view === 'history' ? setSelectedDate : undefined} />
          <p className="text-xs text-muted">主力净额 = 超大单 + 大单；历史为每日净额，盘中为当日累计净额。公开源估算口径可能与同花顺不同。</p></div>
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-1 xl:content-start">{rank(data?.inflow ?? [], '板块资金流入')}{rank(data?.outflow ?? [], '板块资金流出')}</div>
      </div>
      {view === 'history' && <div className="mt-3 rounded-card border border-border bg-base/40 p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <h3 className="mr-2 text-sm font-semibold">单日盘中资金走势</h3>
          <label htmlFor="fund-flow-day" className="text-muted">选择交易日</label>
          <select id="fund-flow-day" value={selectedDate ?? ''} onChange={event => setSelectedDate(event.target.value || null)} className="rounded border border-border bg-base px-2 py-1">
            <option value="">请选择</option>
            {[...(data?.is_today ? [data.latest_time.slice(0, 10)] : []), ...history!.rows.map(row => row.time.slice(0, 10))].filter((date, index, all) => all.indexOf(date) === index).reverse().map(date => <option key={date} value={date}>{date}</option>)}
          </select>
          <span className="text-muted">也可点击上方历史曲线选日</span>
        </div>
        {selectedDate && (dayLoading ? <p className="py-6 text-center text-xs text-muted">正在读取 {selectedDate} 分钟资金记录…</p>
          : dayError ? <p className="py-6 text-center text-xs text-danger">{dayError}</p>
          : dayCurve?.status === 'ok' ? <><p className="mt-2 text-xs text-muted">{selectedDate} · {dayCurve.source} · 截至 {dayCurve.latest_time.slice(11)} · 记录 {dayCurve.rows.length} 分钟</p><FlowChart data={dayCurve} compact={compact} /></>
          : <p className="py-6 text-center text-xs text-muted">{dayCurve?.notice || '该日暂无分钟资金记录'}</p>)}
        {!selectedDate && <p className="py-6 text-center text-xs text-muted">选择交易日后查看真实分钟资金曲线。</p>}
      </div>}
    </> : <div className="flex h-56 items-center justify-center text-xs text-muted">{view === 'history' ? historyLoading ? '正在读取历史资金流…' : historyError || '暂无历史资金流' : loading ? '正在加载资金流向…' : '暂无可用资金流数据'}</div>}
    {trackedSectors.length > 0 && <div className="mt-3 max-h-[360px] overflow-y-auto overscroll-contain rounded-card border border-border bg-base/30 p-2"><div className="mb-1 text-xs font-semibold">自选资金曲线</div>{trackedSectors.map(item => <SectorKline key={item.code} sector={item.code} compact={compact} />)}</div>}
    {sector && !trackedSectors.some(item => item.code === sector) && <SectorKline key={sector} sector={sector} compact={compact} />}
  </section>
}
