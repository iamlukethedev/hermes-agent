---
title: Grok Voice OAuth and native Herald integration
sidebar_label: Grok Voice / Herald
---

# Grok Voice OAuth and native Herald integration

This contribution provides an OAuth-only realtime voice backend, a reusable call engine, an authenticated browser reference client, and integration tests. It **does not implement native Herald voice**: the mobile application's source is not available in this checkout. Native iOS/Android UI, audio adapters, selected-bot wiring, approval presentation, and phone acceptance remain work for Herald maintainers.

The intended product is an **opt-in alternate talk mode**, not a replacement for the existing chat model or chained speech-to-text/text-to-speech mode. Grok handles the realtime spoken conversation; Hermes remains responsible for delegated work, its existing conversation model, tools, and approvals.

## Scope and non-goals

- Reuse the selected Hermes profile's existing `xai-oauth` login. Subscription access and refresh tokens stay in trusted Hermes backend code.
- Give the client only a short-lived xAI client secret and a constrained session configuration.
- Send audio directly between the client and xAI; use the existing Hermes JSON-RPC gateway for delegated tasks and final results.
- Preserve existing chat-model/provider choices, STT/TTS configuration, tool authorization, and confirmation requirements.
- Do not add an API key or silently fall back to the separately billed `xai` API-key provider.
- Do not modify provider account consent, subscription tier, quota, top-up settings, or payment preferences.
- Do not weaken HTML-preview CSP, sandboxing, or microphone policy to embed this mode in a preview. The reference is a separate authenticated page, not a sandbox escape or a native extension.

**OAuth readiness is not voice entitlement or a price guarantee.** A stored login can exist while realtime minting or audio use is denied by provider policy, tier, quota, or account state. Successful minting alone does not establish usable audio, unlimited use, subscription coverage, or lower cost. Obtain account-owner consent for live provider tests and evaluate current provider terms separately.

## Implementation map

| File or area | Responsibility |
| --- | --- |
| `tools/voice_xai_live.py` | Core-owned OAuth resolution, fixed-origin ephemeral minting, realtime configuration, credential-free errors |
| `hermes_cli/web_routers/audio.py` | Profile-scoped REST endpoints and authenticated reference-page/bundle routes |
| `apps/shared/src/grok-voice/call.ts` | Dependency-injected call state, realtime events, delegation receipts, result delivery, teardown |
| `apps/shared/src/grok-voice/audio.ts` | Browser PCM encoding/decoding, AudioWorklet capture, queued playback |
| `apps/shared/src/grok-voice/LICENSE` | MIT notice for adaptations from Julien Talbot's `hermes-xai` |
| `web/grok-voice/client.ts` | Same-origin REST helper, gateway auth, response validation, default-profile session bridge and event filtering |
| `web/grok-voice/main.ts` and `index.html` | Optional French-language reference UI, not mobile app source |
| `tui_gateway/methods_prompt.py`, `prompt_turn.py`, and contracts | Existing `voice-live` surface/context plus opt-in idle-only `client_turn_id` correlation on submissions and terminal events |

Keep the upstream attribution comments and MIT license when reusing the adapted engine/audio code. Shared location does not make the browser AudioWorklet adapter a native audio implementation.

## Authentication and profile ownership

Configure OAuth through Hermes's existing provider authorization UI/CLI, not a new mobile token importer. See the [official xAI Grok OAuth guide](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth) for the current login flow. For an existing profile named `example-bot`, a profile-targeted login can be started with:

```bash
hermes --profile example-bot auth add xai-oauth
```

Do not select a new default chat model just to enable voice. Do not copy subscription tokens into app settings, prompts, browser storage, URLs, crash reports, or plugins. Login flows can evolve; use Hermes's supported flow rather than implementing a parallel OAuth client.

Readiness reads persisted snapshots through `read_credential_pool()` and `get_provider_auth_state()` only. It deliberately avoids `get_xai_oauth_auth_status()`, pool loading/selection, and runtime resolution because those paths can refresh credentials. Expired stored tokens may still be reported as configured; no provider validity or entitlement is established. Explicit minting calls `resolve_xai_oauth_runtime_credentials()`, which may refresh the existing grant. Although its credential dictionary calls the bearer field `api_key`, this module requires `provider == "xai-oauth"`; that field name is **not** permission to supply an API key.

For native Herald, capture the selected bot's **connection, profile, and conversation** before starting. Use its existing HTTPS/auth stack for REST and its authenticated gateway connection for JSON-RPC. A profile query parameter selects scope; it does not create a new authorization scheme or grant access by itself.

