import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Entirely simulated: no production auth, microphone, provider or agent calls.
// Run the build first, then: node web/grok-voice/browser-smoke.mjs
const root = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'http://127.0.0.1:18119'
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const errors = []
  const submitted = []
  let voiceSocket
  let resolveResult
  const forwarded = new Promise(resolve => { resolveResult = resolve })
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.__testMicStarts = 0
    window.__testMicTracks = []
    navigator.mediaDevices.getUserMedia = async () => {
      window.__testMicStarts++
      const audio = new AudioContext({ sampleRate: 24000 })
      const target = audio.createMediaStreamDestination()
      const tone = audio.createOscillator()
      tone.connect(target)
      tone.start()
      void audio.resume()
      window.__testMicTracks.push(...target.stream.getTracks())
      return target.stream
    }
  })
  await page.route(origin + '/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    assert.equal(request.headers()['x-hermes-session-token'], undefined)
    if (url.pathname === '/grok-voice/') {
      const html = (await readFile(root + '/web/grok-voice/index.html', 'utf8')).replace(
        '</head>', '<script>window.__HERMES_AUTH_REQUIRED__=true;</script></head>'
      )
      return route.fulfill({ contentType: 'text/html', body: html })
    }
    if (url.pathname === '/api/audio/grok-live/client.js') {
      return route.fulfill({ contentType: 'application/javascript', body: await readFile(root + '/web/grok-voice/dist/client.js', 'utf8') })
    }
    if (url.pathname === '/api/auth/ws-ticket') {
      assert.equal(request.method(), 'POST')
      return route.fulfill({ json: { ticket: 'synthetic-single-use-ticket' } })
    }
    if (url.pathname === '/api/audio/grok-live/status') {
      return route.fulfill({ json: { ok: true, available: true } })
    }
    if (url.pathname === '/api/audio/grok-live/session') {
      assert.equal(request.method(), 'POST')
      assert.equal(url.searchParams.get('profile'), 'default')
      return route.fulfill({ json: {
        ok: true, url: 'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
        protocol_prefix: 'xai-client-secret.',
        client_secret: { value: 'synthetic-ephemeral-only', expires_at: Math.floor(Date.now() / 1000) + 300 },
        session: { voice: 'eve' }
      } })
    }
    return route.fulfill({ status: 404, body: 'Unknown fixture' })
  })
  await page.routeWebSocket('ws://127.0.0.1:18119/api/ws*', socket => {
    assert.equal(new URL(socket.url()).searchParams.has('token'), false)
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw))
      let result = {}
      if (request.method === 'session.list') result = { sessions: [{ id: 'synthetic-stored-session', title: 'Bot Chat' }] }
      if (request.method === 'session.resume') result = { session_id: 'synthetic-runtime-session', info: { model: 'unchanged-agent-model' } }
      if (request.method === 'prompt.submit') {
        submitted.push(request.params)
        result = { status: 'streaming', client_turn_id: request.params.client_turn_id }
        setTimeout(() => socket.send(JSON.stringify({
          jsonrpc: '2.0', method: 'event', params: {
            type: 'message.complete', session_id: 'synthetic-runtime-session', profile: 'default',
            payload: { text: 'Synthetic result. No external action was taken.', client_turn_id: request.params.client_turn_id }
          }
        })), 10)
      }
      if (request.id !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  await page.routeWebSocket('wss://api.x.ai/**', socket => {
    voiceSocket = socket
    socket.onMessage(raw => {
      const event = JSON.parse(String(raw))
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      if (event.type === 'conversation.item.create' && JSON.stringify(event).includes('[Hermes result]')) resolveResult()
    })
  })
  await page.goto(origin + '/grok-voice/')
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 5000 })
  assert.equal(await page.evaluate(() => window.__testMicStarts), 0)
  await page.locator('#start').click()
  await page.waitForFunction(() => document.querySelector('#orb').dataset.state === 'live', null, { timeout: 5000 })
  assert.equal(await page.evaluate(() => window.__testMicStarts), 1)
  assert.ok(voiceSocket)
  voiceSocket.send(JSON.stringify({
    type: 'response.function_call_arguments.done', name: 'hermes_task', call_id: 'synthetic-call',
    arguments: JSON.stringify({ request: 'Run the synthetic fixture only.' })
  }))
  await Promise.race([
    forwarded,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('No result forwarded')), 5000).unref() })
  ])
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].session_id, 'synthetic-runtime-session')
  assert.equal(submitted[0].surface, 'voice-live')
  await page.locator('#hangup').click()
  await page.waitForFunction(() => window.__testMicTracks.every(track => track.readyState === 'ended'))
  assert.equal(await page.locator('#orb').getAttribute('data-state'), 'idle')
  assert.deepEqual(errors, [])
  console.log('PASS: simulated mobile browser; no mic before click; scoped delegation; result forwarded; hangup releases mic; no real provider calls')
} finally {
  await browser.close()
}
