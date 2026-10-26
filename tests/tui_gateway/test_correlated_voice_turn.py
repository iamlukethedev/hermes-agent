"""Correlated submissions cannot attach another turn's terminal event."""
import threading
from types import SimpleNamespace

from tui_gateway import server


def _session(running=False):
    return {
        "history_lock": threading.RLock(), "running": running,
        "history": [], "attached_images": [], "session_key": "synthetic-session",
    }


def test_correlated_claim_rejects_a_busy_session_without_queuing():
    session = _session(running=True)
    error, _ = server._lock_in_submit_turn(
        "rpc", "sid", session, "voice task", {"client_turn_id": "synthetic-voice-turn"}, False, None, None)
    assert error and error["error"]["code"] == 4091
    assert "queued_prompt" not in session
    assert "inflight_turn" not in session


def test_correlation_id_is_owned_by_claimed_turn():
    session = _session()
    error, _ = server._lock_in_submit_turn(
        "rpc", "sid", session, "voice task", {"client_turn_id": "synthetic-voice-turn"}, False, None, None)
    assert error is None
    assert session["inflight_turn"]["client_turn_id"] == "synthetic-voice-turn"


def test_complete_echoes_the_claimed_id_before_clearing_inflight(monkeypatch):
    session = _session(running=True)
    session["inflight_turn"] = {"client_turn_id": "newer-turn-must-not-be-echoed", "user": "voice task"}
    monkeypatch.setattr(server, "_get_usage", lambda agent: {})
    monkeypatch.setattr(server, "_is_bot_mode_session", lambda session: False)
    monkeypatch.setattr(server, "render_message", lambda *a: "")
    state = SimpleNamespace(result={"final_response": "done"}, agent=object(), terminal_callback=None,
                            receipt_committed=False, client_turn_id="synthetic-voice-turn")
    payload, _, _ = server._complete_turn_payload(session, state, None, 80)
    assert payload["client_turn_id"] == "synthetic-voice-turn"
    assert session["inflight_turn"] is None


def test_terminal_error_echoes_the_same_id(monkeypatch):
    session = _session(running=True)
    session["inflight_turn"] = {"client_turn_id": "synthetic-voice-turn", "user": "voice task"}
    events = []
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload: events.append((kind, payload)))
    monkeypatch.setattr(server, "render_message", lambda *a: "")
    server._emit_terminal_turn_error("sid", session, "synthetic failure", retire_marker=False)
    assert events[-1][0] == "message.complete"
    assert events[-1][1]["client_turn_id"] == "synthetic-voice-turn"


def test_error_uses_explicit_snapshot_not_a_replaced_turn(monkeypatch):
    session = _session(running=True)
    session["inflight_turn"] = {"client_turn_id": "newer-turn-must-not-be-echoed", "user": "newer task"}
    events = []
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload: events.append((kind, payload)))
    monkeypatch.setattr(server, "render_message", lambda *a: "")
    server._emit_terminal_turn_error("sid", session, "synthetic failure", retire_marker=False,
                                     client_turn_id="synthetic-voice-turn")
    assert events[-1][1]["client_turn_id"] == "synthetic-voice-turn"
