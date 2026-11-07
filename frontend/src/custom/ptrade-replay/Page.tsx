import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'

type Bar = { datetime: string; open: number; high: number; low: number; close: number; volume: number; amount: number; source: string }
type Trade = { datetime: string; side: 'buy' | 'sell'; qty: number; price: number; fee: number; cash_flow: number }
type Replay = { symbol: string; date: string; source: string; rows: Bar[]; row_count: number; complete: boolean; trades: Trade[]; cash_flow: number; fees: number; matched_t_qty: number; matched_t_pnl: number; extra_qty: number; close: number | null; versus_no_trade: number | null; extra_position_mark_to_close: number | null; note: string; support_20m: number | null; resistance_20m: number | null; hindsight_best: { pnl: number; buy_time: string; sell_time: string; disclaimer: string } | null; causal_backtest: { pnl: number; max_drawdown_yuan: number; trade_count: number; cost: number; rule: string } | null }

function Chart({ replay }: { replay: Replay }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current || !replay.rows.length) return
    const chart = echarts.init(ref.current)
    const rows = replay.rows
    let totalAmount = 0
    let totalVolume = 0
    const avg = rows.map(row => { totalAmount += row.amount; totalVolume += row.volume; return totalVolume ? totalAmount / totalVolume : row.close })
    const labels = rows.map(row => row.datetime.slice(11, 16))
    const marks = replay.trades.map(trade => ({
      coord: [trade.datetime.slice(11, 16), trade.price], value: `${trade.side === 'buy' ? '买' : '卖'} ${trade.qty}`,
      itemStyle: { color: trade.side === 'buy' ? '#ef5968' : '#21bf93' },
    }))
    chart.setOption({ animation: false, backgroundColor: 'transparent', color: ['#579bff', '#e9b65b'],
      grid: [{ left: 58, right: 22, top: 32, height: '58%' }, { left: 58, right: 22, top: '75%', height: '16%' }],
      tooltip: { trigger: 'axis', backgroundColor: '#142235', textStyle: { color: '#fff' } },
      legend: { data: ['分钟K', '分时均价', '成交量'], textStyle: { color: '#a7b5c8' } },
      xAxis: [{ type: 'category', data: labels, axisLabel: { color: '#94a3b8' } }, { type: 'category', data: labels, gridIndex: 1, axisLabel: { color: '#94a3b8' } }],
      yAxis: [{ type: 'value', scale: true, axisLabel: { color: '#94a3b8' } }, { type: 'value', gridIndex: 1, axisLabel: { color: '#94a3b8' } }],
      dataZoom: [{ type: 'inside', xAxisIndex: [0, 1] }, { type: 'slider', xAxisIndex: [0, 1], bottom: 4, height: 16 }],
      series: [
        { name: '分钟K', type: 'candlestick', data: rows.map(row => [row.open, row.close, row.low, row.high]),
          itemStyle: { color: '#ef5968', color0: '#21bf93', borderColor: '#ef5968', borderColor0: '#21bf93' },
          markPoint: { symbolSize: 43, data: marks, label: { fontSize: 10, color: '#fff' } } },
        { name: '分时均价', type: 'line', showSymbol: false, data: avg, lineStyle: { width: 1.6 } },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: rows.map(row => row.volume), itemStyle: { color: '#586d8a' } },
      ],
    })
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current)
    return () => { observer.disconnect(); chart.dispose() }
  }, [replay])
  return <div ref={ref} className="h-[560px] w-full" role="img" aria-label="真实PTrade分钟K、成交量和交易点" />
}

