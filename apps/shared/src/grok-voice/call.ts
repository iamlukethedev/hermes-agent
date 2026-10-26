// Adapted from Julien Talbot's hermes-xai desktop frontend (MIT; see LICENSE).
import { decodePcm, encodePcm } from './audio'

export interface VoiceSession {
  ok: boolean
  url: string
  protocol_prefix: string
  client_secret: { value: string; expires_at?: number }
  session: Record<string, unknown>
}
export interface VoiceScope {
  sessionId: string | null
  key: string
  owner?: { connectionId: string | null; profile: string | null }
}
export interface VoicePlayer {
  resume(): Promise<void>
  play(pcm: Int16Array): void
  flush(): void
  close(): void
}
export interface VoiceAudio {
  player: VoicePlayer
  startMic(onFrame: (frame: Float32Array) => void): Promise<() => void>
  close(): void
}
export interface VoiceSocket {
  readyState: number
  onopen: WebSocket['onopen']
  onmessage: WebSocket['onmessage']
  onclose: WebSocket['onclose']
  onerror: WebSocket['onerror']
  send(data: string): void
  close(): void
}
interface Dependencies {
  mint(scope: VoiceScope): Promise<VoiceSession>
  socket(url: string, protocols: string[]): VoiceSocket
  audio(): VoiceAudio
  scope(): VoiceScope
  submit(scope: VoiceScope, text: string, context: string, turnId: string): Promise<unknown>
}

