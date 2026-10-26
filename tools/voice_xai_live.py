"""Core-owned Grok Voice OAuth minting. No model tool or API-key fallback.

The authenticated renderer gets a 300-second client secret, never the OAuth
access/refresh token. Only the fixed xAI origin can receive that token.
"""
from __future__ import annotations

import time

import httpx

from tools.voice_live import LIVE_PERSONA

CLIENT_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets"
REALTIME_URL = "wss://api.x.ai/v1/realtime"
DEFAULT_MODEL = "grok-voice-latest"
DEFAULT_VOICE = "eve"
SECRET_TTL_SECONDS = 300

INSTRUCTIONS = (
    LIVE_PERSONA
    + '\n\nUse hermes_task to delegate. Its output is a receipt, not a result. '
    'The actual answer will arrive in a message labelled "[Hermes result]". '
    'Read that answer naturally; never invent a successful outcome. '
    'For a correction to running work, delegate the corrected request again. '
    'Use end_call only after the user clearly asks to end the call or says goodbye. '
    'Speak naturally in the language the user chooses.'
)
TOOLS = [
    {
        "type": "function", "name": "hermes_task",
        "description": "Hand a complete request to Hermes. The result arrives later as [Hermes result].",
        "parameters": {
            "type": "object", "properties": {"request": {"type": "string"}},
            "required": ["request"], "additionalProperties": False,
        },
    },
    {
        "type": "function", "name": "end_call",
        "description": "End the call only after a clear goodbye or explicit request to hang up.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


class GrokVoiceError(Exception):
    """Only fixed, credential-free messages may cross the HTTP boundary."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def resolve_grok_live_status() -> dict:
    from hermes_cli.auth import get_provider_auth_state, read_credential_pool

    # Do not call get_xai_oauth_auth_status/load_pool/select: those paths may
    # refresh, seed, or quarantine credentials. Read persisted snapshots only.
    def configured(entry):
        return (
            isinstance(entry, dict)
            and entry.get("last_status") != "dead"
            and any(isinstance(entry.get(key), str) and entry[key].strip()
                    for key in ("access_token", "refresh_token"))
        )

    try:
        entries = read_credential_pool("xai-oauth")
        state = get_provider_auth_state("xai-oauth") or {}
        marker = state.get("last_auth_error") or {}
        available = any(
            isinstance(entry, dict) and configured(entry) and entry.get("auth_type") == "oauth" for entry in entries
        ) or (not marker.get("relogin_required") and configured(state.get("tokens")))
    except Exception:
        available = False
    return {
        "available": available, "model": DEFAULT_MODEL, "voice": DEFAULT_VOICE,
        "message": None if available else "Connectez Grok par OAuth sur ce profil Hermes.",
    }


def create_grok_live_session() -> dict:
    from hermes_cli.auth import resolve_xai_oauth_runtime_credentials
    from tools.xai_http import hermes_xai_user_agent

    try:
        credentials = resolve_xai_oauth_runtime_credentials()
    except Exception:
        raise GrokVoiceError("Connexion OAuth Grok requise sur ce profil Hermes.", 503) from None
    token = credentials.get("api_key")
    if credentials.get("provider") != "xai-oauth" or not isinstance(token, str) or not token:
        raise GrokVoiceError("Connexion OAuth Grok requise, sans repli sur une clé API.", 503)
    try:
        with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as client:
            response = client.post(
                CLIENT_SECRETS_URL,
                headers={"Authorization": f"Bearer {token}", "User-Agent": hermes_xai_user_agent()},
                json={"expires_after": {"seconds": SECRET_TTL_SECONDS}},
            )
            if response.status_code != 200:
                raise GrokVoiceError(f"xAI a refusé la session vocale (HTTP {response.status_code}).")
            body = response.json()
    except GrokVoiceError:
        raise
    except Exception:
        raise GrokVoiceError("Impossible de joindre xAI pour démarrer la conversation vocale.") from None
    value = body.get("value") if isinstance(body, dict) else None
    expires = body.get("expires_at") if isinstance(body, dict) else None
    now = time.time()
    if (
        not isinstance(value, str) or not value or value == token
        or not isinstance(expires, (int, float)) or isinstance(expires, bool)
        or not now < expires <= now + SECRET_TTL_SECONDS + 30
    ):
        raise GrokVoiceError("Réponse de session xAI invalide.")
    return {
        "url": f"{REALTIME_URL}?model={DEFAULT_MODEL}",
        "protocol_prefix": "xai-client-secret.",
        "client_secret": {"value": value, "expires_at": int(expires)},
        "model": DEFAULT_MODEL,
        "session": {
            "voice": DEFAULT_VOICE, "instructions": INSTRUCTIONS,
            "reasoning": {"effort": "none"},
            "turn_detection": {"type": "server_vad"}, "tools": TOOLS,
            "audio": {
                "input": {"format": {"type": "audio/pcm", "rate": 24000}},
                "output": {"format": {"type": "audio/pcm", "rate": 24000}},
            },
        },
    }
