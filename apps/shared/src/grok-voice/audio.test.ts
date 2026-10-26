import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAudio, decodePcm, encodePcm } from './audio'

class Context {
  static instances: Context[] = []
  state = 'suspended'
  sampleRate = 24000
  currentTime = 1
  destination = {}
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  audioWorklet = { addModule: vi.fn(async () => {}) }
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
  sources: any[] = []
  createBuffer = (_: number, length: number, rate: number) => ({
    duration: length / rate,
    getChannelData: () => new Float32Array(length)
  })
  createBufferSource() {
    const s = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), buffer: null }
    this.sources.push(s)

    return s
  }
  constructor() {
    Context.instances.push(this)
  }
}

class Worklet {
  static last: Worklet
  port = { onmessage: null as any }
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() {
    Worklet.last = this
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  Context.instances = []
})

function environment() {
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('AudioWorkletNode', Worklet)
  const stop = vi.fn()
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:worklet', revokeObjectURL: vi.fn() })

  return { stop, getUserMedia }
}

describe('PCM audio', () => {
  it('clips PCM16 at 24 kHz and decodes provider frames', () => {
    expect(Array.from(decodePcm(encodePcm(new Float32Array([-2, -1, 0, 1, 2]))))).toEqual([
      -32768, -32768, 0, 32767, 32767
    ])
  })
  it('unlocks audio, captures 100 ms frames through a muted worklet, and closes resources', async () => {
    const env = environment()
    const audio = createAudio()
    await audio.player.resume()
    expect(Context.instances[0].resume).toHaveBeenCalledOnce()
    const frame = vi.fn()
    await audio.startMic(frame)
    const node = Worklet.last
    node.port.onmessage({ data: new Float32Array(1200) })
    expect(frame).not.toHaveBeenCalled()
    node.port.onmessage({ data: new Float32Array(1200) })
    expect(frame.mock.calls[0][0]).toHaveLength(2400)
    audio.player.play(new Int16Array(2400))
    audio.player.flush()
    expect(Context.instances[0].sources[0].stop).toHaveBeenCalledOnce()
    audio.close()
    expect(env.stop).toHaveBeenCalledOnce()
    expect(Context.instances[0].close).toHaveBeenCalledOnce()
    expect(node.disconnect).toHaveBeenCalledOnce()
  })
  it('stops a permission result that arrives after close', async () => {
    environment()
    let resolve!: (stream: any) => void
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise(r => {
            resolve = r
          })
      }
    })
    const audio = createAudio()
    const pending = audio.startMic(vi.fn())
    audio.close()
    const stop = vi.fn()
    resolve({ getTracks: () => [{ stop }] })
    await expect(pending).rejects.toThrow(/annul/i)
    expect(stop).toHaveBeenCalledOnce()
  })
})
