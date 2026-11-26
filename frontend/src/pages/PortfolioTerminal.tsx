import { Link, NavLink } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Calculator, ImagePlus, LayoutDashboard, Loader2, Plus, Save } from 'lucide-react'
import { PortfolioMonitorWidget } from '@/components/dashboard/PortfolioMonitorWidget'
import { api, type WatchlistImportCandidate } from '@/lib/api'

type Holding = { symbol: string; name: string; sector?: string; quantity: number; cost: number; price?: number; pct?: number; profit?: number; profit_pct?: number }
type ExternalRow = { symbol: string; name: string; last?: number | null; change_pct?: number | null; status?: string; as_of?: string | null }
type ExternalContext = { status?: string; rows?: ExternalRow[]; source?: string; generated_at?: string; notice?: string }

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || `请求失败 ${response.status}`)
  return body as T
}

function num(value: string | number | null | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function HoldingTools() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrRows, setOcrRows] = useState<WatchlistImportCandidate[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const [cost, setCost] = useState('')
  const [selectedCode, setSelectedCode] = useState('')
  const [targetLoss, setTargetLoss] = useState('10')
  const [tPoints, setTPoints] = useState('1')
  const [selectedHolding, setSelectedHolding] = useState('')
  const holdings = useQuery({
    queryKey: ['myagent-portfolio-tools-holdings'],
    queryFn: () => readJson<{ items: Holding[] }>('/quant/api/myagent/quant/holdings'),
    refetchInterval: 30_000,
  })
  const external = useQuery({
    queryKey: ['portfolio-terminal-external-market'],
    queryFn: () => readJson<ExternalContext>('/quant/api/external-market/context'),
    refetchInterval: 60_000,
    staleTime: 45_000,
  })
  const market = useQuery({
    queryKey: ['portfolio-terminal-market-overview'],
    queryFn: () => readJson<{ breadth?: { up?: number; down?: number; flat?: number }; as_of?: string }>('/quant/api/overview/market'),
    refetchInterval: 60_000,
    staleTime: 45_000,
  })
  const current = holdings.data?.items?.find(item => item.symbol === selectedHolding) || holdings.data?.items?.[0]
  const calc = useMemo(() => {
    const q = num(current?.quantity), c = num(current?.cost), p = num(current?.price)
    const loss = Math.max(0, num(targetLoss) || 0) / 100
    const points = Math.max(0, num(tPoints) || 0) / 100
    if (q == null || c == null || p == null || q <= 0 || c <= 0 || p <= 0) return null
    const lossYuan = Math.max(0, (c - p) * q)
    const currentLossPct = (p / c - 1) * 100
    const targetAvg = p / Math.max(0.0001, 1 - loss)
    const addQty = targetAvg > p && c > targetAvg ? Math.ceil((q * (c - targetAvg)) / (targetAvg - p)) : 0
    const tGainPerDay = p * q * points
    const recoveryDays = tGainPerDay > 0 ? Math.ceil(lossYuan / tGainPerDay) : null
    const reverseTGain = p * q * points
    return { lossYuan, currentLossPct, targetAvg, addQty, recoveryDays, reverseTGain }
  }, [current, targetLoss, tPoints])
  const externalSummary = useMemo(() => {
    const rows = (external.data?.rows || []).filter(row => row.status === 'ok' && row.change_pct != null)
    const positive = rows.filter(row => Number(row.change_pct) > 0).length
    const negative = rows.filter(row => Number(row.change_pct) < 0).length
    const nq = rows.find(row => row.symbol === 'NQ=F')
    const asia = rows.filter(row => ['^KS11', '^HSI', '^N225'].includes(row.symbol))
    return { rows, positive, negative, nq, asia }
  }, [external.data])
  const environmentText = externalSummary.rows.length === 0
    ? '外围数据暂不可用，不给出明天方向性结论。'
    : externalSummary.nq?.change_pct != null && Number(externalSummary.nq.change_pct) < -1
      ? '纳斯达克期货偏弱：明早若高开不追，优先等冲高回落确认；低开先观察是否有量能承接。'
      : externalSummary.nq?.change_pct != null && Number(externalSummary.nq.change_pct) > 1
        ? '纳斯达克期货偏强：高开不直接追，回踩不破再观察反T；低开若快速收复昨收才考虑持有。'
        : '外围信号分化或幅度有限：明天先看开盘15分钟和板块同步性，未确认前不做反T。'
  const breadth = market.data?.breadth
  const breadthText = breadth?.up != null && breadth?.down != null ? `A股宽度：涨 ${breadth.up} / 跌 ${breadth.down}` : 'A股宽度暂无'
  const pickOcrFile = async (file: File) => {
    setOcrBusy(true); setError(''); setOcrRows([])
    try {
      const result = await api.watchlistImportImage(file)
      const matched = result.candidates.filter(item => item.matched && item.symbol)
      setOcrRows(matched)
      if (!matched.length) setError('没有识别到可确认的证券代码，请上传清晰的持仓截图。')
    } catch (err) { setError((err as Error).message) } finally { setOcrBusy(false) }
  }
  const saveHolding = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    const normalized = code.replace(/\D/g, '').slice(0, 6)
    if (!/^\d{6}$/.test(normalized) || !name.trim() || Number(quantity) <= 0 || Number(cost) < 0) {
      setError('请确认六位代码、名称、数量和成本价；截图识别后仍需人工确认数量和成本。'); return
    }
    setSaving(true)
    try {
      const response = await fetch(`/quant/api/myagent/quant/holdings/${normalized}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: normalized, name: name.trim(), quantity: Number(quantity), cost: Number(cost), source: 'manual' }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.detail || `保存失败 ${response.status}`)
      setCode(''); setName(''); setQuantity(''); setCost(''); setOcrRows([])
      await qc.invalidateQueries({ queryKey: ['myagent-portfolio-tools-holdings'] })
      await qc.invalidateQueries({ queryKey: ['myagent-quant-holdings'] })
    } catch (err) { setError((err as Error).message) } finally { setSaving(false) }
  }
  const chooseOcr = (row: WatchlistImportCandidate) => { setCode(row.symbol?.split('.')[0] || row.code); setName(row.name || ''); setSelectedCode(row.symbol || row.code) }
  return <section className="shrink-0 rounded-card border border-border bg-surface p-3 text-foreground">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-sm font-semibold">持仓录入与做T研究工具</h2><p className="mt-0.5 text-[11px] text-muted">截图只负责识别代码和名称，数量、成本必须人工确认；所有结果仅研究提醒，不自动下单。</p></div><div className="flex gap-1.5"><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) void pickOcrFile(file); e.currentTarget.value = '' }} /><button type="button" onClick={() => fileRef.current?.click()} disabled={ocrBusy} className="inline-flex items-center gap-1 rounded-btn border border-accent/50 px-2 py-1.5 text-[11px] text-accent disabled:opacity-50">{ocrBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}上传截图识别</button></div></div>
    {ocrRows.length > 0 && <div className="mt-2 rounded border border-accent/30 bg-accent/5 p-2 text-[11px]"><div className="mb-1 font-medium">识别结果（点击一行带入录入表单）</div><div className="flex flex-wrap gap-1.5">{ocrRows.map(row => <button key={row.symbol || row.code} type="button" onClick={() => chooseOcr(row)} className={`rounded border px-2 py-1 ${selectedCode === (row.symbol || row.code) ? 'border-accent bg-accent/15 text-accent' : 'border-border text-secondary'}`}>{row.name || '未命名'} · {row.symbol || row.code}</button>)}</div></div>}
    <form onSubmit={saveHolding} className="mt-2 grid grid-cols-2 gap-1.5 lg:grid-cols-6"><input aria-label="持仓代码" value={code} onChange={e => setCode(e.target.value)} placeholder="代码 600000" className="rounded-btn border border-border bg-base px-2 py-1.5 text-xs" /><input aria-label="持仓名称" value={name} onChange={e => setName(e.target.value)} placeholder="名称" className="rounded-btn border border-border bg-base px-2 py-1.5 text-xs" /><input aria-label="持仓数量" value={quantity} onChange={e => setQuantity(e.target.value)} type="number" min="1" placeholder="数量" className="rounded-btn border border-border bg-base px-2 py-1.5 text-xs" /><input aria-label="持仓成本" value={cost} onChange={e => setCost(e.target.value)} type="number" min="0" step="0.001" placeholder="成本价" className="rounded-btn border border-border bg-base px-2 py-1.5 text-xs" /><button disabled={saving} className="inline-flex items-center justify-center gap-1 rounded-btn bg-accent px-2 py-1.5 text-xs text-white disabled:opacity-50">{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存持仓</button><Link to="/portfolio-terminal" className="inline-flex items-center justify-center gap-1 rounded-btn border border-border px-2 py-1.5 text-xs text-muted"><Plus className="h-3.5 w-3.5" />刷新持仓</Link></form>
    {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
    <div className="mt-3 grid gap-2 xl:grid-cols-[1.15fr_1fr_1fr]"><div className="rounded border border-border bg-base/40 p-2"><div className="flex items-center gap-1 text-xs font-medium"><Calculator className="h-3.5 w-3.5 text-accent" />回本 / 补仓计算</div><div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px]"><select aria-label="计算标的" value={selectedHolding} onChange={e => setSelectedHolding(e.target.value)} className="rounded border border-border bg-base px-2 py-1.5"><option value="">选择持仓</option>{(holdings.data?.items || []).map(item => <option key={item.symbol} value={item.symbol}>{item.name} {item.symbol}</option>)}</select><input aria-label="目标最大亏损率" value={targetLoss} onChange={e => setTargetLoss(e.target.value)} type="number" min="0" max="99" step="0.5" placeholder="目标亏损率 %" className="rounded border border-border bg-base px-2 py-1.5" /></div>{calc ? <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] text-secondary"><span>当前浮亏 <b className="text-bear">¥{calc.lossYuan.toFixed(2)} / {calc.currentLossPct.toFixed(2)}%</b></span><span>目标成本 <b>{calc.targetAvg.toFixed(3)}</b></span><span>需补仓约 <b className="text-warning">{calc.addQty.toLocaleString()} 股</b></span><span>说明 <b>{calc.addQty ? '按现价估算' : '无需或无法达到'}</b></span></div> : <p className="mt-2 text-[10px] text-muted">选择已有持仓且有实时价后计算；补仓不会消除本金风险。</p>}</div><div className="rounded border border-border bg-base/40 p-2"><div className="text-xs font-medium">每天做T回本估算</div><div className="mt-2 flex items-center gap-1.5 text-[11px]"><label>每日目标点数</label><input aria-label="每日做T点数" value={tPoints} onChange={e => setTPoints(e.target.value)} type="number" min="0" max="20" step="0.1" className="w-20 rounded border border-border bg-base px-2 py-1.5" />%</div>{calc ? <p className="mt-2 text-[11px] text-secondary">按当前持仓市值、未计手续费和滑点，理论约 <b className="text-accent">{calc.recoveryDays == null ? '—' : `${calc.recoveryDays} 个交易日`}</b>；每次做T需满足可卖数量和回补价差，满仓且不可卖时不成立。</p> : <p className="mt-2 text-[10px] text-muted">这是线性估算，不是收益承诺；反T收益取决于卖出后能否更低价买回。</p>}</div><div className="rounded border border-border bg-base/40 p-2"><div className="text-xs font-medium">明日反T环境参考</div><p className="mt-1 text-[10px] text-muted">{breadthText} · 外盘可用 {externalSummary.rows.length} 项 · {external.data?.source || '来源读取中'}</p><p className="mt-2 text-[11px] text-secondary">{environmentText}</p><div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-muted"><span>外盘上涨 {externalSummary.positive}</span><span>外盘下跌 {externalSummary.negative}</span><span>反T理论点差收益 ¥{calc ? calc.reverseTGain.toFixed(2) : '—'}</span><span>数据时间 {external.data?.generated_at ? new Date(external.data.generated_at).toLocaleTimeString('zh-CN') : '—'}</span></div></div></div>
    <div className="mt-2 rounded border border-warning/30 bg-warning/5 p-2 text-[10px] leading-relaxed text-secondary"><b className="text-warning">次日预案：</b>高开：不追高，先看前15分钟是否放量突破；冲高回落且板块转弱，才进入反T观察。低开：先看是否收复昨收/均价线；不能收复或外盘继续走弱，优先不做T。平开震荡：只有接近压力、存在可卖底仓且预估价差覆盖费用时才观察。你目前满仓时，系统只会提示反T条件，不会提示正T或自动交易。</div>
  </section>
}

/** 独立持仓实时工作区；看板中的同一组件仍保留。 */
export function PortfolioTerminal() {
  const status = useQuery({
    queryKey: ['myagent-tickflow-status'],
    queryFn: async () => {
      const response = await fetch('/quant/api/myagent/quant/tickflow/status', { credentials: 'include' })
      const body = await response.json() as { connected?: boolean; source?: string; as_of?: string | null; message?: string }
      if (!response.ok) throw new Error(body.message || `状态读取失败 ${response.status}`)
      return body
    },
    refetchInterval: 30_000,
  })
  const boardStatus = useQuery({
    queryKey: ['myagent-board-data-status'],
    queryFn: async () => {
      const response = await fetch('/quant/api/myagent/fund-flow/status', { credentials: 'include' })
      const body = await response.json() as { fuyao_configured?: boolean; board_history?: string; message?: string }
      if (!response.ok) throw new Error(body.message || `板块状态读取失败 ${response.status}`)
      return body
    },
    refetchInterval: 30_000,
  })
  const bridgeConnected = status.data?.connected === true
  const live = bridgeConnected && Boolean(status.data?.source && status.data.source !== 'unavailable')
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-base p-2 text-foreground sm:p-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <Link to="/" className="rounded-btn p-1.5 text-muted hover:bg-elevated hover:text-foreground" title="返回看板" aria-label="返回看板"><ArrowLeft className="h-4 w-4" /></Link>
          <div><h1 className="text-sm font-semibold">我的持仓 · 实时工作区</h1><p className="text-[11px] text-muted">手工/截图确认的持仓 · 只读行情 · 不连接券商、不自动下单</p></div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {[
            ['/portfolio-terminal', '实时持仓'],
            ['/paper', '暗盘模拟'],
            ['/review', '预测复盘'],
            ['/monitor', '提醒规则'],
          ].map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `rounded-btn border px-2 py-1 text-xs transition-colors ${isActive ? 'border-accent/60 bg-accent/15 text-accent' : 'border-border text-muted hover:bg-elevated hover:text-foreground'}`}
            >
              {label}
            </NavLink>
          ))}
          <Link to="/" className="inline-flex items-center gap-1 rounded-btn border border-border px-2 py-1 text-xs text-accent hover:bg-elevated"><LayoutDashboard className="h-3.5 w-3.5" />看板布局</Link>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded border border-border bg-surface/70 px-3 py-1.5 text-[11px]">
        <span className={`h-2 w-2 rounded-full ${live ? 'bg-bull' : 'bg-warning'}`} />
        <span className={live ? 'text-bull' : 'text-warning'}>{live ? 'TickFlow 实时/分钟能力可用' : bridgeConnected ? 'TickFlow 桥接已连通，但实时/分钟能力未授权' : 'TickFlow 桥接不可用'}</span>
        <span className="text-muted">{status.data?.source || '状态读取中'}{status.data?.as_of ? ` · ${status.data.as_of}` : ''}</span>
        {!live && <Link to="/settings?tab=data-sources" className="ml-auto text-accent hover:underline">配置数据源</Link>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded border border-border bg-surface/70 px-3 py-1.5 text-[11px]">
        <span className={`h-2 w-2 rounded-full ${boardStatus.data?.fuyao_configured ? 'bg-bull' : 'bg-warning'}`} />
        <span className={boardStatus.data?.fuyao_configured ? 'text-bull' : 'text-warning'}>
          {boardStatus.data?.fuyao_configured ? '扶摇板块目录/历史曲线已配置' : '扶摇板块数据未配置'}
        </span>
        <span className="text-muted">{boardStatus.data?.message || '板块状态读取中'}</span>
        {!boardStatus.data?.fuyao_configured && <Link to="/settings?tab=data-sources" className="ml-auto text-accent hover:underline">配置扶摇</Link>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto"><div className="space-y-2"><HoldingTools /><PortfolioMonitorWidget /></div></div>
    </div>
  )
}
