import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { createPortal } from 'react-dom'
import * as echarts from 'echarts'
import { api } from '@/lib/api'
import { getPageScale } from '@/lib/pageZoom'
import { setUiPref } from '@/lib/uiPrefs'
import { usePreferences } from '@/lib/useSharedQueries'

const API = '/quant/api/myagent/quant'
const PUBLIC_API = '/quant/api/myagent'
type Bar = { datetime: string; close: number; high: number; low: number; volume?: number; amount?: number | null }
type Holding = { symbol: string; name: string; holding_source?: string | null; quantity?: number | null;
  price?: number | null; prev_close?: number | null; change_pct?: number | null; market_timestamp?: string | number | null;
  board?: { name: string; code: string } | null }
type Board = { board?: { name: string; code: string }; rows: Bar[]; flow?: { datetime: string; main_yi: number }[];
  flow_status?: string; source?: string; last_market_time?: string }
type MinuteQuality = { row_count: number; duplicate_timestamps: number; sorted: boolean; valid: boolean }
type News = { items: { title: string; url: string; source: string; published_at?: string; sector_names: string[];
  bias: string }[] }
type Trade = { fingerprint: string; trade_date: string; trade_time: string; symbol: string; side: 'buy' | 'sell';
  quantity: number; price: string; commission: string; cash_flow: string; source: string; verified: boolean }
type History = { trades: Trade[]; account_snapshot: { total_assets: string; position_value: string;
  cash_available: string; total_pnl: string; day_pnl: string; source: string; verified: number } | null;
  trade_summary: { trade_count: number; total_fees: string; realised_t_pnl: string; method: string; notice: string;
    items: { symbol: string; buy_quantity: number; sell_quantity: number; net_quantity: number; matched_quantity: number;
      unmatched_buy_quantity: number; unmatched_sell_quantity: number; realised_t_pnl: string; total_fees: string }[] };
  notice: string }
type PortfolioSnapshot = { items: Holding[]; source: string; account_source?: string | null; account_verified?: boolean }
type Replay = { actual_vs_no_trade: string; realised_t_pnl: string; extra_position_effect: string;
  max_drawdown_yuan: string; max_drawdown_pct_of_snapshot_assets: string | null; hindsight_optimal_pnl: string;
  hindsight_quantity: number | null;
  fill_validation: { checked: number; within_range: number }; notice: string;
  items: { symbol: string; source?: string; minute_count: number; actual_vs_no_trade: string | null;
    realised_t_pnl: string; extra_position_effect: string | null; hindsight_optimal_pnl: string | null }[] }
type Panel = 'chart' | 'board' | 'flow' | 'news' | 'signal'
type LayoutMode = 'side' | 'strip' | 'grid'
const PANEL_LABEL: Record<Panel, string> = { chart: '个股分时', board: '关联板块', flow: '资金流向', news: '关联新闻', signal: '做T观察' }
const defaults: Record<Panel, boolean> = { chart: true, board: true, flow: true, news: true, signal: true }