The browser reference intentionally hardcodes `default` throughout REST, gateway connection, session selection, submission, and event filtering. It is not a generic selected-profile client. Native maintainers must replace that assumption consistently; changing just the mint URL is insufficient and risks cross-profile task execution or result disclosure.

## REST contract

All routes inherit the existing dashboard authentication boundary. Successful responses below carry `Cache-Control: no-store`. Preserve that behavior through reverse proxies, service workers, and app HTTP caches; never cache mint responses.

| Method and route | Behavior |
| --- | --- |
| `GET /api/audio/grok-live/status?profile=example-bot` | Returns `{ok, available, model, voice, message}` without returning or refreshing a subscription grant. `available` means persisted OAuth material is configured and not explicitly marked dead/relogin-required; it is not a token-validity or entitlement probe. |
| `POST /api/audio/grok-live/session?profile=example-bot` | Requires an explicit named `profile`; absent/blank and the ambient `current` alias return HTTP 400. Returns `{ok: true, url, protocol_prefix, client_secret, model, session}`. No request-body configuration is consumed; the reference sends `{}`. |
| `GET /grok-voice/` | Serves the optional reference page if its HTML and built bundle exist; otherwise HTTP 503. |
| `GET /api/audio/grok-live/client.js` | Serves the built JavaScript bundle; missing bundle returns HTTP 503. |

Use an authenticated origin such as `https://hermes.example.test`. Do not publish real connection URLs or credentials in examples.

### Mint response fields

- `url`: exactly `wss://api.x.ai/v1/realtime?model=grok-voice-latest`.
- `protocol_prefix`: exactly `xai-client-secret.`.
- `client_secret.value`: ephemeral secret, never the subscription bearer.
- `client_secret.expires_at`: provider expiry expressed as Unix seconds.
- `model`: `grok-voice-latest`.
- `session`: configuration to send in `session.update`, including voice `eve`, `reasoning: {effort: "none"}`, `turn_detection: {type: "server_vad"}`, tools, and input/output `audio/pcm` at rate `24000`.

Instructions request natural speech in the language the user chooses. Native UI must localize its own labels and error presentation; the reference UI and some backend messages are French. The default voice is Eve (`eve` on the wire).

The backend requests a 300-second secret lifetime. Its response validation requires a nonempty string distinct from the OAuth bearer and a numeric, nonboolean expiry later than now and no more than 330 seconds ahead (a 30-second tolerance). Do not describe this as an exact five-minute call-duration limit: credential expiry and an established call's lifetime are separate provider concerns. Mint a fresh secret for **every connection attempt**, and do not persist or reuse it for reconnect.

### Outbound and error constraints

Minting always POSTs to `https://api.x.ai/v1/realtime/client_secrets` with `expires_after: {seconds: 300}`. It uses a 20-second HTTP timeout, disables redirects, and sets `trust_env=False` so proxy environment variables cannot redirect the bearer. A resolver-supplied base URL is not used for credential egress. Do not broaden this to arbitrary custom endpoints.

Missing/unusable OAuth resolution is reported as HTTP 503. Provider rejection, network/parse failure, and invalid mint response are reported as HTTP 502 using fixed credential-free messages; provider rejection includes only the upstream HTTP status, not its response body. Dashboard authentication failures are handled by the existing auth layer. A provider 401/403/429 is not automatically a reason to switch credentials, change billing, or retry forever.

### Browser reference authentication

The page uses the existing dashboard mechanism rather than a second password or token system:

- Auth-gated mode uses same-origin cookies for REST and obtains a one-use ticket via `POST /api/auth/ws-ticket`. Its Hermes gateway handshake uses `hermes-gateway-v1` and `hermes-gateway-ticket.<ticket>` subprotocols; the ticket is not placed in the URL.
- In non-gated loopback mode, the page receives the server's existing process-session bootstrap token, uses `X-Hermes-Session-Token` for REST, and uses the existing token query parameter for the gateway socket. An auth-gated response must never inject that process token.
- The helper named `createNativeApi` in `client.ts` is a browser fetch wrapper, **not** an implemented native Herald API client. It restricts requests to relative Hermes `/api/` paths.

Do not copy loopback bootstrap behavior into remotely served mobile HTML. Native Herald should reuse its existing connection authentication and keep Hermes authentication distinct from the ephemeral credential sent to xAI.

## Realtime handshake and audio

The implemented browser sequence is:

