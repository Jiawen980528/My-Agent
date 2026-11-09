// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SharedAISelector } from './SharedAISelector'

const mocks = vi.hoisted(() => ({ profiles: vi.fn(), select: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { sharedAiProfiles: mocks.profiles, selectSharedAi: mocks.select } }))
let root: Root
let qc: QueryClient
const node = document.createElement('div')
document.body.append(node)
const data = { mode: 'auto', active_id: 'qwen', items: [
  { id: 'qwen', model: 'qwen3.7-plus', label: 'qwen.example' },
  { id: 'deepseek', model: 'deepseek-chat', label: 'deepseek.example' },
] }
async function render() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  root = createRoot(node)
  await act(async () => root.render(<QueryClientProvider client={qc}><SharedAISelector /></QueryClientProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.profiles.mockReset().mockResolvedValue(data)
  mocks.select.mockReset().mockResolvedValue({ ok: true })
})
afterEach(() => { act(() => root?.unmount()); qc?.clear(); node.innerHTML = '' })

it('lists saved models and saves manual selection without asking for credentials', async () => {
  await render()
  const select = node.querySelector('select')!
  expect(select.disabled).toBe(false)
  expect(select.value).toBe('auto')
  expect(node.textContent).toContain('qwen3.7-plus')
  await act(async () => { select.value = 'deepseek'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(mocks.select).toHaveBeenCalledWith('deepseek', 'manual')
  expect(node.querySelector('input[type=password]')).toBeNull()
})

it('auto selection preserves the current primary profile', async () => {
  mocks.profiles.mockResolvedValue({ ...data, mode: 'manual' })
  await render()
  const select = node.querySelector('select')!
  expect(select.value).toBe('qwen')
  await act(async () => { select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(mocks.select).toHaveBeenCalledWith('qwen', 'auto')
})

it('shows a configuration error without pretending that a model is available', async () => {
  mocks.profiles.mockRejectedValue(new Error('offline'))
  await render()
  expect(node.textContent).toContain('无法读取统一 AI 配置')
  expect(node.querySelector('select')).toBeNull()
})