function usableBoardName(name?: string | null) {
  const text = String(name || '').trim()
  return Boolean(text) && !/(季报|年报|中报|首亏|预亏|预增|扭亏|公告|减持|增持|重组|摘帽)/.test(text)
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`)
  return body as T
}
function marketDay() {
  const day = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() - 1)
  return day.toLocaleDateString('en-CA')
}
function tradingNow() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
  const m = now.getHours() * 60 + now.getMinutes()
  return now.getDay() > 0 && now.getDay() < 6 && ((m >= 570 && m <= 690) || (m >= 780 && m <= 900))
}
const pct = (n?: number | null) => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
const price = (n?: number | null) => n == null ? '—' : n.toFixed(3)
const dateOf = (s: string) => s.slice(0, 10)
function quoteDate(item?: Holding) {
  const t = item?.market_timestamp
  if (typeof t === 'number') return new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  return typeof t === 'string' ? t.slice(0, 10) : ''
}
function isWeekday(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const weekday = new Date(`${day}T12:00:00+08:00`).getDay()
  return weekday > 0 && weekday < 6
}
function loadVisible(): Record<Panel, boolean> {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('portfolio-terminal-visible') || '{}') } }
  catch { return defaults }
}
function loadObject<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || '') as T } catch { return fallback }
}
function previousWeekdays(day: string, count: number): string[] {
  const date = new Date(`${day}T12:00:00+08:00`)
  const out: string[] = []
  while (out.length < count) {
    date.setDate(date.getDate() - 1)
    if (date.getDay() !== 0 && date.getDay() !== 6) out.push(date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))
  }
  return out
}

function TimeChart({ rows, title, color, height, multiDay = false, previousCloses = {}, trades = [] }: {
  rows: Bar[]; title: string; color: string; height: number; multiDay?: boolean;
  previousCloses?: Record<string, number | null>; trades?: Trade[]
}) {
  const ref = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<{ start: number; end: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const effectiveHeight = expanded ? Math.max(620, window.innerHeight - 150) : height
  useEffect(() => { zoomRef.current = null }, [title])
  useEffect(() => {
    if (!ref.current || !rows.length) return
    const chart = echarts.init(ref.current)
    const labels = rows.map(row => row.datetime.slice(0, 16))
    const prices = rows.map(row => Number(row.close))
    chart.setOption({
      animation: false, backgroundColor: 'transparent',
      grid: [{ left: 55, right: 18, top: 12, bottom: 65 }, { left: 55, right: 18, top: effectiveHeight - 42, bottom: 28 }],
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'cross', label: { backgroundColor: '#223047' } },
        backgroundColor: '#101a2a', borderColor: '#4b5b76', textStyle: { color: '#e8eef8', fontSize: 12 },
        formatter: (params: unknown) => {
          const first = Array.isArray(params) ? params[0] as { dataIndex?: number } : null
          const i = first?.dataIndex
          const row = i == null ? null : rows[i]
          if (!row) return ''
          const reference = previousCloses[dateOf(row.datetime)] ?? rows.slice(0, i).reverse()
            .find(previous => dateOf(previous.datetime) !== dateOf(row.datetime))?.close
          const delta = reference ? row.close - reference : null
          const change = reference ? delta! / reference * 100 : null
          const volume = row.volume == null ? '—' : Number(row.volume).toLocaleString('zh-CN')
          const amount = row.amount == null ? '—' : Number(row.amount).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
          return `<b>${row.datetime.slice(0, 16)}</b><br/>最新 ${row.close.toFixed(3)}<br/>涨跌 ${delta == null ? '—' : delta.toFixed(3)} · 涨幅 ${pct(change)}<br/>最高 ${row.high.toFixed(3)} · 最低 ${row.low.toFixed(3)}<br/>成交量 ${volume}<br/>成交额 ${amount}`
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [
        { type: 'category', data: labels, boundaryGap: false, axisLabel: { color: '#9ca3af', formatter: (v: string) => multiDay ? v.slice(5, 16) : v.slice(11, 16), hideOverlap: true }, axisLine: { lineStyle: { color: '#394354' } } },
        { type: 'category', gridIndex: 1, data: labels, boundaryGap: false, axisLabel: { show: false } },
      ],
      yAxis: [{ type: 'value', scale: true, axisLabel: { color: '#9ca3af' }, splitLine: { lineStyle: { color: '#273243' } } },
        { type: 'value', gridIndex: 1, scale: true, axisLabel: { show: false }, splitLine: { show: false } }],
      dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: zoomRef.current?.start ?? (multiDay ? 75 : 0), end: zoomRef.current?.end ?? 100, zoomOnMouseWheel: true, moveOnMouseWheel: true },
        { type: 'slider', xAxisIndex: [0, 1], bottom: 0, height: 17, start: zoomRef.current?.start ?? (multiDay ? 75 : 0), end: zoomRef.current?.end ?? 100 }],
      series: [{ name: '价格', type: 'line', data: prices, showSymbol: false, lineStyle: { width: 2, color }, itemStyle: { color }, areaStyle: { color, opacity: 0.08 }, connectNulls: false,
        markPoint: { symbolSize: 24, data: trades.filter(trade => labels.includes(`${trade.trade_date} ${trade.trade_time}`))
          .map(trade => ({ name: trade.side === 'buy' ? '买入' : '卖出',
            coord: [`${trade.trade_date} ${trade.trade_time}`, Number(trade.price)],
            value: trade.side === 'buy' ? '买' : '卖',
            itemStyle: { color: trade.side === 'buy' ? '#ef5350' : '#24ba91' },
            label: { color: '#fff', fontSize: 11, fontWeight: 'bold' },
            tooltip: { formatter: `${trade.trade_time} ${trade.side === 'buy' ? '买入' : '卖出'} ${trade.quantity} @${trade.price} · 手续费 ${trade.commission} · ${trade.verified ? '已核验' : '用户记录待核对'}` },
          })) } },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: rows.map(row => row.volume || 0), itemStyle: { color: '#4b647d' }, barMaxWidth: 3 }],
    })
    chart.on('datazoom', () => {
      const zoom = (chart.getOption() as { dataZoom?: { start?: number; end?: number }[] }).dataZoom?.[0]
      if (zoom?.start != null && zoom.end != null) zoomRef.current = { start: zoom.start, end: zoom.end }
    })
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(ref.current)
    return () => { resize.disconnect(); chart.dispose() }
  }, [rows, color, effectiveHeight, multiDay, previousCloses, trades])
  if (!rows.length) return <div style={{ height }} className="flex items-center justify-center text-xs text-muted">{title}暂无该日真实分钟数据</div>
  return <div className={expanded ? 'fixed inset-4 z-[1000] rounded-lg border border-border bg-base p-3 shadow-2xl' : 'relative w-full'}>
    <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
      <span>{title} · 鼠标滚轮缩放，拖动底部滑块浏览</span>
      <button type="button" onClick={() => setExpanded(value => !value)} className="rounded border border-border px-2 py-0.5 text-accent hover:bg-elevated">
        {expanded ? '退出放大' : '放大查看'}
      </button>
    </div>
    <div ref={ref} role="img" aria-label={`${title}可缩放分时图`} style={{ height: effectiveHeight }} className="w-full" />
  </div>
}

function Detail({ item, day, latestBars, minuteSource, news, visible, trades, linkedBoardCode, boardOptions, onLinkedBoardChange }: {
  item: Holding; day: string; latestBars: Bar[]; minuteSource?: string; news: News['items']; visible: Record<Panel, boolean>; trades: Trade[]
  linkedBoardCode?: string; boardOptions: { code: string; name: string; pct?: number | null }[]; onLinkedBoardChange: (code: string) => void
}) {
  const [flowScope, setFlowScope] = useState<'linked' | 'market'>('linked')
  const [boardSearch, setBoardSearch] = useState('')
  const [boardChoiceError, setBoardChoiceError] = useState('')
  const boardListId = `linked-board-${item.symbol.replace(/\W/g, '-')}`
  const boardSearchQuery = useQuery({
    queryKey: ['linked-board-search', boardSearch.trim()],
    queryFn: () => json<{ items: { code: string; name: string; pct?: number | null }[] }>(`${PUBLIC_API}/fund-flow/sectors?q=${encodeURIComponent(boardSearch.trim())}&limit=20`),
    enabled: boardSearch.trim().length >= 1, staleTime: 60_000,
  })
  const boardSuggestions = useMemo(() => {
    const remote = boardSearchQuery.data?.items || []
    if (remote.length) return remote.slice(0, 8)
    const query = boardSearch.trim().toLowerCase()
    return boardOptions.filter(option => `${option.name} ${option.code}`.toLowerCase().includes(query)).slice(0, 8)
  }, [boardSearch, boardSearchQuery.data?.items, boardOptions])
  useEffect(() => {
    const selected = boardOptions.find(option => option.code === linkedBoardCode)
    setBoardSearch(selected ? `${selected.name} (${selected.code})` : '')
    setBoardChoiceError('')
    if (linkedBoardCode && boardOptions.length && !selected) onLinkedBoardChange('')
  }, [item.symbol, linkedBoardCode, boardOptions])
  const applyBoardSearch = () => {
    const raw = boardSearch.trim()
    if (!raw) { onLinkedBoardChange(''); setBoardChoiceError(''); return }
    const code = raw.match(/BK\d{4}/i)?.[0]?.toUpperCase()
    const match = boardOptions.find(option => option.code === code || option.name === raw || raw.includes(option.code))
      || boardOptions.find(option => option.name.includes(raw))
    if (!match) { setBoardChoiceError('未找到该板块，请输入名称或 BK 代码'); return }
    onLinkedBoardChange(match.code); setBoardSearch(`${match.name} (${match.code})`); setBoardChoiceError('')
  }
  const isLatest = day === (quoteDate(item) || marketDay())
  const selectedMinute = useQuery({ queryKey: ['portfolio-selected-minute', item.symbol, day],
    queryFn: () => json<{ rows: Bar[]; source: string }>(`${API}/portfolio/minute/${item.symbol}?trade_date=${day}`),
    enabled: !isLatest || !latestBars.length, staleTime: 60_000, refetchInterval: isLatest && !latestBars.length && tradingNow() ? 60_000 : false })
  const board = useQuery({ queryKey: ['portfolio-board-widget', item.symbol, day],
    queryFn: () => json<Board>(`${API}/portfolio/board/${item.symbol}?trade_date=${day}`),
    staleTime: 30_000, refetchInterval: isLatest && tradingNow() ? 60_000 : false })
  const linkedBoard = useQuery({ queryKey: ['portfolio-linked-board-widget', linkedBoardCode, day], queryFn: () =>
    json<{ name: string; rows: { time: string; close: number; high: number; low: number; volume: number }[]; source: string; latest_time: string }>(
      `${PUBLIC_API}/fund-flow/sector-kline?sector=${encodeURIComponent(linkedBoardCode || '')}&period=1m`),
    enabled: !!linkedBoardCode, staleTime: 30_000, refetchInterval: isLatest && tradingNow() ? 60_000 : false })
  const selectedFlow = useQuery({ queryKey: ['portfolio-selected-flow', flowScope, linkedBoardCode],
    queryFn: () => json<{ rows: { time: string; main: number }[]; source: string; latest_time: string }>(
      `${PUBLIC_API}/fund-flow/live${flowScope === 'linked' && linkedBoardCode ? `?sector=${encodeURIComponent(linkedBoardCode)}` : ''}`),
    enabled: flowScope === 'market' || !!linkedBoardCode, staleTime: 30_000,
    refetchInterval: isLatest && tradingNow() ? 60_000 : false })
  const history = useQuery({ queryKey: ['portfolio-minute-range', item.symbol],
    queryFn: () => api.klineMinuteRange(item.symbol, 20), staleTime: 60_000 })
  const [requestedDays, setRequestedDays] = useState(1)
  const requestedDates = useMemo(() => previousWeekdays(day, requestedDays - 1), [day, requestedDays])
  const fetchedHistory = useQuery({ queryKey: ['portfolio-history-days', item.symbol, day, requestedDays],
    queryFn: async () => {
      const available = new Set((history.data?.sessions || []).map(session => session.date))
      const sessions: { date: string; rows: Bar[] }[] = []
      let failed = 0
      for (const date of requestedDates) {
        if (available.has(date)) continue
        try {
          const result = await json<{ rows: Bar[] }>(`${API}/portfolio/minute/${item.symbol}?trade_date=${date}`)
          if (result.rows.length) sessions.push({ date, rows: result.rows })
        } catch { failed++ }
      }
      return { sessions, failed }
    },
    enabled: requestedDays > 1 && history.isSuccess, staleTime: 5 * 60_000 })
  const stockRows = isLatest && latestBars.length ? latestBars : selectedMinute.data?.rows || []
  const sessions = history.data?.sessions || []
  const previousCloses = useMemo(() => {
    const byDate: Record<string, number | null> = {}
    for (const session of sessions) byDate[session.date] = session.prev_close
    if (isLatest && item.prev_close != null) byDate[day] = item.prev_close
    return byDate
  }, [sessions, isLatest, item.prev_close, day])
  const historyRows = useMemo(() => {
    const byDate = new Map<string, Bar[]>()
    for (const session of sessions) byDate.set(session.date, session.rows)
    for (const session of fetchedHistory.data?.sessions || []) byDate.set(session.date, session.rows)
    if (stockRows.length) byDate.set(day, stockRows)
    const selectedDates = new Set([day, ...requestedDates])
    return [...byDate].filter(([date]) => selectedDates.has(date)).sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, rows]) => rows)
  }, [sessions, fetchedHistory.data?.sessions, stockRows, day, requestedDates])
  const autoBoardName = usableBoardName(board.data?.board?.name) ? board.data?.board?.name : usableBoardName(item.board?.name) ? item.board?.name : undefined
  const boardName = linkedBoard.data?.name || autoBoardName || '关联行业板块待绑定'
  const boardRows = linkedBoardCode ? (linkedBoard.data?.rows || []).map(row => ({ ...row, datetime: row.time })) : autoBoardName ? (board.data?.rows || []) : []
  const flow = linkedBoardCode ? undefined : board.data?.flow?.at(-1)
  const relatedNews = usableBoardName(boardName) ? news.filter(row => row.sector_names?.some(name => name === boardName || name.includes(boardName) || boardName.includes(name))).slice(0, 5) : []
  const last = stockRows.at(-1), first = stockRows[0], bLast = boardRows.at(-1), bFirst = boardRows[0]
  const stockMove = first && last ? (last.close / first.close - 1) * 100 : null
  const boardMove = bFirst && bLast ? (bLast.close / bFirst.close - 1) * 100 : null
  const recent = stockRows.slice(-20)
  const nearHigh = !!last && recent.length > 0 && last.close >= Math.max(...recent.map(row => row.high)) * .998
  const observation = !last ? '数据不足，暂无做T观察' : boardMove == null ? '板块分钟行情未取得，暂不判断联动'
    : stockMove != null && stockMove > 0 && boardMove > 0 && nearHigh ? '个股与板块同步走强，接近近20分钟高点；留意回落风险'
      : stockMove != null && stockMove < 0 && boardMove < 0 ? '个股与板块同步走弱；等待企稳确认'
        : '个股与板块未形成同步突破；等待下一分钟确认'
  return <div className="min-w-0 space-y-1.5">
    <header className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-base/70 px-2 py-1">
      <div><b className="text-sm">{item.name}</b><span className="ml-2 text-xs text-muted">{item.symbol}</span>
        <span className="ml-2 text-xs text-accent">{price(item.price)}</span>
        <span className={`ml-2 text-xs ${Number(item.change_pct) >= 0 ? 'text-bull' : 'text-bear'}`}>{pct(item.change_pct)}</span></div>
      <div className="flex flex-wrap items-center justify-end gap-1"><label className="text-xs text-muted">关联板块
        <span className="relative ml-1 inline-block"><input aria-label={`${item.name}关联板块搜索`} list={boardListId} value={boardSearch} onChange={event => { setBoardSearch(event.target.value); setBoardChoiceError('') }} onKeyDown={event => { if (event.key === 'Enter') applyBoardSearch() }} placeholder="输入名称或 BK 代码" className="w-52 rounded border border-border bg-base px-1 py-0.5 text-[11px]" />
          {!!boardSearch.trim() && !!boardSuggestions.length && <span className="absolute left-0 top-full z-50 mt-1 block max-h-48 w-72 overflow-auto rounded border border-border bg-surface p-1 shadow-2xl">{boardSuggestions.map(option => <button type="button" key={option.code} onClick={() => { setBoardSearch(`${option.name} (${option.code})`); onLinkedBoardChange(option.code); setBoardChoiceError('') }} className="block w-full px-2 py-1 text-left text-[11px] hover:bg-elevated"><b>{option.name}</b><span className="ml-2 font-mono text-muted">{option.code}</span>{option.pct != null && <span className={`float-right ${option.pct >= 0 ? 'text-bull' : 'text-bear'}`}>{option.pct > 0 ? '+' : ''}{option.pct}%</span>}</button>)}</span>}
        </span><datalist id={boardListId}>{boardOptions.map(option => <option key={option.code} value={`${option.name} (${option.code})`} />)}</datalist></label>
        <button type="button" onClick={applyBoardSearch} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-accent">应用</button>
        <button type="button" onClick={() => { setBoardSearch(''); onLinkedBoardChange(''); setBoardChoiceError('') }} className="px-1 text-[11px] text-muted">自动</button>
        <span className="text-[11px] text-muted">{item.holding_source ? `已录入 ${item.quantity ?? '—'} 股/份` : '监控标的 · 持仓未核实'}</span>
        {boardChoiceError && <span className="basis-full text-right text-[10px] text-danger">{boardChoiceError}</span>}</div>
    </header>
    {visible.chart && <section className="rounded border border-border bg-base/50 p-1.5">
      <div className="flex flex-wrap items-center justify-between gap-1 px-1 text-xs"><b>个股分时 · {day}</b>
        <div className="flex items-center gap-1"><span className="text-muted">历史范围</span>{([1, 5, 10, 20] as const).map(n =>
          <button key={n} type="button" onClick={() => setRequestedDays(n)} className={`rounded px-1 py-0.5 ${requestedDays === n ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-elevated'}`}>{n}日</button>)}</div></div>
      <TimeChart rows={historyRows.length ? historyRows : stockRows} title={item.name} color="#5aaaff" height={260} multiDay={historyRows.length > stockRows.length} previousCloses={previousCloses} trades={trades} />
      <p className="px-1 text-[11px] text-muted">滚轮缩放 · 拖动下方时间条跨日查看 · 鼠标悬停看分钟详情 · 已有 {new Set(historyRows.map(row => dateOf(row.datetime))).size} 个交易日 · 选中日 {stockRows.length} 根 · {last?.datetime || '暂无时间'} · {isLatest ? (minuteSource || selectedMinute.data?.source || '来源未标注') : (selectedMinute.data?.source || minuteSource || '读取中')}</p>
      {history.isError && <p className="px-1 text-[11px] text-warning">跨日缓存读取失败；仍可按日期查看单日。</p>}
      {fetchedHistory.isFetching && <p className="px-1 text-[11px] text-accent">正在按数据源权限补取历史分钟K…</p>}
      {!!fetchedHistory.data?.failed && <p className="px-1 text-[11px] text-warning">{fetchedHistory.data.failed} 个候选日期读取失败，曲线仅展示成功取得的真实数据。</p>}
    </section>}
    {visible.board && <section className="rounded border border-border bg-base/50 p-1.5">
      <div className="flex justify-between gap-1 px-1 text-xs"><b>{boardName} · 板块分时</b><span className="text-muted">{board.data?.source || '数据源待确认'}</span></div>
      <TimeChart rows={boardRows} title={boardName} color="#e3a54d" height={150} />
      <p className="px-1 text-[11px] text-muted">区间涨跌 {pct(boardMove)} · {linkedBoard.data?.latest_time || board.data?.last_market_time || '暂无时间'}；{linkedBoardCode ? `自选板块 ${linkedBoardCode}` : autoBoardName ? '自动关联行业板块' : '请先选择真实行业/指数板块'}</p>
    </section>}
    <div className="grid gap-1.5 lg:grid-cols-2">
      {visible.flow && <section className="rounded border border-border bg-base/50 p-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-1"><b>资金流向</b><select aria-label="资金流向范围" value={flowScope} onChange={event => setFlowScope(event.target.value as 'linked' | 'market')} className="rounded border border-border bg-base px-1 py-0.5"><option value="linked">关联板块</option><option value="market">全市场</option></select></div>
        <p className="mt-1">主力净流 {selectedFlow.data?.latest_time?.slice(0, 10) === day && selectedFlow.data.rows.length
          ? `${selectedFlow.data.rows.at(-1)!.main.toFixed(2)} 亿` : flowScope === 'linked' && !linkedBoardCode && flow ? `${flow.main_yi.toFixed(2)} 亿` : '数据源未接入或该日期无数据'}</p>
        <p className="text-[11px] text-muted">{selectedFlow.data?.source || board.data?.source || '独立资金流供应商'} · {selectedFlow.data?.latest_time || flow?.datetime || '暂无更新时间'}</p>
        <Link to="/fund-flow" className="text-accent">查看完整资金走势 ↗</Link></section>}
      {visible.signal && <section className="rounded border border-border bg-base/50 p-2 text-xs"><b>做T观察</b>
        <p className="mt-1">{observation}</p><p className="text-[11px] text-muted">依据截至 {last?.datetime || '—'} 的分钟价和板块走势；下一分钟可能失效。非买卖指令。</p></section>}
    </div>
    {visible.news && <section className="rounded border border-border bg-base/50 p-2 text-xs"><b>{boardName} · 关联新闻</b>
      {relatedNews.length ? relatedNews.map(row => <a key={row.url} href={row.url} target="_blank" rel="noopener noreferrer"
        className="mt-1 block truncate text-accent" title={row.title}>{row.bias} · {row.title} · {row.source}</a>)
        : <p className="mt-1 text-muted">暂无可核对的板块关联新闻</p>}</section>}
  </div>
}