export function PTradeReplayPage() {
  const [symbol, setSymbol] = useState('159558.SZ')
  const [source, setSource] = useState<'public' | 'ptrade'>('public')
  const [replay, setReplay] = useState<Replay | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async (selected: string, selectedSource: 'public' | 'ptrade') => {
    const response = await fetch(`/quant/api/myagent/ptrade/etf-minute/replay?symbol=${encodeURIComponent(selected)}&source=${selectedSource}`, { credentials: 'include' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.detail || `读取失败 ${response.status}`)
    setReplay(body as Replay)
  }
  useEffect(() => { let active = true; setError(''); void load(symbol, source).catch(err => { if (active) setError((err as Error).message) }); return () => { active = false } }, [symbol, source])
  const upload = async (file: File) => {
    setBusy(true); setError('')
    try {
      const response = await fetch('/quant/api/myagent/ptrade/etf-minute/import', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'text/csv' }, body: file })
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || `导入失败 ${response.status}`)
      setSource('ptrade')
      await load(symbol, 'ptrade')
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  return <main className="mx-auto max-w-[1500px] p-5 text-sm">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-bold">ETF 做T复盘</h1><p className="text-muted">2026-11-06 · 可切换公开延迟分时和已导入PTrade行情 · 只读，无交易操作</p></div>
      <div className="flex items-center gap-2"><select aria-label="选择ETF" value={symbol} onChange={event => setSymbol(event.target.value)} className="rounded border border-border bg-surface p-2"><option value="159558.SZ">159558.SZ</option><option value="588080.SS">588080.SS</option></select>
        <select aria-label="行情来源" value={source} onChange={event => setSource(event.target.value as 'public' | 'ptrade')} className="rounded border border-border bg-surface p-2"><option value="public">公开分时（可查看）</option><option value="ptrade">PTrade CSV（待导入）</option></select>
        <label className="cursor-pointer rounded border border-border px-3 py-2 text-accent">导入PTrade CSV<input className="sr-only" type="file" accept=".csv,text/csv" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = '' }} /></label></div></div>
    {error && <p className="mb-3 rounded border border-danger p-2 text-danger">{error}</p>}
    {replay && <><div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{[
      ['数据来源', replay.source], ['分钟条数', `${replay.row_count} / 240${replay.complete ? ' · 完整' : ' · 待核对'}`],
      ['已记录交易现金流', `${replay.cash_flow.toFixed(2)} 元`], ['佣金合计', `${replay.fees.toFixed(2)} 元`],
      ['配对做T价差', `${replay.matched_t_pnl.toFixed(2)} 元`], ['额外加仓', `${replay.extra_qty} 份`],
      ['相对不交易（收盘估值）', replay.versus_no_trade == null ? '等待真实收盘行情' : `${replay.versus_no_trade.toFixed(2)} 元`],
      ['额外仓位影响', replay.extra_position_mark_to_close == null ? '等待真实收盘行情' : `${replay.extra_position_mark_to_close.toFixed(2)} 元`],
    ].map(([label, value]) => <div key={label} className="rounded border border-border bg-surface p-3"><div className="text-muted">{label}</div><div className="mt-1 font-semibold">{value}</div></div>)}</div>
      {replay.rows.length ? <div className="rounded border border-border bg-surface p-2"><Chart replay={replay} /><p className="px-2 text-muted">价格：元；成交量：{source === 'public' ? '份（公开接口手数×100）' : 'PTrade原始 volume，单位须以券商客户端核实'}；成交额：元。数据截至 {replay.rows[replay.rows.length-1].datetime}。</p></div> : <div className="rounded border border-border bg-surface p-10 text-center text-muted">{source === 'ptrade' ? '尚未导入PTrade真实分钟数据。' : '公开分时暂不可用。'}</div>}
      <p className="my-3 text-muted">成交记录由用户提供，尚未与券商成交回报核对。{replay.note} 账户总盈亏与仓位比例还需要日初持仓、成本和账户资产。</p>
      {replay.rows.length >= 20 && <div className="mb-3 grid gap-3 lg:grid-cols-3">
        <div className="rounded border border-border bg-surface p-3"><h2 className="font-semibold">当前支撑与压力</h2><p>前20分钟低点 {replay.support_20m?.toFixed(3)} · 高点 {replay.resistance_20m?.toFixed(3)}</p></div>
        <div className="rounded border border-border bg-surface p-3"><h2 className="font-semibold">理论最优做T · 事后回测</h2><p>净额 {replay.hindsight_best?.pnl.toFixed(2)} 元</p><p className="text-muted">{replay.hindsight_best?.disclaimer}</p></div>
        <div className="rounded border border-border bg-surface p-3"><h2 className="font-semibold">无未来数据策略示例</h2><p>收益 {replay.causal_backtest?.pnl.toFixed(2)} 元 · 最大回撤 {replay.causal_backtest?.max_drawdown_yuan.toFixed(2)} 元</p><p>交易 {replay.causal_backtest?.trade_count} 笔 · 成本 {replay.causal_backtest?.cost.toFixed(2)} 元</p><p className="text-muted">{replay.causal_backtest?.rule}</p></div>
      </div>}
      <div className="overflow-x-auto rounded border border-border"><table className="w-full text-left"><thead><tr>{['时间', '方向', '数量', '成交价', '佣金', '现金流'].map(head => <th key={head} className="p-2">{head}</th>)}</tr></thead><tbody>{replay.trades.map(trade => <tr key={trade.datetime} className="border-t border-border"><td className="p-2">{trade.datetime.slice(11, 16)}</td><td className="p-2">{trade.side === 'buy' ? '买入' : '卖出'}</td><td className="p-2">{trade.qty}</td><td className="p-2">{trade.price}</td><td className="p-2">{trade.fee.toFixed(2)}</td><td className="p-2">{trade.cash_flow.toFixed(2)}</td></tr>)}</tbody></table></div>
    </>}
  </main>
}
