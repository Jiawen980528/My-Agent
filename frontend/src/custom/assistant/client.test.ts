// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { assistantChatStream, decideAssistantAction, fetchAssistantStatus, fetchAssistantSuggests, getAssistantMode, setAssistantMode } from './client'

beforeEach(() => {
  localStorage.clear()
  vi.stubEnv('BASE_URL', '/quant/')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('uses current AI settings by default and preserves explicit MyAgent selection', () => {
  expect(getAssistantMode()).toBe('tickflow')
  setAssistantMode('myagent')
  expect(getAssistantMode()).toBe('myagent')
})

it('requests current AI status inside the stock-panel mount', async () => {
  setAssistantMode('tickflow')
  const status = { configured: true, provider: 'openai_compat', model: 'qwen3.7-plus', supports_tools: true }
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(status)))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchAssistantStatus()).toEqual(status)
  expect(fetch).toHaveBeenCalledWith('/quant/api/custom/assistant/status')
})

it('keeps MyAgent config and chat behind the stock-panel bridge', async () => {
  setAssistantMode('myagent')
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ model: 'qwen', api_key_configured: true, providers: [{ configured: true, label: 'Qwen', model: 'qwen' }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ reply: '你好' })))
  vi.stubGlobal('fetch', fetch)
  expect((await fetchAssistantStatus()).model).toBe('qwen')
  const events = []
  for await (const event of assistantChatStream({ messages: [{ role: 'user', content: '你好' }] })) events.push(event)
  expect(events).toEqual([{ type: 'delta', content: '你好' }, { type: 'done' }])
  expect(fetch.mock.calls[0][0]).toBe('/quant/api/myagent/config')
  expect(fetch.mock.calls[1][0]).toBe('/quant/api/myagent/chat')
})

it('streams replies, suggestions and confirmations through the same mount', async () => {
  setAssistantMode('tickflow')
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('{"type":"delta","content":"回答"}\n{"type":"done"}\n'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ suggests: [] })))
    .mockResolvedValueOnce(new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const events = []
  for await (const event of assistantChatStream({ messages: [{ role: 'user', content: '问题' }] })) events.push(event)
  expect(events).toEqual([{ type: 'delta', content: '回答' }, { type: 'done' }])
  await fetchAssistantSuggests()
  await decideAssistantAction('call-1', false)
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    '/quant/api/custom/assistant/chat', '/quant/api/custom/assistant/suggests', '/quant/api/custom/assistant/actions/call-1/decision',
  ])
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ approve: false })
})
