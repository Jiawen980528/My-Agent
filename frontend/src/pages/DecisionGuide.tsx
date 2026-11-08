import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

type Bar = { datetime: string; close: number; high: number; low: number; volume?: number }
type Holding = { symbol: string; name: string; price?: number | null; change_pct?: number | null; market_timestamp?: string | number | null; board?: { code?: string | null; name?: string | null } | null }
type Freshness = { market_time?: string | null; received_at?: string | null; age_seconds?: number | null; stale?: boolean }
type VolumeForecast = { status: 'ok' | 'unavailable'; forecast_amount?: number; forecast_low?: number; forecast_high?: number; current_cumulative_amount?: number; sample_days?: number; as_of?: string; method?: string; reason?: string; source?: string; scope?: string; covered_symbol_count?: number; symbol_count?: number; historical_days_available?: number; data_is_real?: boolean }
type MarketOverviewBrief = { breadth?: { up?: number; down?: number; flat?: number; avg_pct?: number | null }; amount?: { total?: number | null }; as_of?: string | null; quote_status?: { quote_age_ms?: number | null; is_trading_hours?: boolean } }
type BoardContext = { rows?: { close?: number; time?: string }[]; latest_time?: string; source?: string; name?: string }
type BoardCatalog = { items?: { code: string; name: string }[]; source?: string }
type DecisionResult = { action: string; rating: string; reasons: string[]; basis: string[]; suggested_qty: number; max_risk_yuan: number; account_verified: boolean; valid_until: string; evidence?: { context_missing?: string[] } }
const API = '/quant/api/myagent/quant'
const pct = (n: number | null) => n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const px = (n: number | null) => n == null || !Number.isFinite(n) ? '—' : n.toFixed(3)
const tradingNow = () => { const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })); const m = now.getHours() * 60 + now.getMinutes(); return now.getDay() > 0 && now.getDay() < 6 && ((m >= 570 && m <= 690) || (m >= 780 && m <= 900)) }
async function json<T>(url: string): Promise<T> { const r = await fetch(url, { credentials: 'include' }); const body = await r.json(); if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`); return body }
function tradeDay() { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) }
function savedLinkedBoard(symbol: string): string {
  if (typeof window === 'undefined') return ''
  try {
    const value = JSON.parse(window.localStorage.getItem('portfolio-terminal-linked-boards') || '{}') as Record<string, unknown>
    const code = String(value[symbol] || '').toUpperCase()
    return /^BK\d{4}$/.test(code) ? code : ''
  } catch {
    return ''
  }
}

function LiveCurve({ bars, color = '#4da3ff' }: { bars: Bar[]; color?: string }) {
  const values = bars.map(row => Number(row.close)).filter(Number.isFinite)
  if (values.length < 2) return <div className="flex h-24 items-center justify-center text-[11px] text-muted">暂无真实分钟曲线</div>
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${92 - ((value - min) / span) * 78}`).join(' ')
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-24 w-full rounded border border-border bg-base/60" role="img" aria-label="实时分钟行情曲线"><polyline points={points} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" /></svg>
}