1. On an explicit user gesture, unlock/resume audio locally. Loading the page must not mint or open the microphone.
2. Capture scope and mint a fresh ephemeral secret through the authenticated Hermes route.
3. Validate the returned fixed URL/protocol and open the xAI socket with browser subprotocol `xai-client-secret.<client_secret.value>`.
4. On socket open, send `{type: "session.update", session: <returned session>}`.
5. Wait for `session.updated` **before** starting microphone capture and sending frames. A socket-open event is not session readiness.
6. Send `input_audio_buffer.append` with base64-encoded raw PCM: signed 16-bit **little-endian**, mono, 24 kHz. Do not send WAV headers, Opus, compressed clips, or unconverted device-rate buffers.
7. Play PCM from `response.output_audio.delta` (also accepts `response.audio.delta`). These frames use the same output format.
8. On `input_audio_buffer.speech_started`, immediately flush locally queued playback for barge-in. The reference relies on provider server VAD; it does not send a separate manual cancellation command here.
9. Stop and release resources on hangup, errors, ownership changes, disposal, or connection closure.

A native WebSocket library may support a provider-approved native authentication handshake; verify its ephemeral-secret support rather than substituting the long-lived OAuth bearer. The browser's subprotocol form is the executable reference in this PR.

The browser adapter requests a 24 kHz AudioContext, rejects unsupported actual rates, captures through an AudioWorklet, batches roughly 100 ms frames, and connects its capture graph through a muted gain node so the microphone is not monitored locally. It enables browser echo cancellation, noise suppression, and automatic gain control. This is not a general-purpose resampler.

The call engine has `idle`, `connecting`, and `live` states. It times out an unacknowledged connection after 30 seconds; that timer is cleared on `session.updated`, so it is not a microphone-permission timeout. Cancellation generations prevent late mint/mic completions and old hangup timers from resurrecting or stopping another call. An `end_call` tool requests local teardown after `response.done` and a short playback grace period; an explicit hangup stops immediately.

## Delegating to the existing Hermes conversation

Do not rebuild chat or create a hidden side conversation on every call. The reference uses the existing `JsonRpcGatewayClient` and gateway contracts:

1. `session.list` with `{profile: "default", title: "Bot Chat", include_hidden: true}` discovers canonical exact-title Bot Chat sessions without creating one.
2. `session.resume` receives the selected **stored** session ID with `close_on_disconnect: false`. Its returned `session_id` is the **runtime** ID used for submissions and event matching. Do not confuse these IDs.
3. Only the explicit new-conversation button calls `session.create`, with source `web`, title `Conversation vocale`, and `close_on_disconnect: false`. It is a deliberate side-chat fallback, not automatic Bot Chat replacement.
4. A Grok `hermes_task` call carries a complete nonblank `request`. The engine generates a fresh UUID and submits it as `client_turn_id` through `prompt.submit`, alongside the captured runtime ID, owning profile, `text`, `surface: "voice-live"`, and recent `voice_context`.
5. Grok receives `function_call_output` containing a **receipt**, not a successful task result. Do not narrate acceptance as completed work.
6. Acceptance requires `status: "streaming"` and an exact `client_turn_id` echo. A non-replayed Hermes `message.complete` must match that ID and session, not merely be the next completion on the conversation. A matching terminal event that races ahead of the RPC reply is buffered until acceptance. Only then does the engine inject a text message prefixed `[Hermes result]` into Grok and request a spoken response. Errors/interruption must not be announced as success.

`client_turn_id` is an optional gateway-contract extension, validated as 1-128 ASCII letters/digits or `._~-`. For clients that send it, the server rejects a busy/queued conversation with RPC error `4091`, before steering or queuing it, and checks again atomically when claiming the turn. Normal chat clients that omit it retain existing behavior. The ID is captured by the claimed turn and echoed on terminal success/error, not inferred from whichever session happens to be current. Isolated compute-worker dispatch is currently unsupported for correlated submissions and also returns `4091`; the reference fails closed instead of falling back to session-only matching. Wait for idle/use the explicit side-chat option, or extend the isolated-worker protocol before enabling that deployment mode. Keep backend, generated gateway contracts, and client versions aligned; an older gateway's missing/uncorrelated receipt must never be treated as accepted.

The engine retains recent spoken turns for context, bounded to twelve entries and 3,000 characters per entry; the gateway bounds `voice_context` to 6,000 characters for model input. It is not a new persisted chat-history replacement. Final spoken result text is bounded to 3,000 characters by the engine; retain the full Hermes conversation as the authoritative record.

