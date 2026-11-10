// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MonitorAlertWidget } from './MonitorAlertWidget'

vi.mock('@/lib/api', () => ({ api: { indexMinute: vi.fn() } }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { rows: [
    { date: '2026-11-10 09:30', close: 100 },
    { date: '2026-11-10 09:45', close: 99 },
    { date: '2026-11-10 10:00', close: 98 },
    { date: '2026-11-10 10:15', close: 97 },
    { date: '2026-11-10 10:30', close: 96 },
    { date: '2026-11-10 10:45', close: 95 },
  ] }, isLoading: false, isError: false }),
}))

it('persists the monitoring rule and pause state', async () => {
  localStorage.removeItem('myagent-monitor-alert-settings-v1')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(<MonitorAlertWidget />))
  const select = host.querySelector('select') as HTMLSelectElement
  await act(async () => {
    select.value = '000001.SH'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('监控中'))!
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(JSON.parse(localStorage.getItem('myagent-monitor-alert-settings-v1') || '{}')).toMatchObject({ symbol: '000001.SH', enabled: false })
  await act(async () => root.unmount())
  localStorage.removeItem('myagent-monitor-alert-settings-v1')
})
