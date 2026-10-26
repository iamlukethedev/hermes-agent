import { JsonRpcGatewayClient } from '../../apps/shared/src/json-rpc-gateway'
import { createVoiceCall } from '../../apps/shared/src/grok-voice/call'
import { createAudio } from '../../apps/shared/src/grok-voice/audio'
import {
  approvalNotice,
  createNativeApi,
  createVoiceBridge,
  gatewayConnection,
  routeVoiceEvent,
  validateVoiceSession
} from './client'
import type { NativeApi } from './client'

interface PageDependencies {
  api: NativeApi
  gateway: Pick<JsonRpcGatewayClient, 'request' | 'onAny' | 'onRequest' | 'onState' | 'close'>
  connect(): Promise<void>
}

export async function mountVoicePage(deps: PageDependencies): Promise<() => void> {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const start = element<HTMLButtonElement>('start')
  const hangup = element<HTMLButtonElement>('hangup')
  const selection = element<HTMLSelectElement>('session')
  const create = element<HTMLButtonElement>('new-session')
  const retry = element<HTMLButtonElement>('retry')
  const status = element('status')
  const notice = element('notice')
  const model = element('model')
  const orb = element('orb')
  const bridge = createVoiceBridge(deps.gateway)
  let ready = false
  let disposed = false
  let revision = 0
  const disposers: (() => void)[] = []
  const inform = (text: string) => {
    notice.textContent = text
  }
  const call = createVoiceCall({
    scope: bridge.scope,
    audio: createAudio,
    mint: async () =>
      validateVoiceSession(
        await deps.api('/api/audio/grok-live/session?profile=default', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
      ),
    socket: (url, protocols) => new WebSocket(url, protocols),
    submit: bridge.submit
  })

  function render() {
    const snapshot = call.snapshot()
    const active = snapshot.state !== 'idle'
    start.hidden = active
    start.disabled = !ready || active
    hangup.hidden = !active
    selection.disabled = active || !ready
    create.disabled = active || !ready
    orb.dataset.state = snapshot.state
    status.textContent =
      snapshot.state === 'connecting'
        ? 'Connexion à Grok Voice…'
        : snapshot.state === 'live'
          ? snapshot.delegations
            ? 'Hermes travaille…'
            : 'À votre écoute'
          : snapshot.detail || (ready ? 'Prêt pour votre appel' : 'Préparation de votre conversation…')
  }

  async function select(storedId: string) {
    const version = ++revision
    ready = false
    call.stop()
    render()
    const result = await bridge.select(storedId)
    if (disposed || version !== revision) return
    const info = result.info as { model?: string } | undefined
    model.textContent = `Modèle Hermes : ${info?.model || 'celui de cette conversation (inchangé)'}`
    ready = true
    render()
  }

  function fail(error: unknown) {
    ready = false
    call.stop()
    render()
    status.textContent = 'Connexion Hermes à rétablir'
    inform(error instanceof Error ? error.message : 'Hermes est indisponible.')
    retry.hidden = false
    create.disabled = true
  }

  const subscribe = call.subscribe(render)
  if (subscribe) disposers.push(subscribe)
  const events = deps.gateway.onAny(event => {
    // Older gateways omit replay metadata; never accept an explicitly replayed completion.
    if (!('replayed' in event && event.replayed)) routeVoiceEvent(event, bridge.scope(), call.complete, inform)
  })
  if (events) disposers.push(events)
  const requests = deps.gateway.onRequest(() => {
    inform(approvalNotice)
    return true
  })
  if (requests) disposers.push(requests)
  const states = deps.gateway.onState(state => {
    if (state === 'closed' || state === 'error') fail(new Error('La liaison Hermes a été coupée. Reconnectez-vous.'))
  })
  if (states) disposers.push(states)

  const onStart = () => {
    if (!ready) return
    inform('')
    // Keep the audio unlock directly in the user gesture, before any network await.
    void call.start()
  }
  const onHangup = () => call.stop()
  const onChange = () => {
    void select(selection.value).catch(fail)
  }
  const onCreate = async () => {
    ready = false
    render()
    try {
      const created = await deps.gateway.request<{ stored_session_id: string; session_id: string }>('session.create', {
        profile: 'default',
        source: 'web',
        title: 'Conversation vocale',
        close_on_disconnect: false
      })
      const id = created.stored_session_id || created.session_id
      selection.add(new Option('Conversation vocale', id, true, true))
      await select(id)
    } catch (error) {
      fail(error)
    }
  }
  const onPageHide = () => {
    call.stop()
  }
  const onRetry = () => {
    window.location.reload()
  }
  start.addEventListener('click', onStart)
  hangup.addEventListener('click', onHangup)
  selection.addEventListener('change', onChange)
  create.addEventListener('click', onCreate)
  retry.addEventListener('click', onRetry)
  window.addEventListener('pagehide', onPageHide)

  try {
    await deps.connect()
    const voice = await deps.api<{ available: boolean; message?: string }>(
      '/api/audio/grok-live/status?profile=default'
    )
    if (!voice.available) throw new Error(voice.message || 'Connectez votre compte Grok par OAuth dans Hermes.')
    const sessions = await bridge.list()
    if (disposed) return () => {}
    selection.replaceChildren()
    if (sessions.length) {
      for (const session of sessions) selection.add(new Option(session.title || session.id, session.id))
      await select(selection.value)
    } else {
      selection.add(new Option('Créez une conversation vocale', ''))
      create.disabled = false
      status.textContent = 'Créez une conversation pour commencer'
    }
  } catch (error) {
    if (!disposed) fail(error)
  }

  return () => {
    disposed = true
    revision++
    call.stop()
    disposers.forEach(dispose => dispose())
    start.removeEventListener('click', onStart)
    hangup.removeEventListener('click', onHangup)
    selection.removeEventListener('change', onChange)
    create.removeEventListener('click', onCreate)
    retry.removeEventListener('click', onRetry)
    window.removeEventListener('pagehide', onPageHide)
    deps.gateway.close()
  }
}

function boot() {
  const bootstrap = window as Window & { __HERMES_AUTH_REQUIRED__?: boolean; __HERMES_SESSION_TOKEN__?: string }
  const gated = bootstrap.__HERMES_AUTH_REQUIRED__ !== false
  const token = gated ? undefined : bootstrap.__HERMES_SESSION_TOKEN__
  const api = createNativeApi({ authRequired: gated, token })
  let protocols: string[] = []
  const gateway = new JsonRpcGatewayClient({
    socketFactory: url => new WebSocket(url, protocols),
    requestIdPrefix: 'voice-'
  })
  void mountVoicePage({
    api,
    gateway,
    connect: async () => {
      const target = await gatewayConnection(location.origin, gated, token, api)
      protocols = target.protocols
      await gateway.connect(target.url)
    }
  })
}

if (document.getElementById('grok-voice')) boot()
