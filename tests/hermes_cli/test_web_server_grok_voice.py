"""Grok Voice endpoints inherit dashboard auth and bind the requested profile."""
import json

import pytest
from fastapi.testclient import TestClient


@pytest.mark.parametrize("profile", [None, "", " ", "current"])
def test_mint_requires_a_named_profile(monkeypatch, profile):
    from hermes_cli import web_server
    from tools import voice_xai_live as voice

    monkeypatch.setattr(voice, "create_grok_live_session", lambda: pytest.fail("must not mint"))
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    params = {} if profile is None else {"profile": profile}
    result = client.post("/api/audio/grok-live/session", params=params, json={})
    assert result.status_code == 400


def test_mint_keeps_profile_credentials_separate_across_worker_calls(monkeypatch, tmp_path):
    import time
    import httpx
    from hermes_cli import auth, web_server, web_server_profiles
    from hermes_constants import get_hermes_home
    from tools import voice_xai_live as voice

    homes = {name: tmp_path / name for name in ("alpha", "beta")}
    for home in homes.values():
        home.mkdir()
    original_home = get_hermes_home()
    monkeypatch.setattr(web_server_profiles, "_resolve_profile_dir", homes.__getitem__)
    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: {
        "provider": "xai-oauth", "api_key": f"synthetic-oauth-{get_hermes_home().name}",
    })
    requests = []
    real_client = httpx.Client

    def handle(request):
        requests.append(request.headers["authorization"])
        return httpx.Response(200, json={
            "value": "synthetic-ephemeral", "expires_at": int(time.time()) + 300,
        })

    monkeypatch.setattr(voice.httpx, "Client", lambda **kw: real_client(
        transport=httpx.MockTransport(handle), **kw))
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    for name in ("alpha", "beta", "alpha"):
        result = client.post("/api/audio/grok-live/session", params={"profile": name}, json={})
        assert result.status_code == 200
        assert "synthetic-oauth" not in result.text
    assert requests == ["Bearer synthetic-oauth-alpha", "Bearer synthetic-oauth-beta", "Bearer synthetic-oauth-alpha"]
    assert get_hermes_home() == original_home


def test_status_is_non_secret_and_mint_is_profile_scoped(monkeypatch, tmp_path):
    from hermes_cli import auth, web_server
    from hermes_cli import web_server_profiles
    from hermes_constants import get_hermes_home
    from tools import voice_xai_live as voice

    secondary = tmp_path / "secondary"
    secondary.mkdir()
    monkeypatch.setattr(web_server_profiles, "_resolve_profile_dir", lambda name: secondary)
    monkeypatch.setattr(auth, "_load_auth_store", lambda: {
        "providers": {"xai-oauth": {"tokens": {"access_token": "synthetic-oauth-secret-do-not-return"}}},
    })
    scopes = []

    def mint():
        scopes.append(get_hermes_home())
        return {"client_secret": {"value": "synthetic-ephemeral", "expires_at": 2000000000}}

    monkeypatch.setattr(voice, "create_grok_live_session", mint)
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    status = client.get("/api/audio/grok-live/status?profile=secondary")
    assert status.status_code == 200
    assert status.json()["available"] is True
    assert "synthetic-oauth-secret" not in status.text
    result = client.post("/api/audio/grok-live/session?profile=secondary", json={})
    assert result.status_code == 200
    assert result.json()["client_secret"]["value"] == "synthetic-ephemeral"
    assert result.headers["cache-control"] == "no-store"
    assert scopes == [secondary]


def test_anonymous_request_cannot_mint(monkeypatch):
    from hermes_cli import web_server
    from tools import voice_xai_live as voice

    def forbidden():
        raise AssertionError("anonymous request must not reach OAuth")

    monkeypatch.setattr(voice, "create_grok_live_session", forbidden)
    client = TestClient(web_server.app)
    result = client.post("/api/audio/grok-live/session", json={})
    assert result.status_code == 401


def test_voice_page_and_bundle_use_existing_auth_and_no_store(monkeypatch, tmp_path):
    from hermes_cli import web_server
    from hermes_cli.web_routers import audio

    (tmp_path / "dist").mkdir()
    (tmp_path / "index.html").write_text("<html><head></head><body>Voice panel</body></html>")
    (tmp_path / "dist" / "client.js").write_text("export const voicePanel = true;")
    monkeypatch.setattr(audio, "_grok_frontend_root", lambda: tmp_path, raising=False)
    client = TestClient(web_server.app)
    result = client.get("/api/audio/grok-live/client.js", follow_redirects=False)
    assert result.status_code == 401
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    result = client.get("/grok-voice/")
    assert result.status_code == 200
    assert "Voice panel" in result.text
    assert "__HERMES_AUTH_REQUIRED__" in result.text
    assert result.headers["cache-control"] == "no-store"
    result = client.get("/api/audio/grok-live/client.js")
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert "voicePanel" in result.text


def test_gated_voice_page_never_injects_process_credential(monkeypatch, tmp_path):
    import asyncio
    from hermes_cli import web_server
    from hermes_cli.web_routers import audio

    (tmp_path / "dist").mkdir()
    (tmp_path / "index.html").write_text("<html><head></head><body>Voice panel</body></html>")
    (tmp_path / "dist" / "client.js").write_text("export const voicePanel = true;")
    monkeypatch.setattr(audio, "_grok_frontend_root", lambda: tmp_path)
    monkeypatch.setattr(web_server.app.state, "auth_required", True, raising=False)
    response = asyncio.run(audio.grok_voice_page())
    text = response.body.decode()
    assert "__HERMES_AUTH_REQUIRED__=true" in text
    assert "__HERMES_SESSION_TOKEN__" not in text
    assert web_server._SESSION_TOKEN not in text
