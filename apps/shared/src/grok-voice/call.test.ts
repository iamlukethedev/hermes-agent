import { describe, expect, it, vi } from 'vitest'

import { encodePcm } from './audio'
import { createVoiceCall } from './call'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void

  const promise = new Promise<T>((r, fail) => {
    resolve = r
    reject = fail
  })

  return { promise, resolve, reject }
}

const minted = {
  ok: true,
  url: 'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
  protocol_prefix: 'xai-client-secret.',
  client_secret: { value: 'ephemeral-test' },
  session: { voice: 'eve' }
}

class Socket {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: any[] = []
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close = vi.fn()
  receive(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

function setup(overrides = {}) {
  const socket = new Socket()
  const player = { resume: vi.fn(() => Promise.resolve()), close: vi.fn(), flush: vi.fn(), play: vi.fn() }
  const stop = vi.fn()

  const deps = {
    mint: vi.fn(async () => minted),
    socket: vi.fn(() => socket),
    audio: vi.fn(() => ({ player, startMic: vi.fn(async () => stop), close: player.close })),
    scope: () => ({ sessionId: 'chat-1', key: 'local/default/chat-1' }),
    submit: vi.fn(async (_scope: unknown, _text: string, _context: string, turnId: string) => ({
      status: 'streaming', client_turn_id: turnId
    })),
    ...overrides
  }

  return { call: createVoiceCall(deps), deps, socket, player, stop }
}

describe('Grok voice lifecycle', () => {
  it('never attributes an unrelated completion or a queued submission to the voice task', async () => {
    const receipt = deferred<{ status: string; client_turn_id?: string }>()
    const submit = vi.fn((_scope: unknown, _text: string, _context: string, _turnId: string) => receipt.promise)
    const s = setup({ submit })
    await s.call.start()
    s.socket.receive({ type: 'response.function_call_arguments.done', name: 'hermes_task',
      call_id: 'voice-task', arguments: '{"request":"new task"}' })
    const turnId = submit.mock.calls[0][3]
    s.call.complete('chat-1', 'local/default/chat-1', 'Unrelated running turn', 'other-turn')
    expect(s.call.snapshot().delegations).toBe(1)
    s.call.complete('chat-1', 'local/default/chat-1', 'Must wait for acceptance', turnId)
    expect(s.socket.sent.some(e => e.item?.content?.[0]?.text?.includes('Must wait'))).toBe(false)
    receipt.resolve({ status: 'queued' })
    await Promise.resolve()
    await Promise.resolve()
    expect(s.call.snapshot().delegations).toBe(0)
    expect(s.socket.sent.some(e => JSON.stringify(e).includes('Unrelated running turn'))).toBe(false)
    expect(s.socket.sent.some(e => JSON.stringify(e).includes('Must wait for acceptance'))).toBe(false)
    s.call.stop()
  })

  it('buffers a matching early completion until the exact streaming receipt is accepted', async () => {
    const receipt = deferred<{ status: string; client_turn_id: string }>()
    const submit = vi.fn((_scope: unknown, _text: string, _context: string, _turnId: string) => receipt.promise)
    const s = setup({ submit })
    await s.call.start()
    s.socket.receive({ type: 'response.function_call_arguments.done', name: 'hermes_task',
      call_id: 'voice-task', arguments: '{"request":"new task"}' })
    const turnId = submit.mock.calls[0][3]
    s.call.complete('chat-1', 'local/default/chat-1', 'Own result', turnId)
    expect(s.call.snapshot().delegations).toBe(1)
    receipt.resolve({ status: 'streaming', client_turn_id: turnId })
    await Promise.resolve()
    expect(s.call.snapshot().delegations).toBe(0)
    expect(s.socket.sent.some(e => e.item?.content?.[0]?.text?.includes('Own result'))).toBe(true)
    s.call.stop()
  })
  it('ends a call when the same focused id loses its resolved owner', async () => {
    let scope: { sessionId: string | null; key: string } = { sessionId: 'chat-1', key: 'same-owner-key' }
    const s = setup({ scope: () => scope })
    await s.call.start()
    scope = { sessionId: null, key: 'same-owner-key' }
    s.call.checkScope()
    expect(s.call.snapshot().state).toBe('idle')
  })
  it('times out a missing session acknowledgement and releases resources', async () => {
    vi.useFakeTimers()
    const s = setup()

    try {
      await s.call.start()
      s.socket.onopen?.()
      vi.advanceTimersByTime(30000)
      expect(s.call.snapshot().state).toBe('idle')
      expect(s.call.snapshot().detail).toMatch(/délai/i)
      expect(s.player.close).toHaveBeenCalledOnce()
    } finally {
      s.call.stop()
      vi.useRealTimers()
    }
  })
  it('lets goodbye audio play but never lets an old end-call timer stop a later call', async () => {
    vi.useFakeTimers()
    const s = setup()

    try {
      await s.call.start()
      s.socket.receive({
        type: 'response.function_call_arguments.done',
        name: 'end_call',
        call_id: 'bye',
        arguments: '{}'
      })
      s.socket.receive({ type: 'response.done' })
      expect(s.call.snapshot().state).toBe('connecting')
      s.call.stop()
      await s.call.start()
      vi.advanceTimersByTime(1500)
      expect(s.call.snapshot().state).toBe('connecting')
    } finally {
      s.call.stop()
      vi.useRealTimers()
    }
  })
  it('streams mic PCM, plays provider PCM, and interrupts playback on speech', async () => {
    let onFrame!: (frame: Float32Array) => void
    const player = { resume: async () => {}, close: vi.fn(), flush: vi.fn(), play: vi.fn() }

    const s = setup({
      audio: () => ({
        player,
        close: player.close,
        startMic: async (fn: typeof onFrame) => {
          onFrame = fn

          return vi.fn()
        }
      })
    })

    await s.call.start()
    s.socket.receive({ type: 'session.updated' })
    await Promise.resolve()
    onFrame(new Float32Array([1, -1]))
    expect(s.socket.sent.at(-1)).toEqual({
      type: 'input_audio_buffer.append',
      audio: encodePcm(new Float32Array([1, -1]))
    })
    s.socket.receive({ type: 'response.output_audio.delta', delta: encodePcm(new Float32Array([1])) })
    expect(Array.from(player.play.mock.calls[0][0])).toEqual([32767])
    s.socket.receive({ type: 'input_audio_buffer.speech_started' })
    expect(player.flush).toHaveBeenCalledOnce()
    s.call.stop()
  })
  it('delegates with captured session and bounded voice context then returns final text to Grok', async () => {
    const s = setup()
    await s.call.start()
    s.socket.receive({ type: 'session.updated' })
    await Promise.resolve()
    s.socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Faites une recherche'
    })
    s.socket.receive({ type: 'response.created' })
    s.socket.receive({
      type: 'response.function_call_arguments.done',
      name: 'hermes_task',
      call_id: 'tool-1',
      arguments: JSON.stringify({ request: 'Recherchez ceci' })
    })
    expect(s.deps.submit).toHaveBeenCalledWith(
      { sessionId: 'chat-1', key: 'local/default/chat-1' },
      'Recherchez ceci',
      'user: Faites une recherche',
      expect.any(String)
    )
    await Promise.resolve()
    const turnId = s.deps.submit.mock.calls[0][3]
    s.call.complete('chat-2', 'local/default/chat-1', 'Mauvais résultat', turnId)
    expect(s.call.snapshot().delegations).toBe(1)
    s.call.complete('chat-1', 'local/default/chat-1', 'Résultat utile', turnId)
    expect(s.socket.sent.some(e => e.item?.content?.[0]?.text?.includes('Résultat utile'))).toBe(false)
    s.socket.receive({ type: 'response.done' })
    expect(s.socket.sent).toContainEqual({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Hermes result] Résultat utile' }] }
    })
    expect(s.socket.sent.at(-1)).toEqual({ type: 'response.create' })
    s.call.stop()
  })
  it('does not deliver a previous calls result to a new call on the same session', async () => {
    const s = setup()

    const tool = () =>
      s.socket.receive({
        type: 'response.function_call_arguments.done',
        name: 'hermes_task',
        call_id: String(Math.random()),
        arguments: '{"request":"task"}'
      })

    await s.call.start()
    tool()
    s.call.stop()
    await s.call.start()
    tool()
    expect(s.call.snapshot().delegations).toBe(0)
    expect(s.deps.submit).toHaveBeenCalledTimes(1)
    s.call.complete('chat-1', 'local/default/chat-1', 'Ancien résultat', s.deps.submit.mock.calls[0][3])
    expect(s.socket.sent.some(e => e.item?.content?.[0]?.text?.includes('Ancien résultat'))).toBe(false)
    tool()
    expect(s.call.snapshot().delegations).toBe(1)
    await Promise.resolve()
    s.call.complete('chat-1', 'local/default/chat-1', 'Nouveau résultat', s.deps.submit.mock.calls[1][3])
    expect(s.call.snapshot().delegations).toBe(0)
    s.call.stop()
  })
  it('rejects delegation after scope changes and ignores late async failures', async () => {
    let scope = { sessionId: 'chat-1', key: 'local/default/chat-1' }
    const task = deferred<unknown>()
    const s = setup({ scope: () => scope, submit: () => task.promise })
    await s.call.start()
    scope = { sessionId: 'chat-2', key: 'local/other/chat-2' }
    s.socket.receive({
      type: 'response.function_call_arguments.done',
      name: 'hermes_task',
      call_id: 'wrong',
      arguments: '{"request":"task"}'
    })
    expect(s.call.snapshot().state).toBe('idle')
    await s.call.start()
    s.socket.receive({
      type: 'response.function_call_arguments.done',
      name: 'hermes_task',
      call_id: 'new',
      arguments: '{"request":"task"}'
    })
    s.call.stop()
    task.reject(new Error('Late failure from the old call'))
    await Promise.resolve()
    expect(s.call.snapshot().delegations).toBe(0)
  })
  it('does not resurrect a socket after hangup during mint', async () => {
    const mint = deferred<typeof minted>()
    const s = setup({ mint: () => mint.promise })
    const pending = s.call.start()
    await Promise.resolve()
    s.call.stop()
    mint.resolve(minted)
    await pending
    expect(s.deps.socket).not.toHaveBeenCalled()
    expect(s.call.snapshot().state).toBe('idle')
  })
  it('releases a late microphone after hangup without resurrecting live state', async () => {
    const mic = deferred<() => void>()
    const close = vi.fn()

    const s = setup({
      audio: () => ({
        player: { resume: async () => {}, close, flush() {}, play() {} },
        close,
        startMic: () => mic.promise
      })
    })

    await s.call.start()
    s.socket.receive({ type: 'session.updated' })
    s.call.stop()
    const stop = vi.fn()
    mic.resolve(stop)
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
    expect(s.call.snapshot().state).toBe('idle')
  })
  it('surfaces socket failures and releases audio', async () => {
    const s = setup()
    await s.call.start()
    s.socket.onerror?.()
    expect(s.call.snapshot().state).toBe('idle')
    expect(s.call.snapshot().detail).toMatch(/connexion/i)
    expect(s.player.close).toHaveBeenCalledOnce()
  })
  it('handles mint rejection without leaking audio or rejecting the click', async () => {
    const s = setup({
      mint: async () => {
        throw new Error('OAuth indisponible')
      }
    })

    await expect(s.call.start()).resolves.toBeUndefined()
    expect(s.call.snapshot().detail).toBe('OAuth indisponible')
    expect(s.player.close).toHaveBeenCalledOnce()
  })
  it('unlocks audio at the click, sends config, and waits for acknowledgement before live capture', async () => {
    const s = setup()
    const pending = s.call.start()
    expect(s.player.resume).toHaveBeenCalledOnce()
    await pending
    s.socket.onopen?.()
    expect(s.socket.sent).toEqual([{ type: 'session.update', session: minted.session }])
    expect(s.call.snapshot().state).toBe('connecting')
    s.socket.receive({ type: 'session.updated' })
    await Promise.resolve()
    expect(s.call.snapshot().state).toBe('live')
    s.call.stop()
    expect(s.stop).toHaveBeenCalledOnce()
    expect(s.player.close).toHaveBeenCalledOnce()
    expect(s.socket.close).toHaveBeenCalledOnce()
  })
})
