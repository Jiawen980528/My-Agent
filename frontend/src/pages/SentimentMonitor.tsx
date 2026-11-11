import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { useQuery } from '@tanstack/react-query'

const codeOf = (symbol: string) => symbol.replace(/\.(SH|SZ|SS|BJ)$/i, '')
const qualified = (symbol: string) => /\.(SH|SZ|BJ)$/i.test(symbol) ? symbol.toUpperCase() : `${codeOf(symbol)}.${codeOf(symbol).startsWith('6') ? 'SH' : 'SZ'}`

export function SentimentMonitor() {
  const market = useQuery({ queryKey: ['market', 'overview-monitor'], queryFn: () => api.overviewMarket(), refetchInterval: 5_000, staleTime: 3_000 })
  const abnormal = useQuery({ queryKey: ['market', 'abnormal-monitor'], queryFn: () => api.abnormalIntraday(200), refetchInterval: 5_000, staleTime: 3_000 })
  const portfolio = useQuery({ queryKey: ['myagent', 'portfolio-monitor'], queryFn: () => api.portfolioSnapshot(), refetchInterval: 10_000, staleTime: 5_000 })
  const [notify, setNotify] = useState(() => { try { return localStorage.getItem('myagent-leader-notify') === 'on' } catch { return false } })
  const seen = useRef(new Set<string>())
  const holdings = useMemo(() => new Set((portfolio.data?.items ?? []).map(item => codeOf(item.symbol))), [portfolio.data?.items])
  const rows = abnormal.data?.rows ?? []
  const leaders = rows.filter(row => Number(row.consecutive_limit_ups ?? 0) >= 2 || row.signals.includes('limit_up')).slice(0, 12)
  const broken = rows.filter(row => row.signals.includes('broken')).slice(0, 12)
  const guidance = (() => { const score = Number(market.data?.emotion?.score ?? 50); const b = Number(market.data?.limit?.broken ?? broken.length); const u = Number(market.data?.limit?.limit_up ?? leaders.length); return b > u * .45 || score < 40 ? '分歧偏大：持仓优先高抛或等待确认' : score >= 70 && b < Math.max(3, u * .2) ? '情绪偏强：只观察龙头分歧转强，不追后排' : '震荡轮动：等待板块与龙头同步' })()
  useEffect(() => {
    if (!notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    for (const row of rows.slice(0, 40)) {
      const key = `${abnormal.data?.cache_date}:${row.symbol}:${row.signals.join(',')}:${row.change_pct}`
      if (seen.current.has(key)) continue
      seen.current.add(key)
      const related = holdings.has(codeOf(row.symbol))
      new Notification(`MyAgent：${row.signals.includes('broken') ? '炸板异动' : '龙头/涨停异动'}`, { body: `${row.name || row.symbol} · ${related ? '影响你的持仓，请查看' : '暂未匹配你的持仓'}` })
    }
  }, [rows, abnormal.data, notify, holdings])
  const enable = async () => { if (typeof Notification === 'undefined') return; const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission; const on = p === 'granted'; setNotify(on); try { localStorage.setItem('myagent-leader-notify', on ? 'on' : 'off') } catch {} }
  return <div className="h-full overflow-auto bg-base p-3 text-foreground"><div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4"><div><h1 className="text-base font-semibold">市场情绪与龙头监控</h1><p className="mt-1 text-xs text-muted">全市场龙头、涨停、炸板、涨跌家数、封板率和情绪联动；标的会标注是否影响你的持仓。</p></div><button type="button" onClick={() => void enable()} className={`rounded border px-3 py-2 text-xs ${notify ? 'border-bull/60 text-bull' : 'border-accent/60 text-accent'}`}>{notify ? '浏览器提醒已开启' : '开启浏览器提醒'}</button></div><div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5"><div className="rounded border border-border bg-surface p-3 text-xs">上涨 / 下跌<b className="mt-1 block text-sm">{market.data?.breadth.up ?? '—'} / {market.data?.breadth.down ?? '—'}</b></div><div className="rounded border border-border bg-surface p-3 text-xs">涨停 / 炸板<b className="mt-1 block text-sm">{market.data?.limit.limit_up ?? '—'} / {market.data?.limit.broken ?? '—'}</b></div><div className="rounded border border-border bg-surface p-3 text-xs">封板率<b className="mt-1 block text-sm">{market.data?.limit.seal_rate == null ? '—' : `${market.data.limit.seal_rate.toFixed(0)}%`}</b></div><div className="rounded border border-border bg-surface p-3 text-xs">市场情绪<b className="mt-1 block text-sm">{market.data?.emotion.label ?? '—'} {market.data?.emotion.score ?? '—'}</b></div><div className="rounded border border-border bg-surface p-3 text-xs">当前指引<b className="mt-1 block text-sm text-accent">{guidance}</b></div></div><div className="grid gap-3 lg:grid-cols-2"><section className="rounded-card border border-border bg-surface p-3"><h2 className="font-semibold">龙头 / 涨停异动</h2>{leaders.map(row => <Link key={row.symbol} to={`/stock-analysis?symbol=${encodeURIComponent(qualified(row.symbol))}&name=${encodeURIComponent(row.name || row.symbol)}`} className="mt-2 flex items-center justify-between rounded border border-border bg-base/50 p-2 text-xs hover:border-accent"><span><b>{row.name || row.symbol}</b><small className="ml-2 text-muted">{row.consecutive_limit_ups ? `${row.consecutive_limit_ups}连板` : '涨停异动'}</small></span><span className="text-bull">{row.change_pct == null ? '—' : `${Number(row.change_pct).toFixed(2)}%`}{holdings.has(codeOf(row.symbol)) && <em className="ml-2 not-italic text-accent">影响持仓</em>}</span></Link>)}{!leaders.length && <p className="mt-2 text-xs text-muted">暂无可核验龙头异动</p>}</section><section className="rounded-card border border-border bg-surface p-3"><h2 className="font-semibold">炸板 / 分歧</h2>{broken.map(row => <Link key={row.symbol} to={`/stock-analysis?symbol=${encodeURIComponent(qualified(row.symbol))}&name=${encodeURIComponent(row.name || row.symbol)}`} className="mt-2 flex items-center justify-between rounded border border-border bg-base/50 p-2 text-xs hover:border-accent"><span><b>{row.name || row.symbol}</b><small className="ml-2 text-warning">炸板</small></span><span className="text-warning">{row.change_pct == null ? '—' : `${Number(row.change_pct).toFixed(2)}%`}{holdings.has(codeOf(row.symbol)) && <em className="ml-2 not-italic text-accent">影响持仓</em>}</span></Link>)}{!broken.length && <p className="mt-2 text-xs text-muted">暂无炸板数据</p>}</section></div><p className="mt-3 text-[11px] text-muted">判断逻辑：进攻科技板块龙头稳定、封板率高且情绪增强时才进入观察追踪；炸板上升、涨跌家数转弱或防御板块领涨时，持仓标的优先提示高抛/等待。页面提示不等于自动下单。</p></div>
}