function BoardDetail({ code, day, news, visible }: { code: string; day: string; news: News['items']; visible: Record<Panel, boolean> }) {
  const quote = useQuery({ queryKey: ['portfolio-custom-board', code], queryFn: () =>
    json<{ name: string; rows: { time: string; close: number; high: number; low: number; volume: number }[]; source: string; latest_time: string }>(
      `${PUBLIC_API}/fund-flow/sector-kline?sector=${code}&period=1m`),
    refetchInterval: tradingNow() ? 60_000 : false })
  const flow = useQuery({ queryKey: ['portfolio-custom-board-flow', code], queryFn: () =>
    json<{ rows: { time: string; main: number }[]; source: string; latest_time: string }>(`${PUBLIC_API}/fund-flow/live?sector=${code}`),
    refetchInterval: tradingNow() ? 60_000 : false })
  const rows = useMemo(() => (quote.data?.rows || []).map(row => ({ ...row, datetime: row.time })), [quote.data?.rows])
  const boardName = quote.data?.name || code
  const availableDay = quote.data?.latest_time?.slice(0, 10)
  const shownRows = day === availableDay ? rows : []
  const relatedNews = news.filter(row => row.sector_names?.some(name => name === boardName || name.includes(boardName) || boardName.includes(name))).slice(0, 5)
  return <div className="min-w-0 space-y-1.5">
    <header className="rounded border border-border bg-base/70 px-2 py-1 text-sm font-semibold">{boardName} <span className="ml-1 font-mono text-xs text-muted">{code}</span></header>
    {visible.board && <section className="rounded border border-border bg-base/50 p-2">
      <div className="flex justify-between text-xs"><b>板块分时</b><span className="text-muted">{quote.data?.source || '读取中'}</span></div>
      <TimeChart rows={shownRows} title={boardName} color="#e3a54d" height={350} />
      <p className="text-[11px] text-muted">数据时点 {quote.data?.latest_time || '—'} · 当前公开接口只提供最近 120 根分钟K；所选历史日无数据时明确留空。</p>
      {quote.isError && <p className="text-xs text-danger">板块行情读取失败，请核对代码或数据源。</p>}
    </section>}
    {visible.flow && <section className="rounded border border-border bg-base/50 p-2 text-xs">
      <b>板块资金流向</b><p className="mt-1">主力净流 {day === flow.data?.latest_time?.slice(0, 10) && flow.data?.rows?.length
        ? `${flow.data.rows.at(-1)!.main.toFixed(2)} 亿` : '该日期数据不可用'}</p>
      <p className="text-[11px] text-muted">{flow.data?.source || '资金流数据源未接入'} · {flow.data?.latest_time || '—'}</p>
    </section>}
    {visible.news && <section className="rounded border border-border bg-base/50 p-2 text-xs"><b>关联新闻</b>
      {relatedNews.length ? relatedNews.map(row => <a key={row.url} href={row.url} target="_blank" rel="noopener noreferrer" className="mt-1 block truncate text-accent">{row.bias} · {row.title} · {row.source}</a>)
        : <p className="mt-1 text-muted">暂无可核对的关联新闻</p>}</section>}
  </div>
}

