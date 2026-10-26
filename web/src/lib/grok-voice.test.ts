// @vitest-environment jsdom
import pageHtml from '../../grok-voice/index.html?raw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountVoicePage } from '../../grok-voice/main'
import type { NativeApi } from '../../grok-voice/client'

const engine = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  complete: vi.fn(),
  checkScope: vi.fn(),
  subscribe: vi.fn(),
  snapshot: () => ({ state: 'idle', detail: '', delegations: 0 })
}))
vi.mock('../../../apps/shared/src/grok-voice/call', () => ({ createVoiceCall: () => engine }))

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

it('prepares Hermes without microphone or minting; starts directly in click and pagehide only stops local call', async () => {
  document.documentElement.innerHTML = pageHtml
  const api = vi.fn(async (path: string) => (path.includes('/status?') ? { available: true } : {}))
  const rpc = {
    request: vi.fn(async (method: string) =>
      method === 'session.list'
        ? { sessions: [{ id: 'stored', title: 'Bot Chat' }] }
        : { session_id: 'runtime', info: { model: 'hermes-original' } }
    ),
    connect: vi.fn(async () => {}),
    onAny: vi.fn(),
    onRequest: vi.fn(),
    onState: vi.fn(),
    close: vi.fn()
  }
  const cleanup = await mountVoicePage({
    api: api as unknown as NativeApi,
    gateway: rpc as unknown as Parameters<typeof mountVoicePage>[0]['gateway'],
    connect: async () => {}
  })
  const start = document.querySelector<HTMLButtonElement>('#start')!
  expect(start.disabled).toBe(false)
  expect(engine.start).not.toHaveBeenCalled()
  expect(api.mock.calls.some(([path]) => path.includes('/session?'))).toBe(false)
  start.click()
  expect(engine.start).toHaveBeenCalledTimes(1)
  expect(document.querySelector('#model')?.textContent).toContain('hermes-original')
  window.dispatchEvent(new Event('pagehide'))
  expect(engine.stop).toHaveBeenCalled()
  expect(rpc.request.mock.calls.some(([method]) => /cancel|interrupt|close|stop/.test(method))).toBe(false)
  cleanup()
})
import {
  createVoiceBridge,
  createNativeApi,
  gatewayConnection,
  validateVoiceSession,
  routeVoiceEvent
} from '../../grok-voice/client'

describe('native auth and scoped results', () => {
  it('uses cookies and one-use WS subprotocol ticket without putting it in the URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ticket: 'single-use' })))
    const api = createNativeApi({ authRequired: true, token: 'must-not-send' }, fetcher)
    const connection = await gatewayConnection('https://phone.example', true, undefined, api)
    expect(connection).toEqual({
      url: 'wss://phone.example/api/ws?profile=default',
      protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.single-use']
    })
    expect(fetcher.mock.calls[0][0]).toBe('/api/auth/ws-ticket')
    const init = fetcher.mock.calls[0][1] as RequestInit
    expect(init.credentials).toBe('same-origin')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).has('X-Hermes-Session-Token')).toBe(false)
  })
  it('uses injected loopback token only when the auth gate is off', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    const api = createNativeApi({ authRequired: false, token: 'local-only' }, fetcher)
    await api('/api/audio/grok-live/status?profile=default')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('X-Hermes-Session-Token')).toBe('local-only')
    expect((await gatewayConnection('http://localhost:9119', false, 'local-only', api)).url).toBe(
      'ws://localhost:9119/api/ws?profile=default&token=local-only'
    )
  })
  it('refuses any secret-bearing upstream except the fixed OAuth realtime endpoint', () => {
    const session = {
      ok: true,
      url: 'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
      protocol_prefix: 'xai-client-secret.',
      client_secret: { value: 'temporary', expires_at: Math.floor(Date.now() / 1000) + 300 },
      session: { voice: 'eve' }
    }
    expect(validateVoiceSession(session)).toBe(session)
    for (const bad of [
      { url: 'wss://evil.example' },
      { protocol_prefix: 'api-key.' },
      { client_secret: { value: '' } },
      { client_secret: { value: 'bad protocol secret', expires_at: Math.floor(Date.now() / 1000) + 300 } },
      { client_secret: { value: 'expired', expires_at: 1 } },
      { client_secret: { value: 'unbounded', expires_at: Math.floor(Date.now() / 1000) + 3600 } }
    ]) {
      expect(() => validateVoiceSession({ ...session, ...bad })).toThrow()
    }
  })
  it('routes only the selected runtime completion and exposes errors and approval requests', () => {
    const complete = vi.fn(),
      notice = vi.fn()
    const scope = { sessionId: 'runtime', key: 'default:runtime' }
    const route = (event: Parameters<typeof routeVoiceEvent>[0]) => routeVoiceEvent(event, scope, complete, notice)
    route({ type: 'message.complete', session_id: 'stored', payload: { text: 'wrong' } })
    expect(complete).not.toHaveBeenCalled()
    route({ type: 'message.complete', session_id: 'runtime', payload: { text: 'Résultat', client_turn_id: 'voice-turn' } })
    expect(complete).toHaveBeenLastCalledWith('runtime', scope.key, 'Résultat', 'voice-turn')
    route({ type: 'error', session_id: 'runtime', payload: { message: 'Échec' } })
    expect(notice).toHaveBeenLastCalledWith('Échec')
    expect(complete).toHaveBeenCalledTimes(1) // error can be advisory; only terminal message.complete settles the receipt
    route({ type: 'approval.request', session_id: 'runtime', payload: {} })
    expect(notice).toHaveBeenLastCalledWith(expect.stringContaining('tableau de bord'))
  })
})

describe('standalone voice session bridge', () => {
  it('lists canonical Bot Chat without creating it; resumes stored ID to runtime before submit', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list') return { sessions: [{ id: 'stored', title: 'Bot Chat' }] }
      if (method === 'session.resume') return { session_id: 'runtime', info: { model: 'original' } }
      return { status: 'streaming' }
    })
    const bridge = createVoiceBridge({ request })
    expect(await bridge.list()).toEqual([{ id: 'stored', title: 'Bot Chat' }])
    expect(request).toHaveBeenCalledWith('session.list', {
      profile: 'default',
      title: 'Bot Chat',
      include_hidden: true
    })
    await bridge.select('stored')
    expect(request).toHaveBeenCalledWith('session.resume', {
      session_id: 'stored',
      profile: 'default',
      close_on_disconnect: false
    })
    const scope = bridge.scope()
    expect(scope.sessionId).toBe('runtime')
    await bridge.submit(scope, 'Faites la recherche', 'user: contexte', 'voice-turn')
    expect(request).toHaveBeenLastCalledWith('prompt.submit', {
      profile: 'default',
      session_id: 'runtime',
      text: 'Faites la recherche',
      surface: 'voice-live',
      client_turn_id: 'voice-turn',
      voice_context: 'user: contexte'
    })
    expect(request.mock.calls.some(([method]) => method === 'session.create')).toBe(false)
  })
})
