import { Link } from 'react-router-dom'
import { ArrowLeft, LayoutDashboard } from 'lucide-react'
import { PortfolioMonitorWidget } from '@/components/dashboard/PortfolioMonitorWidget'

/** 独立持仓实时工作区；看板中的同一组件仍保留。 */
export function PortfolioTerminal() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-base p-2 text-foreground sm:p-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <Link to="/" className="rounded-btn p-1.5 text-muted hover:bg-elevated hover:text-foreground" title="返回看板" aria-label="返回看板"><ArrowLeft className="h-4 w-4" /></Link>
          <div><h1 className="text-sm font-semibold">我的持仓 · 实时工作区</h1><p className="text-[11px] text-muted">手工/截图确认的持仓 · 只读行情 · 不连接券商、不自动下单</p></div>
        </div>
        <Link to="/" className="inline-flex items-center gap-1 rounded-btn border border-border px-2 py-1 text-xs text-accent hover:bg-elevated"><LayoutDashboard className="h-3.5 w-3.5" />看板布局</Link>
      </div>
      <div className="min-h-0 flex-1"><PortfolioMonitorWidget /></div>
    </div>
  )
}
