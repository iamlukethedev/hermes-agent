import type { VoiceSession, VoiceScope } from '../../apps/shared/src/grok-voice/call'
import type { SessionListRow, SessionResumeResult } from '../../apps/shared/src/gateway-contract.generated'

export type NativeApi = <T>(path: string, init?: RequestInit) => Promise<T>

export function createNativeApi(
  auth: { authRequired: boolean; token?: string },
  fetcher: typeof fetch = fetch
): NativeApi {
  return async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    // Only relative, same-origin Hermes API paths may receive native auth.
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#')) throw new Error('Adresse API invalide.')
    const headers = new Headers(init.headers)
    if (!auth.authRequired && auth.token) headers.set('X-Hermes-Session-Token', auth.token)
    const response = await fetcher(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 401 || response.status === 403)
      throw new Error('Reconnectez-vous à Hermes pour utiliser la voix.')
    if (!response.ok) throw new Error('Hermes est indisponible. Réessayez depuis le tableau de bord.')
    return response.json() as Promise<T>
  }
}

export async function gatewayConnection(origin: string, gated: boolean, token: string | undefined, api: NativeApi) {
  const url = new URL('/api/ws?profile=default', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (gated) {
    const { ticket } = await api<{ ticket: string }>('/api/auth/ws-ticket', { method: 'POST' })
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9._~-]+$/.test(ticket))
      throw new Error('Connexion sécurisée indisponible.')
    return { url: url.toString(), protocols: ['hermes-gateway-v1', `hermes-gateway-ticket.${ticket}`] }
  }
  if (!token) throw new Error('Authentification Hermes absente. Ouvrez cette page depuis Herald.')
  url.searchParams.set('token', token)
  return { url: url.toString(), protocols: ['hermes-gateway-v1'] }
}

export function validateVoiceSession(value: unknown): VoiceSession {
  const session = value as VoiceSession | undefined
  if (
    !session ||
    session.ok !== true ||
    session.url !== 'wss://api.x.ai/v1/realtime?model=grok-voice-latest' ||
    session.protocol_prefix !== 'xai-client-secret.' ||
    typeof session.client_secret?.value !== 'string' ||
    !/^[A-Za-z0-9._~-]+$/.test(session.client_secret.value) ||
    typeof session.client_secret.expires_at !== 'number' ||
    !Number.isFinite(session.client_secret.expires_at) ||
    session.client_secret.expires_at <= Date.now() / 1000 ||
    session.client_secret.expires_at > Date.now() / 1000 + 330 ||
    !session.session ||
    typeof session.session !== 'object'
  ) {
    throw new Error('Session Grok Voice OAuth invalide.')
  }
  return session
}

export const approvalNotice =
  'Une confirmation est nécessaire dans le tableau de bord Hermes. Votre tâche reste en attente.'

export function routeVoiceEvent(
  event: { type: string; session_id?: string; profile?: string; payload?: unknown },
  scope: VoiceScope,
  complete: (sessionId: string, key: string, text: string, turnId?: unknown) => void,
  notice: (text: string) => void
) {
  if (!scope.sessionId || event.session_id !== scope.sessionId || (event.profile && event.profile !== 'default')) return
  const payload = (event.payload ?? {}) as Record<string, unknown>
  if (event.type === 'message.complete') {
    const failed = payload.status === 'error' || payload.status === 'interrupted'
    const text = failed
      ? 'La tâche Hermes s’est arrêtée. Consultez le tableau de bord pour les détails.'
      : typeof payload.text === 'string'
        ? payload.text
        : 'Hermes a terminé sans texte à lire.'
    complete(scope.sessionId, scope.key, text, payload.client_turn_id)
    if (failed) notice(text)
  } else if (event.type === 'error') {
    notice(typeof payload.message === 'string' ? payload.message : 'Hermes a signalé une erreur.')
  } else if (
    event.type === 'approval.request' ||
    event.type === 'input.request' ||
    event.type === 'connection.request'
  ) {
    notice(approvalNotice)
  }
}

export interface Rpc {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
}

export function createVoiceBridge(rpc: Rpc) {
  let sessionId: string | null = null
  let revision = 0
  const scope = (): VoiceScope => ({ sessionId, key: `default:${revision}:${sessionId ?? ''}` })
  return {
    scope,
    list: async () =>
      (
        await rpc.request<{ sessions: SessionListRow[] }>('session.list', {
          profile: 'default',
          title: 'Bot Chat',
          include_hidden: true
        })
      ).sessions,
    async select(storedId: string) {
      const generation = ++revision
      sessionId = null
      const result = await rpc.request<SessionResumeResult>('session.resume', {
        session_id: storedId,
        profile: 'default',
        close_on_disconnect: false
      })
      if (generation === revision) sessionId = result.session_id
      return result
    },
    submit(captured: VoiceScope, text: string, context: string, turnId: string) {
      if (!captured.sessionId || captured.key !== scope().key)
        return Promise.reject(new Error('Conversation modifiée.'))
      return rpc.request('prompt.submit', {
        profile: 'default',
        session_id: captured.sessionId,
        text,
        surface: 'voice-live',
        client_turn_id: turnId,
        voice_context: context
      })
    }
  }
}
