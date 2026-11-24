import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, LayoutDashboard } from 'lucide-react'
import { PortfolioMonitorWidget } from '@/components/dashboard/PortfolioMonitorWidget'

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
  const bridgeConnected = status.data?.connected === true
  const live = bridgeConnected && Boolean(status.data?.source && status.data.source !== 'unavailable')
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-base p-2 text-foreground sm:p-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <Link to="/" className="rounded-btn p-1.5 text-muted hover:bg-elevated hover:text-foreground" title="返回看板" aria-label="返回看板"><ArrowLeft className="h-4 w-4" /></Link>
          <div><h1 className="text-sm font-semibold">我的持仓 · 实时工作区</h1><p className="text-[11px] text-muted">手工/截图确认的持仓 · 只读行情 · 不连接券商、不自动下单</p></div>
        </div>
        <Link to="/" className="inline-flex items-center gap-1 rounded-btn border border-border px-2 py-1 text-xs text-accent hover:bg-elevated"><LayoutDashboard className="h-3.5 w-3.5" />看板布局</Link>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded border border-border bg-surface/70 px-3 py-1.5 text-[11px]">
        <span className={`h-2 w-2 rounded-full ${live ? 'bg-bull' : 'bg-warning'}`} />
        <span className={live ? 'text-bull' : 'text-warning'}>{live ? 'TickFlow 实时/分钟能力可用' : bridgeConnected ? 'TickFlow 桥接已连通，但实时/分钟能力未授权' : 'TickFlow 桥接不可用'}</span>
        <span className="text-muted">{status.data?.source || '状态读取中'}{status.data?.as_of ? ` · ${status.data.as_of}` : ''}</span>
        {!live && <Link to="/settings?tab=data-sources" className="ml-auto text-accent hover:underline">配置数据源</Link>}
      </div>
      <div className="min-h-0 flex-1"><PortfolioMonitorWidget /></div>
    </div>
  )
}
