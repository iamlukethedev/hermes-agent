"""Grok Voice uses native OAuth only; the renderer receives a short-lived credential."""
import json
import time

import httpx
import pytest


@pytest.mark.parametrize("state,available", [
    ({}, False),
    ({"providers": {"xai-oauth": {"tokens": {
        "access_token": "synthetic-expired-access", "refresh_token": "synthetic-refresh",
        "expires_at": 1,
    }}}}, True),
    ({"credential_pool": {"xai-oauth": [{
        "auth_type": "oauth", "access_token": "synthetic-expired-access", "refresh_token": "synthetic-refresh",
    }]}}, True),
])
def test_readiness_snapshot_never_resolves_or_refreshes(monkeypatch, state, available):
    from hermes_cli import auth
    from tools import voice_xai_live as voice

    monkeypatch.setattr(auth, "_load_auth_store", lambda: state)
    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda **kw: pytest.fail("must not refresh"))
    monkeypatch.setattr(voice.httpx, "Client", lambda **kw: pytest.fail("must not contact provider"))
    result = voice.resolve_grok_live_status()
    assert result["available"] is available
    assert "synthetic" not in json.dumps(result)


def test_mint_returns_ephemeral_credential_without_oauth(monkeypatch):
    from tools import voice_xai_live as voice
    from hermes_cli import auth

    captured = []
    oauth = "synthetic-oauth-not-a-real-token"
    ephemeral = "synthetic-short-lived-not-a-real-token"
    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: {
        "provider": "xai-oauth", "api_key": oauth,
        "base_url": "https://ignored.example/no-credential-egress",
    })
    real_client = httpx.Client

    def handle(request):
        captured.append(request)
        return httpx.Response(200, json={"value": ephemeral, "expires_at": int(time.time()) + 300})

    monkeypatch.setattr(voice.httpx, "Client", lambda **kwargs: real_client(
        transport=httpx.MockTransport(handle), **kwargs))
    result = voice.create_grok_live_session()

    assert len(captured) == 1
    assert str(captured[0].url) == "https://api.x.ai/v1/realtime/client_secrets"
    assert captured[0].headers["authorization"] == f"Bearer {oauth}"
    assert json.loads(captured[0].content) == {"expires_after": {"seconds": 300}}
    assert result["client_secret"]["value"] == ephemeral
    assert oauth not in json.dumps(result)
    assert result["url"].startswith("wss://api.x.ai/v1/realtime?model=grok-voice-")
    assert result["session"]["audio"]["input"]["format"]["rate"] == 24000
    assert {tool["name"] for tool in result["session"]["tools"]} == {"hermes_task", "end_call"}
    assert result["session"]["reasoning"] == {"effort": "none"}


@pytest.mark.parametrize("provider", ["xai", "openrouter", None])
def test_no_api_key_fallback(monkeypatch, provider):
    from tools import voice_xai_live as voice
    from hermes_cli import auth

    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: {
        "provider": provider, "api_key": "synthetic-api-key",
    })
    monkeypatch.setattr(voice.httpx, "Client", lambda **kwargs: pytest.fail("must not send a non-OAuth key"))
    with pytest.raises(voice.GrokVoiceError) as caught:
        voice.create_grok_live_session()
    assert caught.value.status == 503
    assert "synthetic-api-key" not in str(caught.value)


@pytest.mark.parametrize("status", [302, 401, 403, 429, 500])
def test_provider_errors_never_echo_credentials_or_follow_redirects(monkeypatch, status):
    from tools import voice_xai_live as voice
    from hermes_cli import auth

    oauth = "synthetic-private-token"
    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: {
        "provider": "xai-oauth", "api_key": oauth,
    })
    real_client = httpx.Client
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(status, headers={"location": "https://untrusted.example/"},
                              json={"error": f"provider echoes {oauth}"})

    monkeypatch.setattr(voice.httpx, "Client", lambda **kwargs: real_client(
        transport=httpx.MockTransport(handle), **kwargs))
    with pytest.raises(voice.GrokVoiceError) as caught:
        voice.create_grok_live_session()
    assert oauth not in str(caught.value)
    assert len(requests) == 1


@pytest.mark.parametrize("body", [
    {"value": "synthetic-oauth", "expires_at": 2000000000},
    {"value": "synthetic-ephemeral", "expires_at": 1},
    {"value": "synthetic-ephemeral", "expires_at": 9000000000},
    {"value": "synthetic-ephemeral"}, [],
])
def test_rejects_long_lived_or_invalid_mint_answers(monkeypatch, body):
    from tools import voice_xai_live as voice
    from hermes_cli import auth

    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: {
        "provider": "xai-oauth", "api_key": "synthetic-oauth",
    })
    real_client = httpx.Client
    monkeypatch.setattr(voice.httpx, "Client", lambda **kwargs: real_client(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json=body)), **kwargs))
    with pytest.raises(voice.GrokVoiceError, match="invalide"):
        voice.create_grok_live_session()