function HoldingsOverview({ items, minuteData, source, onSelect }: {
  items: Holding[]; minuteData: Record<string, Bar[]>; source?: string; onSelect: (symbol: string) => void
}) {
  return <section className="space-y-2 rounded border border-border bg-base/40 p-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><b className="text-sm">持仓实时总览</b><p className="text-[11px] text-muted">每个标的独立分时图 · 点击卡片进入详情 · {source || '真实分钟行情'}</p></div>
      <span className="text-[11px] text-muted">共 {items.length} 个监控标的</span>
    </div>
    <div className="grid gap-2 xl:grid-cols-2">
      {items.map(item => {
        const rows = minuteData[item.symbol] || []
        const last = rows.at(-1)
        return <div key={item.symbol} role="button" tabIndex={0} onClick={() => onSelect(item.symbol)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect(item.symbol) }} className="min-w-0 cursor-pointer rounded border border-border bg-surface p-1.5 text-left hover:border-accent/70">
          <div className="mb-1 flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold">{item.name}</span><span className={Number(item.change_pct) >= 0 ? 'text-bull' : 'text-bear'}>{pct(item.change_pct)}</span></div>
          <div className="mb-1 flex justify-between text-[10px] text-muted"><span>{item.symbol}</span><span>最新 {last ? price(last.close) : price(item.price)} · {last?.datetime || '暂无分钟数据'}</span></div>
          <TimeChart rows={rows} title={item.name} color={Number(item.change_pct) >= 0 ? '#24ba91' : '#5aaaff'} height={155} />
        </div>
      })}
      {!items.length && <p className="p-3 text-xs text-muted">暂无持仓或监控标的</p>}
    </div>
  </section>
}

