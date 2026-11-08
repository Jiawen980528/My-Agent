// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { PortfolioMonitorWidget } from './PortfolioMonitorWidget'

vi.mock('echarts', () => ({ init: () => ({ setOption: vi.fn(), getOption: () => ({ dataZoom: [] }), on: vi.fn(), resize: vi.fn(), dispose: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ api: { klineMinuteRange: vi.fn() } }))

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === 'portfolio-instrument-search') return { data: { results: [{ symbol: '600939.SH', name: '重庆建工', code: '600939', asset_type: 'stock' }] } }
    if (queryKey[0] === 'portfolio-widget-snapshot') return { data: {
      source: 'TickFlow Pro', notice: '', items: [{ symbol: '159558.SZ', name: '半导体设备ETF易方达',
        holding_source: null, quantity: null, price: 0.8, change_pct: 1.2,
        market_timestamp: 1793950200001, board: { name: '半导体', code: 'BK1036' } }],
    } }
    if (queryKey[0] === 'portfolio-widget-minute') return { data: { source: 'TickFlow Pro', data: {
      '159558.SZ': [
        { datetime: '2026-11-06 09:30', close: 0.8, high: 0.8, low: 0.8 },
        { datetime: '2026-11-06 09:31', close: 0.81, high: 0.81, low: 0.8 },
      ],
    } } }
    if (queryKey[0] === 'portfolio-board-widget') return { data: { board: { name: '半导体', code: 'BK1036' },
      source: '东方财富公开行情', last_market_time: '2026-11-06 15:00',
      rows: [{ datetime: '2026-11-06 09:30', close: 100, high: 100, low: 100 },
        { datetime: '2026-11-06 09:31', close: 101, high: 101, low: 100 }],
      flow: [{ datetime: '2026-11-06 09:31', main_yi: 1.2 }],
    } }
    if (queryKey[0] === 'myagent-quant-news') return { data: { items: [{ title: '半导体新闻', url: 'https://example.com/a',
      source: '测试', sector_names: ['半导体'], bias: '待判断', relevance: '板块相关' }] } }
    if (queryKey[0] === 'portfolio-terminal-history') return { data: {
      account_snapshot: { total_assets: '111527.05', position_value: '108672.70', cash_available: '2854.35', total_pnl: '-28966.80', day_pnl: '-2925.10', source: 'user_screenshot_20261106', verified: 0 },
      trades: [{ fingerprint: 'trade-1', trade_date: '2026-11-06', trade_time: '09:34', symbol: '159558.SZ', side: 'sell', quantity: 23800, price: '0.803', commission: '5.00', cash_flow: '19106.40', source: 'user_provided_20261106', verified: false }],
      trade_summary: { trade_count: 1, total_fees: '5.00', realised_t_pnl: '0.00', method: '同日配对', notice: '未配对不计收益', items: [{ symbol: '159558.SZ', buy_quantity: 0, sell_quantity: 23800, net_quantity: -23800, matched_quantity: 0, unmatched_buy_quantity: 0, unmatched_sell_quantity: 23800, realised_t_pnl: '0.00', total_fees: '5.00' }] },
      notice: '待核对',
    } }
    if (queryKey[0] === 'portfolio-terminal-replay') return { data: {
      actual_vs_no_trade: '-900.00', realised_t_pnl: '-793.67', extra_position_effect: '-106.33',
      max_drawdown_yuan: '950.00', max_drawdown_pct_of_snapshot_assets: '0.85', hindsight_optimal_pnl: '3000.00',
      fill_validation: { checked: 1, within_range: 1 }, notice: '事后最优不是可执行信号',
      items: [{ symbol: '159558.SZ', source: '公开行情', minute_count: 240, actual_vs_no_trade: '-900.00', realised_t_pnl: '-793.67', extra_position_effect: '-106.33', hindsight_optimal_pnl: '3000.00' }],
    } }
    return { data: undefined }
  },
}))

it('opens a compact stock and board workspace with flow, news and unverified holding label', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><PortfolioMonitorWidget /></MemoryRouter>))
  const charts = host.querySelectorAll('[role="img"]')
  expect(charts).toHaveLength(2)
  expect(charts[0].getAttribute('aria-label')).toContain('半导体设备ETF易方达')
  expect(charts[1].getAttribute('aria-label')).toContain('半导体')
  expect(host.textContent).toContain('持仓未核实')
  expect(host.textContent).toContain('主力净流')
  expect(host.textContent).toContain('半导体新闻')
  expect(host.textContent).toContain('全部监控 1')
  expect(host.textContent).toContain('历史账户截图')
  expect(host.textContent).toContain('操作时间线 · 1 笔')
  expect(host.textContent).toContain('已配对做T净收益')
  expect(host.textContent).toContain('相对完全不交易')
  expect(host.textContent).toContain('事后理论最优')
  await act(async () => root.unmount())
})

it('lets the user right click to hide and restore board content', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver
  localStorage.removeItem('portfolio-terminal-visible')
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><PortfolioMonitorWidget /></MemoryRouter>))
  await act(async () => host.querySelector('section')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  const toggle = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes('关联板块') && button.getAttribute('role') === 'menuitemcheckbox')!
  await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.querySelectorAll('[role="img"]')).toHaveLength(1)
  await act(async () => root.unmount())
  localStorage.removeItem('portfolio-terminal-visible')
})

it('adds a security by name from the right-click search results', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver
  localStorage.removeItem('portfolio-terminal-extra-symbols')
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><PortfolioMonitorWidget /></MemoryRouter>))
  await act(async () => host.querySelector('section')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  const input = document.body.querySelector('input[aria-label="添加证券代码"]') as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, '重庆建工')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const result = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes('重庆建工'))!
  await act(async () => result.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.textContent).toContain('全部监控 2')
  await act(async () => root.unmount())
  localStorage.removeItem('portfolio-terminal-extra-symbols')
  localStorage.removeItem('portfolio-terminal-extra-symbol-names')
})

it('exposes real multi-period chart controls in the holding detail', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><PortfolioMonitorWidget /></MemoryRouter>))
  for (const label of ['1m', '5m', '15m', '30m', '60m', '日K', '周K']) expect(host.textContent).toContain(label)
  const fiveMinute = [...host.querySelectorAll('button')].find(button => button.textContent === '5m')!
  await act(async () => fiveMinute.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(host.textContent).toContain('真实5m数据')
  await act(async () => root.unmount())
})
