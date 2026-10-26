# Grok Voice browser reference

An optional authenticated, French-language reference client for the OAuth-only Grok Voice backend. **This is not native Herald integration.** Mobile app source is not included; native audio/UI, selected-bot wiring, approvals, and physical-phone acceptance remain Herald work.

## Build and open

From the repository root, with the project's JavaScript dependencies installed:

```bash
node web/grok-voice/build.mjs
```

The server expects `web/grok-voice/dist/client.js`. Use the existing authenticated Hermes backend and open `/grok-voice/` on its HTTPS origin, for example `https://hermes.example.test/grok-voice/`. Missing HTML/bundle produces HTTP 503. This page is an accessory, not a replacement dashboard or chat implementation. A headless backend may not serve a dashboard at `/`.

The **default profile** needs an existing Hermes `xai-oauth` login. Loading the page checks readiness and lists exact-title `Bot Chat` sessions; it does not mint or request the microphone. Select/resume a conversation, then explicitly start the call. If none is available, the new-conversation button deliberately creates a side chat. Each start mints a fresh short-lived secret. Hangup/pagehide releases local call resources but does not cancel work already submitted to Hermes.

## Boundaries

- `main.ts` mounts the UI; `client.ts` handles same-origin REST, existing gateway auth, session selection, and event filtering. Its `createNativeApi` name does not mean a mobile API adapter has been implemented.
- The call engine and browser audio adapter live in `apps/shared/src/grok-voice/`. They are adapted from Julien Talbot's `hermes-xai`; preserve their attribution and [MIT license](../../apps/shared/src/grok-voice/LICENSE).
- The reference hardcodes `default` for REST and JSON-RPC. Native clients must use the selected bot's connection/profile consistently, including scope keys, results, and approvals.
- Subscription OAuth stays on the Hermes host. The browser receives only an ephemeral credential for the fixed xAI realtime endpoint. No API-key fallback is provided.
- Audio is raw PCM16 little-endian, mono, 24 kHz, base64 over WebSocket. Microphone capture starts only after `session.updated`; server-VAD speech detection flushes local playback.
- Hermes delegation uses the resumed runtime session ID, `surface: "voice-live"`, `voice_context`, and a fresh `client_turn_id`. Both the streaming receipt and terminal `message.complete` must echo that ID. Busy/queued sessions and isolated compute-worker dispatch return RPC 4091; wait for idle or explicitly select a side chat. Older/uncorrelated gateways fail closed. A tool receipt is not completion.
- Approval/input/connection requests only display a notice here. Resolve them through an existing working Hermes confirmation surface; this page neither implements confirmation controls nor bypasses protections.
- No automatic reconnect or locked-screen continuation is implemented. Do not bypass sandbox HTML-preview CSP to embed the page.
- OAuth readiness is not voice entitlement, quota, unlimited use, or a cost guarantee. Account consent and provider billing/top-up settings are separate and untouched. Ordinary chat-model and STT/TTS settings remain unchanged.

## Verification

```bash
npx vitest run --config web/grok-voice/vitest.config.ts
node web/grok-voice/browser-smoke.mjs
scripts/run_tests.sh tests/tools/test_voice_xai_live.py tests/hermes_cli/test_web_server_grok_voice.py tests/tui_gateway/test_voice_live_delegation.py tests/tui_gateway/test_correlated_voice_turn.py -q
```

These are verification commands, not a passing-test claim. The browser smoke test uses Playwright/Chromium with simulated auth, audio, provider, and gateway traffic. The optional page requires a source checkout and local build; generated files are ignored, and this contribution does not change Python wheel asset packaging. Keep live-provider probes separate from isolated tests and obtain account-owner consent. Browser/unit results do not establish native phone acceptance. Never attach tokens, connection details, raw logs, or recordings to the PR.

See the [maintainer integration guide](../../website/docs/developer-guide/grok-voice-herald.md) for endpoint contracts, authentication, native iOS/Android audio requirements, acceptance checklist, and rollback.
