// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { StockAnalysis } from './Page'

const apiMock = vi.hoisted(() => ({
  klineDaily: vi.fn(async () => ({ rows: [] })),
  stockAnalysisLevels: vi.fn(async () => ({ levels: {} })),
  klineMinute: vi.fn(async () => ({ date: '2026-11-11', source: 'live', rows: [{ datetime: '2026-11-11 10:00:00', open: 10, high: 10.2, low: 9.9, close: 10.1, volume: 100, amount: 1010 }], prev_close: 10, asset_type: 'stock' })),
  myagentResearchPool: vi.fn(async () => ({ items: [{ symbol: '600519.SH', name: '贵州茅台', theme: '消费', segment: '白酒', role: '龙头', rationale: '用户资料中的行业龙头观察标的', source: '课程资料', source_date: '2026-11-01', source_file: '资料.xlsx' }], sources: ['资料.xlsx'] })),
  myagentQuantLatestScan: vi.fn(async () => ({ items: [{ symbol: '600519.SH', name: '贵州茅台', score: 88, priority: 'A', entry_status: '回踩观察', pattern: '量价待确认', volume_multiple: 2.3 }], count: 1, generated_at: '2026-11-11 10:00:00' })),
  myagentQuantQuotes: vi.fn(async () => ({ items: [{ symbol: '600519', name: '贵州茅台', price: 1500, pct: 1.2, turnover: 0.5, volume_ratio: 1.3 }], source: '公开行情' })),
  myagentQuantNews: vi.fn(async () => ({ items: [{ title: '白酒行业动态', url: 'https://example.com/news', source: '测试新闻', sector_names: ['白酒'] }] })),
  myagentQuantAi: vi.fn(async () => ({ reply: '结论：继续观察' })),
  overviewMarket: vi.fn(async () => ({ breadth: { up: 3000, down: 2000 }, amount: { total: 1_000_000_000_000 }, emotion: { label: '中性' }, indices: [] })),
}))
vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('@/lib/stockAnalysisStore', () => ({
  loadHistory: vi.fn(), useHistoryReports: () => ({ reports: [], loaded: true }),
  startAnalysis: vi.fn(), findTodayReport: vi.fn(), deleteReport: vi.fn(), openHistoryReport: vi.fn(),
}))
vi.mock('@/components/financials/StockFinancialSearch', () => ({ StockFinancialSearch: () => null }))
vi.mock('@/components/StockPreviewDialog', () => ({ StockPreviewDialog: () => null }))
vi.mock('@/components/stock-analysis/AnalysisKChart', () => ({ AnalysisKChart: () => null }))
vi.mock('@/components/EChartsIntraday', () => ({ EChartsIntraday: () => <div>分钟走势已显示</div> }))
vi.mock('@/components/financials/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }))

it('opens the stock named in the URL instead of the previously viewed stock', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.setItem('last_stock:stock-analysis', JSON.stringify({ symbol: '000001.SZ', name: '旧股票' }))
  const host = document.createElement('div')
  const root = createRoot(host)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/stock-analysis?symbol=600519.SH&name=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0']}>
        <QueryClientProvider client={queryClient}><StockAnalysis /></QueryClientProvider>
      </MemoryRouter>,
    ))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(host.textContent).toContain('贵州茅台')
    expect(host.textContent).toContain('资料池 × 拾贝扫描 × 实时证据')
    expect(host.textContent).toContain('消费')
    expect(host.textContent).toContain('88 分 · A级')
    expect(host.textContent).toContain('分钟走势已显示')
    expect(apiMock.klineDaily).toHaveBeenCalledWith('600519.SH', 250)
    expect(apiMock.klineDaily).not.toHaveBeenCalledWith('000001.SZ', 250)
  } finally {
    await act(async () => root.unmount())
    queryClient.clear()
    localStorage.clear()
  }
})