export function createVoiceCall(deps: Dependencies) {
  let state: 'idle' | 'connecting' | 'live' = 'idle'
  let detail = ''
  let ws: VoiceSocket | null = null
  let audio: VoiceAudio | null = null
  let stopMic: (() => void) | null = null
  let generation = 0
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let endTimer: ReturnType<typeof setTimeout> | undefined
  let scope: VoiceScope | null = null
  let responding = false
  let spoke = false
  let owedTurn = false
  let hangUp = false
  let results: string[] = []
  let turns: string[] = []
  const toolIds = new Set<string>()
  // Keep cancelled calls' receipts until their final event arrives: same-session
  // results must never be attributed to a later call. One task at a time per scope.
  const pending: { generation: number; scope: VoiceScope; id: string; accepted: boolean; early?: string }[] = []
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach(fn => fn())

  const send = (event: object) => {
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify(event))
    }
  }

  const delegations = () => pending.filter(task => task.generation === generation).length

  function stop(note = '') {
    generation++
    clearTimeout(connectTimer)
    clearTimeout(endTimer)
    connectTimer = endTimer = undefined
    const socket = ws
    ws = null

    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null
      socket.close()
    }

    stopMic?.()
    stopMic = null
    audio?.close()
    audio = null
    scope = null
    responding = spoke = owedTurn = hangUp = false
    results = []
    turns = []
    toolIds.clear()
    state = 'idle'
    detail = note
    publish()
  }

  function checkScope() {
    const currentScope = deps.scope()

    if (scope && (currentScope.key !== scope.key || currentScope.sessionId !== scope.sessionId)) {
      stop('Appel terminé : la conversation ou le profil a changé.')
    }
  }

  function remember(role: string, value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
      return
    }

    turns.push(`${role}: ${value.trim().slice(0, 3000)}`)
    turns = turns.slice(-12)
  }

  function flushResults() {
    if (!results.length || responding || !ws) {
      return
    }

    const text = results.join('\n\n')
    results = []
    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[Hermes result] ${text}` }] }
    })
    send({ type: 'response.create' })
    responding = true
  }

  function complete(sessionId: string, key: string, text: string, turnId?: unknown) {
    const index = pending.findIndex(task => task.scope.sessionId === sessionId && task.id === turnId)

    if (index < 0) {
      return
    }

    const task = pending[index]
    checkScope()

    if (task.generation !== generation || task.scope.key !== key || !ws) {
      pending.splice(index, 1)

      return
    }

    if (!task.accepted) {
      task.early = text

      return
    }

    pending.splice(index, 1)

    results.push(text.trim().slice(0, 3000) || 'Hermes a terminé sans résultat à lire.')
    flushResults()
    publish()
  }

  function onTool(name: string, callId: string, raw: string) {
    if (toolIds.has(callId)) {
      return
    }

    toolIds.add(callId)
    let args: { request?: unknown } = {}

    try {
      args = JSON.parse(raw) || {}
    } catch {
      /* rejected below */
    }

    let output: object = { ok: false, error: 'Outil inconnu ou requête invalide.' }

    if (name === 'end_call') {
      hangUp = true
      output = { ok: true }
    } else if (name === 'hermes_task' && typeof args.request === 'string' && args.request.trim()) {
      const captured = scope

      if (!captured?.sessionId) {
        output = { ok: false, error: 'Ouvrez une conversation Hermes avant de déléguer.' }
      } else if (pending.some(task => task.scope.key === captured.key)) {
        output = { ok: false, error: 'Une tâche Hermes est déjà en cours pour cette conversation.' }
      } else {
        const task: (typeof pending)[number] = {
          generation, scope: captured, id: crypto.randomUUID(), accepted: false
        }

        pending.push(task)
        owedTurn = true
        output = { receipt: 'started', note: 'Le résultat arrivera dans un message [Hermes result].' }
        void deps.submit(captured, args.request.trim(), turns.join('\n'), task.id).then(receipt => {
          const result = receipt as { status?: string; client_turn_id?: string } | null

          if (result?.status !== 'streaming' || result.client_turn_id !== task.id) {
            throw new Error('Uncorrelated or unaccepted submission')
          }

          task.accepted = true

          if (task.early !== undefined) {
            complete(captured.sessionId!, captured.key, task.early, task.id)
          }
        }).catch(() => {
          const index = pending.indexOf(task)

          if (index >= 0) {
            pending.splice(index, 1)
          }

          if (task.generation !== generation) {
            return
          }

          results.push('La tâche Hermes n’a pas pu démarrer.')
          flushResults()
          publish()
        })
        publish()
      }
    }

    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) }
    })
  }

  async function start() {
    if (state !== 'idle') {
      return
    }

    const token = ++generation
    scope = deps.scope()

    const current = () => {
      checkScope()

      return generation === token
    }

    state = 'connecting'
    detail = ''
    publish()
    connectTimer = setTimeout(() => {
      if (current()) {
        stop('Délai de connexion à Grok Voice dépassé. Réessayez.')
      }
    }, 30000)

    try {
      // Resume synchronously from the click, before mint/permission awaits.
      const resource = deps.audio()
      audio = resource
      await resource.player.resume()

      if (!current()) {
        return
      }

      const minted = await deps.mint(scope!)

      if (!current()) {
        return
      }

      const socket = deps.socket(minted.url, [`${minted.protocol_prefix}${minted.client_secret.value}`])
      ws = socket

      socket.onopen = () => {
        if (current()) {
          send({ type: 'session.update', session: minted.session })
        }
      }

      let micStarting = false

      socket.onmessage = async ({ data }) => {
        if (!current()) {
          return
        }

        let event

        try {
          event = JSON.parse(data)
        } catch {
          return
        }

        try {
          switch (event.type) {
            case 'session.updated': {
              if (micStarting) {
                break
              }

              micStarting = true
              clearTimeout(connectTimer)
              connectTimer = undefined

              const release = await resource.startMic(frame => {
                if (current() && state === 'live') {
                  send({ type: 'input_audio_buffer.append', audio: encodePcm(frame) })
                }
              })

              if (!current()) {
                release()

                return
              }

              stopMic = release
              state = 'live'
              publish()

              break
            }

            case 'input_audio_buffer.speech_started':
              resource.player.flush()

              break

            case 'response.created':
              responding = true
              spoke = false

              break

            case 'response.output_audio.delta':

            case 'response.audio.delta':
              if (typeof event.delta === 'string') {
                spoke = true
                resource.player.play(decodePcm(event.delta))
              }

              break

            case 'conversation.item.input_audio_transcription.completed':
              remember('user', event.transcript)

              break

            case 'response.output_audio_transcript.done':

            case 'response.audio_transcript.done':
              remember('assistant', event.transcript)

              break

            case 'response.function_call_arguments.done':
              onTool(String(event.name || ''), String(event.call_id || ''), String(event.arguments || '{}'))

              break

            case 'response.done':
              responding = false

              if (hangUp) {
                endTimer = setTimeout(() => {
                  if (current()) {
                    stop()
                  }
                }, 1500)

                break
              }

              if (owedTurn && !spoke && !results.length) {
                send({ type: 'response.create' })
                responding = true
              }

              owedTurn = false
              flushResults()

              break

            case 'error':
              stop('Grok Voice a signalé une erreur. Réessayez l’appel.')

              break
          }
        } catch {
          if (current()) {
            stop('Audio indisponible. Vérifiez les autorisations du microphone.')
          }
        }
      }

      socket.onerror = () => {
        if (current()) {
          stop('Erreur de connexion à Grok Voice.')
        }
      }

      socket.onclose = () => {
        if (current()) {
          stop('L’appel vocal est terminé.')
        }
      }
    } catch (error) {
      if (current()) {
        stop(error instanceof Error ? error.message : 'Grok Voice indisponible.')
      }
    }
  }

  return {
    start,
    stop,
    complete,
    checkScope,
    snapshot: () => ({ state, detail, delegations: delegations() }),
    subscribe(fn: () => void) {
      listeners.add(fn)

      return () => {
        listeners.delete(fn)
      }
    }
  }
}
