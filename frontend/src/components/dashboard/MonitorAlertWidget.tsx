import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BellRing, Play, Square } from 'lucide-react'
import { api } from '@/lib/api'
import { resampleMinutes } from '@/lib/minuteResample'

const instruments = [
  ['000001.SH', '上证指数'], ['399001.SZ', '深证成指'], ['399006.SZ', '创业板指'], ['000688.SH', '科创50'],
] as const

export function MonitorAlertWidget() {
  const [symbol, setSymbol] = useState('000688.SH')
  const [period, setPeriod] = useState(15)
  const [ma, setMa] = useState(5)
  const [interval, setInterval] = useState(60)
  const [enabled, setEnabled] = useState(true)
  const [notice, setNotice] = useState('')
  const lastAlert = useRef('')
  const query = useQuery({
    queryKey: ['monitor-alert-index-minute', symbol],
    queryFn: () => api.indexMinute(symbol),
    refetchInterval: enabled ? interval * 1000 : false,
    staleTime: 30_000,
  })
  const bars = useMemo(() => {
    const rows = (query.data?.rows || []).map(row => ({ ...row, datetime: row.datetime }))
    return resampleMinutes(rows, period)
  }, [query.data?.rows, period])
  const signal = useMemo(() => {
    if (bars.length < ma + 1) return null
    const current = bars.at(-1)!
    const previous = bars.at(-2)!
    const currentMa = bars.slice(-ma).reduce((sum, row) => sum + row.close, 0) / ma
    const previousMa = bars.slice(-(ma + 1), -1).reduce((sum, row) => sum + row.close, 0) / ma
    const crossed = previous.close >= previousMa && current.close < currentMa
    return { crossed, current, currentMa, previousMa }
  }, [bars, ma])
  useEffect(() => {
    if (!enabled || !signal?.crossed) return
    const key = `${symbol}-${signal.current.date}-${signal.current.close}`
    if (lastAlert.current !== key) {
      lastAlert.current = key
      const text = `${instruments.find(item => item[0] === symbol)?.[1] || symbol} ${period}分钟 MA${ma} 跌破，满足高抛/反T观察条件`
      setNotice(text)
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('TickFlow 分时监控提醒', { body: text })
    }
  }, [enabled, ma, period, signal, symbol])
  return <section className="h-full min-h-0 overflow-hidden rounded-card border border-border bg-surface p-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold"><BellRing className="mr-1 inline h-4 w-4 text-accent" />分时监控提醒</h2><p className="text-[10px] text-muted">跌破均线只提醒观察，不自动下单</p></div><button type="button" onClick={() => { setEnabled(value => !value); if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission() }} className={`rounded border px-2 py-1 text-[10px] ${enabled ? 'border-bull/50 text-bull' : 'border-border text-muted'}`}>{enabled ? <><Play className="mr-1 inline h-3 w-3" />监控中</> : <><Square className="mr-1 inline h-3 w-3" />已暂停</>}</button></div>
    <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px] sm:grid-cols-4"><label className="text-muted">标的<select value={symbol} onChange={event => { setSymbol(event.target.value); setNotice('') }} className="mt-0.5 w-full rounded border border-border bg-base px-1.5 py-1 text-xs text-foreground">{instruments.map(item => <option key={item[0]} value={item[0]}>{item[1]}</option>)}</select></label><label className="text-muted">周期<select value={period} onChange={event => setPeriod(Number(event.target.value))} className="mt-0.5 w-full rounded border border-border bg-base px-1.5 py-1 text-xs text-foreground"><option value={5}>5分钟</option><option value={15}>15分钟</option><option value={30}>30分钟</option></select></label><label className="text-muted">均线<input type="number" min={2} max={60} value={ma} onChange={event => setMa(Math.max(2, Number(event.target.value) || 5))} className="mt-0.5 w-full rounded border border-border bg-base px-1.5 py-1 text-xs text-foreground" /></label><label className="text-muted">检查频率<select value={interval} onChange={event => setInterval(Number(event.target.value))} className="mt-0.5 w-full rounded border border-border bg-base px-1.5 py-1 text-xs text-foreground"><option value={15}>15秒</option><option value={30}>30秒</option><option value={60}>60秒</option><option value={120}>2分钟</option></select></label></div>
    <div className={`mt-2 rounded border px-2 py-1.5 text-xs ${signal?.crossed ? 'border-warning/70 bg-warning/10 text-warning' : 'border-border bg-base/40 text-secondary'}`}>{query.isLoading ? '正在读取分时数据…' : query.isError ? '分时数据读取失败' : signal?.crossed ? `提醒：${instruments.find(item => item[0] === symbol)?.[1] || symbol} 已跌破 ${period} 分钟 MA${ma}，请观察高抛/反T条件。` : signal ? `当前价 ${signal.current.close.toFixed(2)} · MA${ma} ${signal.currentMa.toFixed(2)} · 暂未触发跌破` : `数据不足，至少需要 ${ma + 1} 根${period}分钟K`}</div>
    {notice && <div className="mt-1 rounded border border-warning/50 bg-warning/5 px-2 py-1 text-[10px] text-warning">{notice}</div>}
    <p className="mt-1 text-[10px] text-muted">数据源：{query.data?.source || '指数分钟行情'} · 最近：{signal?.current.date || '—'} · 每{interval}秒检查</p>
  </section>
}