export function DecisionGuide() {
  const day = tradeDay()
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const snapshot = useQuery({ queryKey: ['decision-guide-snapshot'], queryFn: () => json<{ items: Holding[]; source?: string }>(`${API}/portfolio/snapshot`), refetchInterval: tradingNow() ? 30_000 : false })
  const items = snapshot.data?.items || []
  const minute = useQuery({ queryKey: ['decision-guide-minute', day], queryFn: () => json<{ data: Record<string, Bar[]>; freshness?: Record<string, Freshness>; source?: string; complete?: boolean; missing_symbols?: string[] }>(`${API}/portfolio/minute-batch?trade_date=${day}`), enabled: items.length > 0, refetchInterval: tradingNow() ? 60_000 : false })
  const rows = useMemo(() => items.map(item => {
    const bars = minute.data?.data?.[item.symbol] || []
    const closes = bars.map(x => Number(x.close)).filter(Number.isFinite)
    const last = closes.at(-1) ?? Number(item.price)
    const first = closes[0]
    const ma5 = closes.length >= 5 ? closes.slice(-5).reduce((a, b) => a + b, 0) / 5 : null
    const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null
    const support = bars.length ? Math.min(...bars.slice(-20).map(x => Number(x.low))) : null
    const resistance = bars.length ? Math.max(...bars.slice(-20).map(x => Number(x.high))) : null
    const move = first && Number.isFinite(last) ? (last / first - 1) * 100 : Number(item.change_pct)
    const trend = last == null || ma5 == null ? '数据不足' : last >= ma5 && (ma20 == null || last >= ma20) ? '偏强' : last < ma5 && (ma20 == null || last < ma20) ? '偏弱' : '震荡'
    const action = trend === '偏强' ? '持有，等待回踩确认' : trend === '偏弱' ? '暂不操作，等待止跌' : trend === '数据不足' ? '等待数据补齐' : '区间观察'
    return { item, bars, last, move, ma5, ma20, support, resistance, trend, action, freshness: minute.data?.freshness?.[item.symbol] }
  }), [items, minute.data?.data])
  const strong = rows.filter(x => x.trend === '偏强').length
  const weak = rows.filter(x => x.trend === '偏弱').length
  const selected = rows.find(row => row.item.symbol === selectedSymbol) || rows[0]
  const volumeForecast = useQuery({
    queryKey: ['decision-guide-volume-forecast', selected?.item.symbol, day],
    queryFn: () => json<VolumeForecast>(`/quant/api/myagent/volume-forecast?symbol=${encodeURIComponent(selected!.item.symbol)}&trade_date=${day}`),
    enabled: !!selected?.item.symbol,
    staleTime: 60_000,
  })
  const marketVolumeForecast = useQuery({
    queryKey: ['decision-guide-market-volume-forecast', day],
    queryFn: () => json<VolumeForecast>(`/quant/api/myagent/market-volume-forecast?trade_date=${day}`),
    refetchInterval: tradingNow() ? 60_000 : false,
    staleTime: 60_000,
  })
  const marketOverview = useQuery({
    queryKey: ['decision-guide-market-overview'],
    queryFn: () => json<MarketOverviewBrief>('/quant/api/overview/market'),
    refetchInterval: tradingNow() ? 30_000 : false,
    staleTime: 30_000,
  })
  const linkedBoardCode = selected?.item.board?.code?.toUpperCase().match(/^BK\d{4}$/)?.[0] || (selected?.item.symbol ? savedLinkedBoard(selected.item.symbol) : '')
  const linkedBoard = useQuery({
    queryKey: ['decision-guide-board', linkedBoardCode],
    queryFn: () => json<BoardContext>(`/quant/api/myagent/fund-flow/sector-kline?sector=${linkedBoardCode}&period=1m`),
    enabled: !!linkedBoardCode,
    refetchInterval: tradingNow() ? 60_000 : false,
    staleTime: 60_000,
  })
  const boardPct = useMemo(() => {
    const rows = linkedBoard.data?.rows || []
    const first = Number(rows[0]?.close)
    const last = Number(rows.at(-1)?.close)
    return Number.isFinite(first) && first > 0 && Number.isFinite(last) ? last / first - 1 : null
  }, [linkedBoard.data?.rows])
  const defensiveCatalog = useQuery({
    queryKey: ['decision-guide-defensive-catalog'],
    queryFn: () => json<BoardCatalog>('/quant/api/myagent/fund-flow/sectors?q=%E9%93%B6%E8%A1%8C&limit=20'),
    staleTime: 10 * 60_000,
  })
  const defensiveBoard = defensiveCatalog.data?.items?.find(item => item.name === '银行' || item.name.includes('银行'))
  const defensiveQuote = useQuery({
    queryKey: ['decision-guide-defensive-board', defensiveBoard?.code],
    queryFn: () => json<BoardContext>(`/quant/api/myagent/fund-flow/sector-kline?sector=${defensiveBoard!.code}&period=1m`),
    enabled: !!defensiveBoard?.code,
    refetchInterval: tradingNow() ? 60_000 : false,
    staleTime: 60_000,
  })
  const defensivePct = useMemo(() => {
    const rows = defensiveQuote.data?.rows || []
    const first = Number(rows[0]?.close)
    const last = Number(rows.at(-1)?.close)
    return Number.isFinite(first) && first > 0 && Number.isFinite(last) ? last / first - 1 : null
  }, [defensiveQuote.data?.rows])
  const decision = useQuery({
    queryKey: ['decision-guide-assist', selected?.item.symbol, selected?.last, selected?.bars.at(-1)?.datetime, linkedBoardCode, boardPct, defensiveBoard?.code, defensivePct, marketOverview.data?.as_of, marketVolumeForecast.data?.as_of],
    queryFn: async () => {
      const response = await fetch('/quant/api/myagent/decision/assist', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strict_context: true,
          freshness: selected?.freshness || {},
          quote: { price: selected?.last, support: selected?.support, resistance: selected?.resistance },
          market: {
            pct: marketOverview.data?.breadth?.avg_pct,
            turnover_ratio: marketVolumeForecast.data?.status === 'ok' && marketVolumeForecast.data.forecast_amount
              ? (marketVolumeForecast.data.current_cumulative_amount || 0) / marketVolumeForecast.data.forecast_amount
              : null,
          },
          board: linkedBoardCode && boardPct != null ? { pct: boardPct } : {},
          market_breadth: marketOverview.data?.breadth ? {
            up_count: marketOverview.data.breadth.up,
            down_count: marketOverview.data.breadth.down,
            flat_count: marketOverview.data.breadth.flat,
          } : {},
          defensive: defensiveBoard && defensivePct != null ? { name: defensiveBoard.name, code: defensiveBoard.code, pct: defensivePct } : {},
          account: { source: 'unavailable', verified: false },
          turnover_forecast: marketVolumeForecast.data || {},
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`)
      return body as DecisionResult
    },
    enabled: !!selected?.item.symbol && !!selected?.last,
    staleTime: 30_000,
  })
  return <div className="h-full overflow-auto bg-base p-3 text-foreground">
    <header className="mb-3 rounded-card border border-border bg-surface p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-base font-semibold">每日行情推演 · 条件观察</h1><p className="mt-1 text-[11px] text-muted">当前使用真实分钟数据；账户、资金流、板块和多周期数据不完整时，不输出可执行买卖建议。</p></div><span className="rounded border border-border px-2 py-1 text-xs text-muted">交易日 {day} · {minute.data?.source || snapshot.data?.source || '数据读取中'}</span></div></header>
    {(snapshot.isError || minute.isError) && <div className="mb-3 rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">行情读取失败：{String((snapshot.error || minute.error) instanceof Error ? (snapshot.error || minute.error)?.message : '请检查登录和数据源')}</div>}
    <div className="mb-3 grid gap-2 sm:grid-cols-4"><div className="rounded-card border border-border bg-surface p-3"><span className="text-[11px] text-muted">监控标的</span><b className="mt-1 block text-xl">{rows.length}</b></div><div className="rounded-card border border-border bg-surface p-3"><span className="text-[11px] text-muted">短线偏强</span><b className="mt-1 block text-xl text-bull">{strong}</b></div><div className="rounded-card border border-border bg-surface p-3"><span className="text-[11px] text-muted">短线偏弱</span><b className="mt-1 block text-xl text-bear">{weak}</b></div><div className="rounded-card border border-border bg-surface p-3"><span className="text-[11px] text-muted">推演口径</span><b className="mt-1 block text-sm">条件观察</b></div></div>
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]"><section className="rounded-card border border-border bg-surface p-3"><div className="mb-2 flex items-center justify-between"><b>持仓逐只推演</b><span className="text-[10px] text-muted">{rows.length ? `最后分钟 ${rows.map(x => x.bars.at(-1)?.datetime).filter(Boolean).sort().at(-1) || '—'}` : '—'}</span></div><div className="overflow-auto"><table className="w-full min-w-[820px] text-xs"><thead className="bg-elevated text-muted"><tr>{['标的','最新','实时变化','趋势','数据状态','支撑','压力','条件观察'].map(x => <th key={x} className="px-2 py-2 text-left font-medium">{x}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.item.symbol} onClick={() => setSelectedSymbol(row.item.symbol)} className={`cursor-pointer border-t border-border/60 hover:bg-elevated ${selected?.item.symbol === row.item.symbol ? 'bg-accent/10' : ''}`}><td className="px-2 py-2"><b>{row.item.name}</b><div className="text-[10px] text-muted">{row.item.symbol}</div></td><td className="px-2 py-2 font-mono">{px(row.last)}</td><td className={`px-2 py-2 ${Number(row.move) >= 0 ? 'text-bull' : 'text-bear'}`}>{pct(row.move)}</td><td className="px-2 py-2">{row.trend}</td><td className={`px-2 py-2 ${row.freshness?.stale ? 'text-warning' : 'text-bull'}`}>{row.freshness?.stale ? '已收盘/过期' : '可用'}<div className="text-[10px] text-muted">{row.freshness?.market_time || '无时间'}</div></td><td className="px-2 py-2 font-mono">{px(row.support)}</td><td className="px-2 py-2 font-mono">{px(row.resistance)}</td><td className="px-2 py-2 text-accent">{row.action}</td></tr>)}</tbody></table>{!rows.length && <p className="p-8 text-center text-xs text-muted">暂无持仓数据</p>}</div>{selected && <div className="mt-3 rounded border border-border bg-base/50 p-2"><div className="mb-1 flex items-center justify-between text-xs"><b>{selected.item.name} · 实时行情曲线</b><span className="text-muted">{selected.bars.at(-1)?.datetime || '暂无时间'} · TickFlow分钟数据</span></div><LiveCurve bars={selected.bars} color={Number(selected.move) >= 0 ? '#24ba91' : '#ff6268'} /><p className="mt-1 text-[11px] text-muted">条件观察：{selected.action}；依据：{selected.trend}，当前价格 {px(selected.last)}，支撑 {px(selected.support)}，压力 {px(selected.resistance)}。账户、板块资金流和完整多周期数据未齐时，不生成可执行信号。</p><div className="mt-2 rounded border border-warning/30 bg-warning/5 p-2 text-[11px]"><div className="flex justify-between gap-2"><b>严格决策辅助：{decision.data?.rating || (decision.isLoading ? '计算中' : '等待')}</b><span>{decision.data?.valid_until ? `有效至 ${decision.data.valid_until.slice(11, 16)}` : '未生成信号'}</span></div><p className="mt-1">{decision.data?.reasons?.join('；') || (decision.isError ? '决策接口暂不可用' : '需要完整账户、市场、板块和量能上下文')}</p>{decision.data?.basis?.length ? <p className="mt-1 text-muted">依据：{decision.data.basis.join('、')}</p> : null}</div></div>}</section><aside className="space-y-3"><section className="rounded-card border border-border bg-surface p-3"><b>全市场全天成交额预测</b>{marketVolumeForecast.data?.status === 'ok' ? <><div className="mt-2 grid grid-cols-3 gap-1 text-xs"><span className="rounded bg-elevated p-2">当前累计<br /><b>{marketVolumeForecast.data.current_cumulative_amount?.toLocaleString()}</b></span><span className="rounded bg-elevated p-2">预测全天<br /><b>{marketVolumeForecast.data.forecast_amount?.toLocaleString()}</b></span><span className="rounded bg-elevated p-2">样本日<br /><b>{marketVolumeForecast.data.sample_days}</b></span></div><p className="mt-1 text-[10px] text-muted">{marketVolumeForecast.data.scope} · 覆盖 {marketVolumeForecast.data.covered_symbol_count}/{marketVolumeForecast.data.symbol_count} 只；区间 {marketVolumeForecast.data.forecast_low?.toLocaleString()} – {marketVolumeForecast.data.forecast_high?.toLocaleString()}；来源 {marketVolumeForecast.data.source}。</p></> : <p className="mt-2 text-xs text-muted">{marketVolumeForecast.isLoading ? '正在读取全市场真实分钟分区…' : marketVolumeForecast.data?.reason || '全市场成交额预测暂不可用（需完整当日及历史分钟分区）'}</p>}<p className="mt-1 text-[10px] text-muted">仅汇总真实分钟成交额；不使用指数成交额、涨跌幅或模拟数据。</p></section><section className="rounded-card border border-border bg-surface p-3"><b>单只持仓成交额预测</b>{volumeForecast.data?.status === 'ok' ? <><div className="mt-2 grid grid-cols-3 gap-1 text-xs"><span className="rounded bg-elevated p-2">当前累计<br /><b>{volumeForecast.data.current_cumulative_amount?.toLocaleString()}</b></span><span className="rounded bg-elevated p-2">预测全天<br /><b>{volumeForecast.data.forecast_amount?.toLocaleString()}</b></span><span className="rounded bg-elevated p-2">样本日<br /><b>{volumeForecast.data.sample_days}</b></span></div><p className="mt-1 text-[10px] text-muted">区间 {volumeForecast.data.forecast_low?.toLocaleString()} – {volumeForecast.data.forecast_high?.toLocaleString()}；截至 {volumeForecast.data.as_of}，来源 {volumeForecast.data.source}。</p></> : <p className="mt-2 text-xs text-muted">{volumeForecast.isLoading ? '正在读取历史同期分钟成交额…' : volumeForecast.data?.reason || '成交额预测暂不可用'}</p>}<p className="mt-1 text-[10px] text-muted">仅使用真实成交额和历史同期比例，不使用涨跌幅推算。</p></section><section className="rounded-card border border-border bg-surface p-3"><b>今日场景推演</b><div className="mt-2 space-y-2 text-xs"><div className="rounded border border-bull/30 bg-bull/5 p-2"><b className="text-bull">上行场景</b><p className="mt-1 text-muted">价格站上短线均线且板块同步走强时，才进入观察名单；不等于直接买入。</p></div><div className="rounded border border-warning/30 bg-warning/5 p-2"><b className="text-warning">震荡场景</b><p className="mt-1 text-muted">价格在支撑与压力之间运行时，等待量价和板块确认，避免追涨杀跌。</p></div><div className="rounded border border-bear/30 bg-bear/5 p-2"><b className="text-bear">下行场景</b><p className="mt-1 text-muted">跌破近 20 根分钟低点时，标记为风险观察，不自动执行减仓。</p></div></div></section><section className="rounded-card border border-border bg-surface p-3 text-xs"><b>数据与限制</b><p className="mt-1 text-muted">当前显示真实分钟行情、时间和来源。日线、60 分钟、15 分钟、多源新闻、资金流和完整板块相对强弱需要相应数据权限，未接入时明确留空。</p><p className="mt-1 text-[10px] text-muted">这是一套可复核的条件化研究指引，不构成收益承诺或自动交易指令。</p></section></aside></div>
  </div>
}
