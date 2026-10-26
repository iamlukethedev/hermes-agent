// PCM capture/playback adapted from hermes-xai by Julien Talbot (MIT; see LICENSE).
import type { VoiceAudio } from './call'

export const RATE = 24000

const WORKLET = `
class Pcm24k extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('hermes-grok-pcm', Pcm24k)
`

export function encodePcm(frame: Float32Array): string {
  const bytes = new Uint8Array(frame.length * 2)
  const view = new DataView(bytes.buffer)

  for (let i = 0; i < frame.length; i++) {
    const sample = Math.max(-1, Math.min(1, frame[i]))
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

export function decodePcm(text: string): Int16Array {
  const binary = atob(text)
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const pcm = new Int16Array(bytes.length >> 1)

  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getInt16(i * 2, true)
  }

  return pcm
}

/** One context unlocked in the user gesture serves capture AND playback. */
export function createAudio(): VoiceAudio {
  const context = new AudioContext({ sampleRate: RATE })
  let closed = false
  let next = 0
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let worklet: AudioWorkletNode | null = null
  let mute: GainNode | null = null
  const live = new Set<AudioBufferSourceNode>()

  function flush() {
    live.forEach(node => {
      try {
        node.stop()
      } catch {
        /* already ended */
      }
    })
    live.clear()
    next = 0
  }

  function stopMic() {
    if (worklet) {
      worklet.port.onmessage = null
      worklet.disconnect()
      worklet = null
    }

    source?.disconnect()
    source = null
    mute?.disconnect()
    mute = null
    stream?.getTracks().forEach(track => track.stop())
    stream = null
  }

  function close() {
    if (closed) {
      return
    }

    closed = true
    stopMic()
    flush()
    void context.close().catch(() => {})
  }

  const player = {
    resume: () => context.resume(),
    play(pcm: Int16Array) {
      if (closed || !pcm.length) {
        return
      }

      const buffer = context.createBuffer(1, pcm.length, RATE)
      const ch = buffer.getChannelData(0)

      for (let i = 0; i < pcm.length; i++) {
        ch[i] = pcm[i] / 0x8000
      }

      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(context.destination)
      next = Math.max(next, context.currentTime)
      node.start(next)
      next += buffer.duration
      live.add(node)

      node.onended = () => {
        live.delete(node)
        node.disconnect()
      }
    },
    flush,
    close
  }

  return {
    player,
    close,
    async startMic(onFrame) {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true }
      })

      if (closed) {
        acquired.getTracks().forEach(track => track.stop())
        throw new Error('Appel annulé')
      }

      stream = acquired
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))

      try {
        await context.audioWorklet.addModule(url)

        if (closed) {
          throw new Error('Appel annulé')
        }

        if (context.sampleRate !== RATE) {
          throw new Error('Fréquence audio 24 kHz indisponible')
        }

        const node = new AudioWorkletNode(context, 'hermes-grok-pcm')
        worklet = node
        let pending: Float32Array[] = []
        let size = 0

        node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
          if (closed) {
            return
          }

          pending.push(data)
          size += data.length

          if (size < RATE / 10) {
            return
          }

          const frame = new Float32Array(size)
          let at = 0

          for (const part of pending) {
            frame.set(part, at)
            at += part.length
          }

          pending = []
          size = 0
          onFrame(frame)
        }

        source = context.createMediaStreamSource(stream)
        source.connect(node)
        // Keep the worklet pulled by Safari as well as Chromium; never monitor the mic.
        mute = context.createGain()
        mute.gain.value = 0
        node.connect(mute)
        mute.connect(context.destination)

        return stopMic
      } catch (error) {
        stopMic()
        throw error
      } finally {
        URL.revokeObjectURL(url)
      }
    }
  }
}