function DecisionGuidePanel({ items, minuteData, source }: { items: Holding[]; minuteData: Record<string, Bar[]>; source?: string }) {
  const guides = items.map(item => {
    const rows = minuteData[item.symbol] || []
    const closes = rows.map(row => Number(row.close)).filter(Number.isFinite)
    const last = closes.at(-1)
    const first = closes[0]
    const ma5 = closes.length >= 5 ? closes.slice(-5).reduce((sum, value) => sum + value, 0) / 5 : null
    const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((sum, value) => sum + value, 0) / 20 : null
    const support = rows.length ? Math.min(...rows.slice(-20).map(row => Number(row.low))) : null
    const resistance = rows.length ? Math.max(...rows.slice(-20).map(row => Number(row.high))) : null
    const change = first && last ? (last / first - 1) * 100 : null
    const trend = last == null || ma5 == null ? '数据不足' : last >= ma5 && (ma20 == null || last >= ma20) ? '短线偏强' : last < ma5 && (ma20 == null || last < ma20) ? '短线偏弱' : '震荡观察'
    const action = last == null ? '暂不可判断' : support != null && last <= support * 1.01 ? '接近支撑·等待确认' : resistance != null && last >= resistance * .99 ? '接近压力·防追高' : trend === '短线偏强' ? '持有·观察回踩' : trend === '短线偏弱' ? '暂不操作' : '区间观察'
    return { item, last, change, support, resistance, trend, action, time: rows.at(-1)?.datetime }
  })
  return <aside className="min-w-0 rounded border border-border bg-base/50 p-2 text-xs">
    <div className="flex items-center justify-between gap-2 border-b border-border pb-1"><b>下周关注 / 交易指引</b><span className="text-[10px] text-muted">规则实时更新</span></div>
    <p className="py-1 text-[10px] text-muted">按持仓实时分时生成关注清单；日线、60分钟、15分钟数据未齐时不输出强信号。</p>
    <div className="space-y-1">{guides.map(row => <div key={row.item.symbol} className="rounded border border-border/60 bg-surface px-1.5 py-1">
      <div className="flex justify-between gap-1"><b className="truncate">{row.item.name}</b><span className={row.action.includes('持有') ? 'text-bull' : row.action.includes('暂') || row.action.includes('压力') ? 'text-warning' : 'text-accent'}>{row.action}</span></div>
      <div className="mt-0.5 flex justify-between text-[10px] text-muted"><span>{row.item.symbol} · {row.trend} · {row.change == null ? '—' : pct(row.change)}</span><span>最新 {row.last == null ? price(row.item.price) : price(row.last)}</span></div>
      <div className="mt-0.5 grid grid-cols-2 gap-1 text-[10px] text-muted"><span>支撑 {row.support == null ? '—' : price(row.support)}</span><span>压力 {row.resistance == null ? '—' : price(row.resistance)}</span></div>
    </div>)}</div>
    <p className="mt-1 text-[10px] text-muted">数据源 {source || '—'} · 更新时间 {guides.map(row => row.time).filter(Boolean).sort().at(-1) || '—'} · 仅供研究，不自动下单。</p>
  </aside>
}