Only one pending delegation per scope is accepted by this engine. Tool call IDs are deduplicated within a call. Canceled calls retain pending receipt bookkeeping until their terminal event arrives, preventing a previous call's result from being read into a later call on the same conversation. This bookkeeping is not a server-side cancellation API. Hangup/pagehide **does not cancel an already submitted Hermes task**.

For native scope, include connection identity, profile, stored selection, runtime session, and a selection revision in a stable scope key. `VoiceScope.owner` can carry connection/profile metadata, but the engine's `checkScope()` compares `key` and `sessionId`; merely changing `owner` without changing the key does not enforce isolation. Call scope checks when the selection/owner changes, and ignore stale events and async completions. A reconnect must resolve the selected conversation again and must not silently move pending work to another bot.

## Approvals and confirmations

Grok's `hermes_task` is a delegation boundary, not a second unrestricted tool executor. Keep Hermes's existing authorization, input, and connection confirmation flows intact.

The browser reference only displays a notice for `approval.request`, `input.request`, and `connection.request`; it **does not implement confirmation controls or auto-approve requests**. Its server-request handler displays the same notice without resolving the underlying approval. Users must use a working existing Hermes confirmation surface. A headless `hermes serve` backend does not necessarily provide a dashboard at `/`; do not link users there as if a functional approval UI were guaranteed.

Native Herald must route these requests to its existing confirmation UX for the correct bot/session, or clearly report that approval is unavailable and leave the task pending. Do not answer approval requests on the user's behalf, suppress denied actions, or weaken tool protections to make a voice demo finish.

## Native implementation handoff

### UI and connection ownership

Add a discoverable, optional realtime mode beside the existing talk mode. Display the selected bot, microphone state, connecting/live/error state, delegation progress, and an explicit hangup control. Preserve normal chat and chained STT/TTS behavior when this mode is off. Present provider/account consent and quota uncertainty before first use; a readiness indicator is not billing consent.

Bind minting, gateway submission, event routing, and approvals to the same captured owner. Stop the call on bot/profile/conversation change or connection loss. Localize the French reference labels/messages rather than assuming they suit all Herald installations.

### iOS