export function PortfolioMonitorWidget() {
  const { data: preferences } = usePreferences()
  const splitRef = useRef<HTMLDivElement>(null)
  const [paneWidths, setPaneWidths] = useState(() => loadObject('portfolio-terminal-pane-widths', { left: 175, right: 260 }))
  const resizePane = (side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    const start = paneWidths[side]
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const containerWidth = splitRef.current?.clientWidth || 900
      const delta = (moveEvent.clientX - startX) / getPageScale() * (side === 'left' ? 1 : -1)
      setPaneWidths(current => ({ ...current, [side]: Math.round(Math.max(side === 'left' ? 145 : 210,
        Math.min(containerWidth - current[side === 'left' ? 'right' : 'left'] - 280, start + delta))) }))
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('lostpointercapture', stop)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('lostpointercapture', stop)
  }
  useEffect(() => { setUiPref('portfolio-terminal-pane-widths', JSON.stringify(paneWidths)) }, [paneWidths])
  const snapshot = useQuery({ queryKey: ['portfolio-widget-snapshot'],
    queryFn: () => json<PortfolioSnapshot>(`${API}/portfolio/snapshot`),
    refetchInterval: tradingNow() ? 30_000 : false })
  const items = useMemo(() => snapshot.data?.items || [], [snapshot.data?.items])
  const [selected, setSelected] = useState('')
  const [selectedBoard, setSelectedBoard] = useState('')
  const [viewMode, setViewMode] = useState<'detail' | 'overview'>(() => loadObject('portfolio-terminal-view', 'detail'))
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => loadObject('portfolio-terminal-layout', 'side'))
  const [linkedBoards, setLinkedBoards] = useState<Record<string, string>>(() => loadObject('portfolio-terminal-linked-boards', {}))
  const [extraSymbols, setExtraSymbols] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('portfolio-terminal-extra-symbols') || '[]') }
    catch { return [] }
  })
  const [symbolInput, setSymbolInput] = useState('')
  const [symbolError, setSymbolError] = useState('')
  const [extraSymbolNames, setExtraSymbolNames] = useState<Record<string, string>>(() => loadObject('portfolio-terminal-extra-symbol-names', {}))
  const [boardInput, setBoardInput] = useState('')
  const [boardError, setBoardError] = useState('')
  const [extraBoards, setExtraBoards] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('portfolio-terminal-extra-boards') || '[]') }
    catch { return [] }
  })
  const symbolMatches = useQuery({
    queryKey: ['portfolio-instrument-search', symbolInput.trim()],
    queryFn: () => api.instrumentSearch(symbolInput.trim(), 12, 'stock,etf,index'),
    enabled: symbolInput.trim().length >= 1,
    staleTime: 60_000,
  })
  const sectorCatalog = useQuery({ queryKey: ['fund-flow-sector-catalog'], queryFn: () =>
    json<{ items: { code: string; name: string; pct?: number | null }[]; source: string }>(`${PUBLIC_API}/fund-flow/sectors?limit=1200`), staleTime: 10 * 60_000 })
  const boardOptions = useMemo(() => sectorCatalog.data?.items || [], [sectorCatalog.data?.items])
  const boardMatches = useMemo(() => {
    const query = boardInput.trim().toLowerCase()
    if (!query) return []
    return (sectorCatalog.data?.items || []).filter(item => `${item.code} ${item.name}`.toLowerCase().includes(query)).slice(0, 8)
  }, [boardInput, sectorCatalog.data?.items])
  const allItems = useMemo<Holding[]>(() => [...items, ...extraSymbols.filter(symbol => !items.some(item => item.symbol === symbol))
    .map(symbol => ({ symbol, name: extraSymbolNames[symbol] || symbol + ' · 名称待核对' }))], [items, extraSymbols, extraSymbolNames])
  const active = allItems.find(item => item.symbol === selected) || allItems[0]
  const reportedDay = items.map(quoteDate).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().at(-1) || ''
  // Public close snapshots are fetched on weekends too; their fetch timestamp
  // is not a trading-day timestamp. Never request a Saturday/Sunday minute
  // partition merely because the snapshot was refreshed then.
  const latestDay = isWeekday(reportedDay) ? reportedDay : marketDay()
  const [pickedDay, setPickedDay] = useState('')
  const day = pickedDay || latestDay
  const [hindsightQuantity, setHindsightQuantity] = useState(20000)
  const minute = useQuery({ queryKey: ['portfolio-widget-minute', latestDay],
    queryFn: () => json<{ data: Record<string, Bar[]>; source: string; freshness?: Record<string, { market_time?: string | null; received_at?: string | null; age_seconds?: number | null; stale?: boolean }>; quality?: Record<string, MinuteQuality>; missing_symbols?: string[]; complete?: boolean }>(`${API}/portfolio/minute-batch?trade_date=${latestDay}`),
    enabled: !!items.length, refetchInterval: tradingNow() ? 60_000 : false })
  const news = useQuery({ queryKey: ['myagent-quant-news'], queryFn: () => json<News>(`${API}/news`), refetchInterval: 180_000 })
  const tradeHistory = useQuery({ queryKey: ['portfolio-terminal-history', day],
    queryFn: () => json<History>(`${API}/terminal/history?trade_date=${day}`), staleTime: 60_000 })
  const tradeReplay = useQuery({ queryKey: ['portfolio-terminal-replay', day, hindsightQuantity],
    queryFn: () => json<Replay>(`${API}/terminal/replay?trade_date=${day}&hindsight_quantity=${hindsightQuantity}`),
    enabled: !!tradeHistory.data?.trades.length, staleTime: 5 * 60_000 })
  const [visible, setVisible] = useState(loadVisible)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [listMode, setListMode] = useState<'all' | 'recorded'>('all')
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('click', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', close) }
  }, [menu])
  const toggle = (key: Panel) => {
    const next = { ...visible, [key]: !visible[key] }
    setVisible(next)
    setUiPref('portfolio-terminal-visible', JSON.stringify(next))
    setMenu(null)
  }
  const shown = listMode === 'recorded' ? allItems.filter(item => item.holding_source) : allItems
  const freshnessRows = Object.values(minute.data?.freshness || {})
  const latestFreshness = freshnessRows.find(row => row.market_time) || freshnessRows[0]
  const qualityRows = Object.values(minute.data?.quality || {})
  const badQuality = qualityRows.some(row => row.valid === false) || minute.data?.complete === false
  const usableMinuteData = badQuality ? {} : (minute.data?.data || {})
  const dataState = minute.isError ? '连接失败' : minute.isLoading ? '读取中' : badQuality ? `数据不完整${minute.data?.missing_symbols?.length ? `（缺 ${minute.data.missing_symbols.length} 只）` : ''}` : latestFreshness?.stale ? '已收盘/缓存' : latestFreshness?.market_time ? '行情可用' : '无时间戳'
  const chooseView = (mode: 'detail' | 'overview') => { setViewMode(mode); setUiPref('portfolio-terminal-view', JSON.stringify(mode)) }
  const chooseLayout = (mode: LayoutMode) => { setLayoutMode(mode); setUiPref('portfolio-terminal-layout', JSON.stringify(mode)) }
  const setLinkedBoard = (symbol: string, code: string) => {
    const next = { ...linkedBoards }
    if (code) next[symbol] = code
    else delete next[symbol]
    setLinkedBoards(next)
    setUiPref('portfolio-terminal-linked-boards', JSON.stringify(next))
  }
  useEffect(() => {
    const remote = preferences?.ui_prefs
    if (!remote) return
    const visibleRemote = remote.portfolio_terminal_visible
    if (visibleRemote && typeof visibleRemote === 'object' && !Array.isArray(visibleRemote)) {
      setVisible(current => ({ ...current, ...(visibleRemote as Partial<Record<Panel, boolean>>) }))
    }
    const decodeString = (value: unknown) => {
      if (typeof value !== 'string') return value
      try { return JSON.parse(value) as unknown } catch { return value }
    }
    const remoteView = decodeString(remote.portfolio_terminal_view)
    const remoteLayout = decodeString(remote.portfolio_terminal_layout)
    if (remoteView === 'detail' || remoteView === 'overview') setViewMode(remoteView)
    if (remoteLayout === 'side' || remoteLayout === 'strip' || remoteLayout === 'grid') setLayoutMode(remoteLayout)
    const linked = remote.portfolio_terminal_linked_boards
    if (linked && typeof linked === 'object' && !Array.isArray(linked)) setLinkedBoards(linked as Record<string, string>)
    const symbols = remote.portfolio_terminal_extra_symbols
    if (Array.isArray(symbols)) setExtraSymbols(symbols.filter((value): value is string => typeof value === 'string'))
    const symbolNames = remote.portfolio_terminal_extra_symbol_names
    if (symbolNames && typeof symbolNames === 'object' && !Array.isArray(symbolNames)) {
      setExtraSymbolNames(Object.fromEntries(Object.entries(symbolNames).filter(([, value]) => typeof value === 'string')))
    }
    const boards = remote.portfolio_terminal_extra_boards
    if (Array.isArray(boards)) setExtraBoards(boards.filter((value): value is string => typeof value === 'string'))
    const widths = remote.portfolio_terminal_pane_widths
    if (widths && typeof widths === 'object' && !Array.isArray(widths)) {
      const value = widths as { left?: unknown; right?: unknown }
      const left = Number(value.left), right = Number(value.right)
      if (Number.isFinite(left) && Number.isFinite(right)) setPaneWidths({ left, right })
    }
  }, [preferences?.ui_prefs])
  const addSymbol = (inputValue = symbolInput) => {
    const raw = inputValue.trim()
    const match = symbolMatches.data?.results?.find(result => result.symbol === raw.toUpperCase().replace(/\.SS$/, '.SH') || result.code === raw || result.name === raw)
    const symbol = (match?.symbol || raw).toUpperCase().replace(/\.SS$/, '.SH')
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)) {
      setSymbolError('请输入代码或先从名称搜索结果中选择，例如“半导体ETF”')
      return
    }
    if (!allItems.some(item => item.symbol === symbol)) {
      const next = [...extraSymbols, symbol]
      setExtraSymbols(next)
      setUiPref('portfolio-terminal-extra-symbols', JSON.stringify(next))
    }
    if (match?.name) {
      const names = { ...extraSymbolNames, [symbol]: match.name }
      setExtraSymbolNames(names)
      setUiPref('portfolio-terminal-extra-symbol-names', JSON.stringify(names))
    }
    setSelected(symbol); setSelectedBoard(''); setSymbolInput(''); setSymbolError(''); setMenu(null)
  }
  const addBoard = (inputValue = boardInput) => {
    const raw = inputValue.trim()
    const directCode = raw.toUpperCase()
    const matched = sectorCatalog.data?.items?.find(item => item.code === directCode || item.name === raw)
    const code = /^BK\d{4}$/.test(directCode) ? directCode : matched?.code || boardMatches[0]?.code
    if (!code) { setBoardError('请输入板块名称或代码，例如“半导体芯片”或 BK1036'); return }
    if (!extraBoards.includes(code)) {
      const next = [...extraBoards, code]
      setExtraBoards(next)
      setUiPref('portfolio-terminal-extra-boards', JSON.stringify(next))
    }
    setSelectedBoard(code); setBoardInput(''); setBoardError(''); setMenu(null)
  }
  return <section className="relative h-full overflow-auto rounded-card border border-border bg-surface p-2 text-foreground"
    onContextMenu={event => { event.preventDefault(); setMenu({ x: Math.max(8, Math.min(event.clientX, innerWidth - 220)), y: Math.max(8, Math.min(event.clientY, innerHeight - 440)) }) }}>
    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-1">
      <div><h2 className="text-sm font-semibold">持仓看盘工作区</h2><p className="text-[11px] text-muted">左侧切换标的 · 右键选择显示内容 · {minute.data?.source || '分钟行情读取中'} · <span className={dataState === '行情可用' ? 'text-bull' : 'text-warning'}>{dataState}</span>{latestFreshness?.market_time ? ` · ${latestFreshness.market_time}` : ''}{badQuality ? ' · 已停止使用异常分钟数据' : ''}</p></div>
      <div className="flex flex-wrap items-center justify-end gap-1 text-xs"><button type="button" onClick={() => chooseView('detail')} className={`rounded border border-border px-2 py-0.5 ${viewMode === 'detail' ? 'bg-accent/20 text-accent' : 'text-muted'}`}>个股详情</button>
        <button type="button" onClick={() => chooseView('overview')} className={`rounded border border-border px-2 py-0.5 ${viewMode === 'overview' ? 'bg-accent/20 text-accent' : 'text-muted'}`}>持仓实时总览</button>
        <input aria-label="交易日期" type="date" value={day} max={latestDay} onChange={e => setPickedDay(e.target.value)} className="rounded border border-border bg-base px-1 py-0.5" />
        <button type="button" onClick={() => setPickedDay('')} className="text-accent">最新交易日</button>
        <Link to="/myagent-quant" className="text-accent">管理持仓</Link></div>
    </div>
    {snapshot.data && <div className="mb-1.5 rounded border border-border bg-base/40 px-2 py-1 text-[11px]">
      <span className="text-muted">监控标的来源：</span><b>{snapshot.data.source || '未标注'}</b> · <span className="text-muted">已录入持仓 {items.filter(item => item.holding_source).length}/{items.length}</span> · {snapshot.data.account_verified ? <span className="text-bull">券商实时账户已核验（{snapshot.data.account_source || 'broker'}）</span> : <span className="text-warning">券商账户未核验，数量/成本不代表实时账户同步</span>}
    </div>}
    {tradeHistory.data?.account_snapshot && <div className="mb-1.5 rounded border border-warning/50 bg-warning/5 px-2 py-1 text-[11px]">
      <b>{day} 历史账户截图 · 待与券商核对</b>　总资产 ¥{tradeHistory.data.account_snapshot.total_assets}　持仓 ¥{tradeHistory.data.account_snapshot.position_value}
      　现金 ¥{tradeHistory.data.account_snapshot.cash_available}　当日盈亏 ¥{tradeHistory.data.account_snapshot.day_pnl}
    </div>}
    {(snapshot.isError || minute.isError) && <p className="text-xs text-danger">行情读取失败：{String((snapshot.error || minute.error) instanceof Error ? (snapshot.error || minute.error)?.message : '请重试')}</p>}
    {viewMode === 'overview' && <HoldingsOverview items={shown} minuteData={usableMinuteData} source={minute.data?.source} onSelect={symbol => { setSelected(symbol); chooseView('detail') }} />}
    {viewMode === 'detail' && <>
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-base/40 px-2 py-1 text-[11px]">
      <span className="text-muted">详情布局</span><div className="flex gap-1"><button type="button" onClick={() => chooseLayout('side')} className={`rounded px-2 py-0.5 ${layoutMode === 'side' ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-elevated'}`}>左侧列表</button><button type="button" onClick={() => chooseLayout('strip')} className={`rounded px-2 py-0.5 ${layoutMode === 'strip' ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-elevated'}`}>横向长条</button><button type="button" onClick={() => chooseLayout('grid')} className={`rounded px-2 py-0.5 ${layoutMode === 'grid' ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-elevated'}`}>网格总览</button></div>
    </div>
    {layoutMode === 'grid' && <HoldingsOverview items={shown} minuteData={usableMinuteData} source={minute.data?.source} onSelect={symbol => { setSelected(symbol); chooseLayout('side') }} />}
    {layoutMode !== 'grid' && <div ref={splitRef} className={layoutMode === 'side' ? 'portfolio-detail-split grid gap-y-2 md:gap-x-0' : 'space-y-2'}
      style={layoutMode === 'side' ? { '--portfolio-left': `${paneWidths.left}px`, '--portfolio-right': `${paneWidths.right}px` } as React.CSSProperties : undefined}>
      {layoutMode === 'strip' && <div className="flex gap-1 overflow-x-auto rounded border border-border bg-base/50 p-1">{shown.map(item => <button key={item.symbol} type="button" onClick={() => { setSelected(item.symbol); setSelectedBoard('') }} className={`min-w-44 rounded border border-border px-2 py-1 text-left hover:bg-elevated ${active?.symbol === item.symbol ? 'bg-accent/15' : ''}`}><div className="flex justify-between gap-1 text-xs"><b className="truncate">{item.name}</b><span className={Number(item.change_pct) >= 0 ? 'text-bull' : 'text-bear'}>{pct(item.change_pct)}</span></div><div className="text-[10px] text-muted">{item.symbol} · {price(item.price)}</div></button>)}</div>}
      {layoutMode === 'side' && <aside className="min-w-0 rounded border border-border bg-base/50 p-1">
        <div className="flex gap-1 border-b border-border p-1 text-[11px]"><button type="button" onClick={() => setListMode('all')} className={listMode === 'all' ? 'text-accent' : 'text-muted'}>全部监控 {allItems.length}</button><button type="button" onClick={() => setListMode('recorded')} className={listMode === 'recorded' ? 'text-accent' : 'text-muted'}>已录持仓 {items.filter(x => x.holding_source).length}</button></div>
        <div className="max-h-[650px] overflow-auto">{shown.map(item => <button key={item.symbol} type="button" onClick={() => { setSelected(item.symbol); setSelectedBoard('') }}
          className={`block w-full border-b border-border/50 px-1.5 py-1 text-left hover:bg-elevated ${active?.symbol === item.symbol ? 'bg-accent/15' : ''}`}>
          <span className="flex justify-between gap-1 text-xs"><b className="truncate">{item.name}</b><span className={Number(item.change_pct) >= 0 ? 'text-bull' : 'text-bear'}>{pct(item.change_pct)}</span></span>
          <span className="flex justify-between text-[10px] text-muted"><span>{item.symbol}</span><span>{price(item.price)}</span></span>
        </button>)}
        {!!extraBoards.length && <div className="border-t border-border p-1 text-[11px] font-semibold text-muted">自选板块</div>}
        {extraBoards.map(code => <button type="button" key={code} onClick={() => setSelectedBoard(code)}
          className={`block w-full px-1.5 py-1 text-left text-xs hover:bg-elevated ${selectedBoard === code ? 'bg-accent/15 text-accent' : ''}`}>{code} · 板块行情</button>)}</div>
        {!shown.length && <p className="p-2 text-xs text-muted">暂无已录入持仓</p>}
      </aside>}
      {layoutMode === 'side' && <div role="separator" aria-label="拖动调整持仓列表宽度" aria-orientation="vertical" title="拖动调整持仓列表宽度"
        onPointerDown={event => resizePane('left', event)} className="portfolio-split-handle cursor-ew-resize touch-none bg-border/60 hover:bg-accent active:bg-accent" />}
      {selectedBoard ? <BoardDetail code={selectedBoard} day={day} news={news.data?.items || []} visible={visible} />
        : active ? <Detail item={active} day={day} latestBars={usableMinuteData[active.symbol] || []} minuteSource={minute.data?.source} news={news.data?.items || []} visible={visible}
          trades={(tradeHistory.data?.trades || []).filter(trade => trade.symbol === active.symbol)} linkedBoardCode={linkedBoards[active.symbol] || ''} boardOptions={boardOptions} onLinkedBoardChange={code => setLinkedBoard(active.symbol, code)} />
        : <p className="p-4 text-xs text-muted">暂无监控标的</p>}
      {layoutMode === 'side' && <div role="separator" aria-label="拖动调整策略栏宽度" aria-orientation="vertical" title="拖动调整策略栏宽度"
        onPointerDown={event => resizePane('right', event)} className="portfolio-split-handle cursor-ew-resize touch-none bg-border/60 hover:bg-accent active:bg-accent" />}
      {layoutMode === 'side' && <DecisionGuidePanel items={shown} minuteData={usableMinuteData} source={minute.data?.source} />}
    </div>}</>}
    <section className="mt-2 rounded border border-border bg-base/50 p-2 text-xs">
      <div className="flex justify-between gap-2"><b>{day} 操作时间线 · {tradeHistory.data?.trades.length ?? 0} 笔</b><span className="text-muted">用户提供/手工记录，非券商实时成交</span></div>
      {tradeHistory.data?.trade_summary && <div className="mt-1 grid gap-1 sm:grid-cols-3">
        <div className="rounded bg-surface px-2 py-1">已配对做T净收益 <b className={Number(tradeHistory.data.trade_summary.realised_t_pnl) >= 0 ? 'text-bull' : 'text-bear'}>¥{tradeHistory.data.trade_summary.realised_t_pnl}</b></div>
        <div className="rounded bg-surface px-2 py-1">交易费用 <b>¥{tradeHistory.data.trade_summary.total_fees}</b></div>
        <div className="rounded bg-surface px-2 py-1">未配对净增仓 <b>{tradeHistory.data.trade_summary.items.reduce((sum, row) => sum + row.unmatched_buy_quantity, 0)}</b> 股/份</div>
      </div>}
      {tradeHistory.data?.trade_summary && <p className="mt-1 text-[10px] text-muted">{tradeHistory.data.trade_summary.method}；{tradeHistory.data.trade_summary.notice}</p>}
      {tradeReplay.data && <div className="mt-1 border-t border-border/50 pt-1">
        <div className="mb-1 flex flex-wrap items-center gap-2 rounded bg-surface px-2 py-1">
          <span>事后理论模拟：</span><label className="flex items-center gap-1">每只标的低点买入/高点卖出
            <input aria-label="理论模拟数量" type="number" min={1} step={100} value={hindsightQuantity}
              onChange={e => setHindsightQuantity(Math.max(1, Number(e.target.value) || 1))}
              className="w-24 rounded border border-border bg-base px-1 py-0.5 text-right" /> 股</label>
          <span className="text-[10px] text-muted">按每只复盘标的分别计算，已扣买卖手续费</span>
        </div>
        <div className="grid gap-1 sm:grid-cols-4">
        <div className="rounded bg-surface px-2 py-1">相对完全不交易 <b className={Number(tradeReplay.data.actual_vs_no_trade) >= 0 ? 'text-bull' : 'text-bear'}>¥{tradeReplay.data.actual_vs_no_trade}</b></div>
        <div className="rounded bg-surface px-2 py-1">额外加仓影响 <b className={Number(tradeReplay.data.extra_position_effect) >= 0 ? 'text-bull' : 'text-bear'}>¥{tradeReplay.data.extra_position_effect}</b></div>
        <div className="rounded bg-surface px-2 py-1">增量策略最大回撤 <b>¥{tradeReplay.data.max_drawdown_yuan}</b>{tradeReplay.data.max_drawdown_pct_of_snapshot_assets && <span className="text-muted"> · {tradeReplay.data.max_drawdown_pct_of_snapshot_assets}%</span>}</div>
        <div className="rounded bg-surface px-2 py-1">事后理论最优（低买高卖） <b>¥{tradeReplay.data.hindsight_optimal_pnl}</b></div>
        </div>
      </div>}
      {tradeReplay.data && <p className="mt-1 text-[10px] text-muted">分钟价校验 {tradeReplay.data.fill_validation.within_range}/{tradeReplay.data.fill_validation.checked} 笔落在当分钟高低区间；{tradeReplay.data.notice}</p>}
      {tradeReplay.isError && <p className="mt-1 text-[10px] text-warning">分钟复盘数据暂不可用，成交账本仍已保留。</p>}
      {tradeHistory.isError && <p className="mt-1 text-warning">交易记录暂不可用</p>}
      <div className="mt-1 max-h-32 overflow-auto">{(tradeHistory.data?.trades || []).map(trade => <div key={trade.fingerprint}
        className="flex flex-wrap gap-x-3 border-t border-border/40 py-1 font-mono">
        <span>{trade.trade_time}</span><span>{trade.symbol}</span><b className={trade.side === 'buy' ? 'text-bull' : 'text-bear'}>{trade.side === 'buy' ? '买入' : '卖出'}</b>
        <span>{trade.quantity} × ¥{trade.price}</span><span>佣金 ¥{trade.commission}</span><span className="text-muted">{trade.verified ? '已核验' : '待核对'}</span>
      </div>)}</div>
      {!tradeHistory.isLoading && !tradeHistory.data?.trades.length && !tradeHistory.isError && <p className="mt-1 text-muted">当日无已记录成交</p>}
    </section>
    {menu && createPortal(<div role="menu" style={{ left: menu.x, top: menu.y }} className="fixed z-[10000] max-h-[90vh] w-52 overflow-auto rounded border border-border bg-surface p-1.5 text-xs shadow-2xl" onClick={e => e.stopPropagation()}>
      <div className="px-2 py-1 font-semibold">显示内容</div>
      {(Object.keys(PANEL_LABEL) as Panel[]).map(key => <button role="menuitemcheckbox" aria-checked={visible[key]} type="button" key={key} onClick={() => toggle(key)}
        className="block w-full rounded px-2 py-1 text-left hover:bg-elevated">{visible[key] ? '☑' : '□'} {PANEL_LABEL[key]}</button>)}
      <div className="mt-1 border-t border-border px-2 py-1 font-semibold">添加个股 / ETF / 指数</div>
      <div className="flex gap-1 px-1"><input aria-label="添加证券代码" value={symbolInput} onChange={e => setSymbolInput(e.target.value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') addSymbol() }} placeholder="输入名称或代码" className="min-w-0 w-full rounded border border-border bg-base px-1" />
        <button type="button" onClick={() => addSymbol()} className="text-accent">添加</button></div>
      {!!symbolInput.trim() && !!symbolMatches.data?.results?.length && <div className="mt-1 max-h-32 overflow-auto rounded border border-border bg-base">
        {symbolMatches.data.results.map(result => <button type="button" key={`${result.symbol}-${result.asset_type || ''}`} onClick={() => addSymbol(result.symbol)}
          className="block w-full px-2 py-1 text-left hover:bg-elevated"><b>{result.name || result.symbol}</b><span className="ml-1 font-mono text-[10px] text-muted">{result.symbol}</span><span className="float-right text-[10px] text-muted">{result.asset_type || 'stock'}</span></button>)}
      </div>}
      {symbolError && <p className="px-2 text-danger">{symbolError}</p>}
      <div className="mt-1 border-t border-border px-2 py-1 font-semibold">添加板块</div>
      <div className="flex gap-1 px-1"><input aria-label="搜索板块名称或代码" value={boardInput} onChange={e => { setBoardInput(e.target.value); setBoardError('') }}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') addBoard() }} placeholder="搜索板块名称或 BK1036" className="min-w-0 w-full rounded border border-border bg-base px-1" />
        <button type="button" onClick={() => addBoard()} className="text-accent">添加</button></div>
      {!!boardMatches.length && <div className="mt-1 max-h-32 overflow-auto rounded border border-border bg-base">
        {boardMatches.map(item => <button type="button" key={item.code} onClick={() => { setBoardInput(item.name); setBoardError(''); addBoard(item.name) }}
          className="block w-full px-2 py-1 text-left hover:bg-elevated"><b>{item.name}</b><span className="ml-1 font-mono text-[10px] text-muted">{item.code}</span>{item.pct != null && <span className={`float-right text-[10px] ${item.pct >= 0 ? 'text-bull' : 'text-bear'}`}>{item.pct > 0 ? '+' : ''}{item.pct}%</span>}</button>)}
      </div>}
      {boardError && <p className="px-2 text-danger">{boardError}</p>}
      <div className="mt-1 border-t border-border px-2 py-1 font-semibold">选择关联板块</div>
      <div className="max-h-28 overflow-auto">{items.filter(item => item.board).map(item => <button key={item.symbol} type="button"
        className="block w-full truncate px-2 py-1 text-left hover:bg-elevated" onClick={() => { setSelected(item.symbol); setSelectedBoard(''); setMenu(null) }}>
        {item.board?.name} · {item.symbol}</button>)}</div>
      <p className="px-2 text-[10px] text-muted">新标的可查看真实分钟K；未绑定板块时显示不可用。</p>
      <button type="button" onClick={() => setMenu(null)} className="w-full px-2 py-1 text-left text-accent">关闭</button>
    </div>, document.body)}
  </section>
}