Implement capture/playback with `AVAudioSession` and `AVAudioEngine` (or the app's existing audio stack). Choose and test the appropriate play-and-record/session mode and speaker/headset routing. Convert actual hardware input to mono 24 kHz PCM16 little-endian, and convert provider output for the active output route. Do not assume the hardware runs at 24 kHz.

Handle permission denial, delayed permission responses, route changes, Bluetooth/headset transitions, audio-session interruptions, competing calls, and app lifecycle changes. Remove taps, stop engines, flush queued playback, deactivate/release the audio session as appropriate, and close the socket on teardown. A capture permission result arriving after hangup must immediately release its resources.

### Android

Implement capture with `AudioRecord` and playback with `AudioTrack` (or the existing stack), including explicit resampling/channel conversion to/from mono 24 kHz PCM16 little-endian. Verify actual device capabilities and byte order. Manage microphone permission, audio focus, speaker/Bluetooth/headset routing, interruptions, and lifecycle teardown. Stop/release recorders and tracks and clear queued playback on cancellation.

### Backgrounding and reconnect

The reference stops on pagehide and does not implement automatic reconnect or locked-screen continuation. Do not promise background/locked-screen native calling until the relevant OS permissions, foreground-service/background-audio behavior, privacy indicators, interruptions, and teardown have been implemented and accepted on physical phones. A safe initial native release may stop on background/lock and require an explicit new call, minting a fresh secret each time.

## Build and verification

From the repository root, using the checkout's supported Node/Python environment:

```bash
node web/grok-voice/build.mjs
npx vitest run --config web/grok-voice/vitest.config.ts
node web/grok-voice/browser-smoke.mjs
scripts/run_tests.sh tests/tools/test_voice_xai_live.py tests/hermes_cli/test_web_server_grok_voice.py tests/tui_gateway/test_voice_live_delegation.py tests/tui_gateway/test_correlated_voice_turn.py -q
```

The optional reference page requires a source checkout and a local build at `web/grok-voice/dist/client.js`; its generated bundle is intentionally not committed. This does not add reference assets to Python wheel packaging. A missing build is an explicit 503, not a reason to serve unbundled TypeScript. The browser smoke test requires the workspace's Playwright dependency and Chromium (`npx playwright install chromium` if needed); it mocks all REST/WebSocket traffic and the microphone, and uses no production credentials or provider inference. Run Python tests through the isolated project runner. Do not infer passing results merely from test files being present.

Relevant behavioral coverage includes synthetic OAuth-only minting, fixed-origin/no-redirect behavior, malformed/expired mint responses, authenticated/profile-scoped routes, browser auth/tickets, durable-to-runtime session selection, scoped result delivery, PCM capture/playback, barge-in, and late asynchronous cleanup. Review actual execution output for the exact suite being released; these commands are a verification recipe, **not a claim that CI or phone tests passed**.

Keep live-provider checks separate from automated tests. A developer has reported a separate successful French audio probe; that is not CI evidence and does not establish native Herald usability or current account entitlement. For a release candidate, use an account-owner-approved neutral audio fixture and verify both transcription and returned audible speech. Publish only sanitized outcomes, not recordings, secrets, account details, connection URLs, or raw provider traffic.

### Native acceptance checklist (not yet completed by this PR)

- [ ] Native app source/build is available and reviewed; realtime mode is actually wired into the shipping iOS/Android UI.
- [ ] The feature is opt-in and the existing chat model/provider, STT, TTS, billing/top-up preferences, and approvals remain unchanged.
- [ ] OAuth readiness, account consent, voice entitlement, quota/cost understanding, and usable audio are evaluated independently.
- [ ] Anonymous minting fails; explicit-profile minting and gateway events stay with the selected connection/profile through A-to-B-to-A selection changes.
- [ ] Each attempt mints a fresh secret; only ephemeral credentials reach xAI from the app; no auth material reaches logs, analytics, storage, screenshots, or crash reports.
- [ ] The client waits for `session.updated` before microphone streaming and converts actual hardware audio to/from the required PCM format.
- [ ] Physical iOS and Android devices demonstrate intelligible input transcription and output speech, including the intended language/voice.
- [ ] Speaker, wired/Bluetooth headsets, route changes, audio focus, competing calls, and interruptions are exercised on both platforms.
- [ ] Barge-in immediately flushes local playback without breaking server-VAD turn handling.
- [ ] Canonical conversation resume uses stored-to-runtime mapping; no implicit side chat is created.
- [ ] A real delegated task produces a receipt first, then its matching final result; failures, stale events, replayed events, and results after hangup cannot masquerade as current success.
- [ ] Existing approval/input/connection UI works for the correct owner; unavailable approval leaves the task pending rather than bypassing it.
- [ ] Permission refusal, late permission grants, mint rejection/timeout, socket failure, explicit hangup, owner changes, and repeated start/stop release all audio and network resources.
- [ ] App background/lock behavior is explicit and verified; no unimplemented continuation or reconnect is advertised.
- [ ] Automated verification commands are executed and actual results recorded separately from live-provider and physical-phone acceptance.

## Troubleshooting and rollback

| Symptom | Check without weakening boundaries |
| --- | --- |
| Ready status but mint fails | Login state is not entitlement. Check the selected profile, supported reauthentication flow, provider policy, and quota; do not add API-key fallback. |
| HTTP 400 on mint | Supply the selected profile explicitly. Do not substitute the launch profile. |
| HTTP 401/403 from Hermes | Restore the existing connection/dashboard auth. Do not expose the mint route anonymously. |
| Reference page/bundle HTTP 503 | Build the reference bundle and verify deployment includes its HTML and output. |
| Socket opens but no mic frames | Confirm `session.update` / `session.updated`, microphone permission, secure browser context, and actual audio rate. |
| Work accepted but no spoken result | Check runtime session/event scope and pending approvals. A receipt is not completion; an advisory error is not a terminal `message.complete`. |
| RPC 4091 or uncorrelated receipt | Wait for the conversation to become idle or explicitly select a side chat. Align gateway/client versions. Isolated compute workers do not yet support this opt-in protocol. Never fall back to the next same-session completion. |
| Approval notice on a headless backend | Use an available existing approval surface; the reference has no confirmation UI and `/` may not serve a dashboard. |
| No call after navigation or connection loss | Expected reference cleanup. Retry explicitly; it does not resume an old call in the background. |

Rollback is additive: turn off/remove the native alternate-mode entry point, hang up active calls and release app audio/socket resources, and retain ordinary chat/STT/TTS. No new persisted voice preference or schema migration is introduced by this reference. For server rollback, deploy the previous reviewed backend/reference-client revision through the normal release mechanism; coordinate any required restart with the operator. Do not delete OAuth grants, change the default model, modify top-ups, or cancel already submitted Hermes work as an implicit part of rollback. Revoke account access only when separately requested by the owner.
