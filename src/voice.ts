import { readFileSync, renameSync } from 'node:fs'
import { GROQ_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, VOXTRAL_PORT } from './config.js'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'

const VOXTRAL_URL = `http://localhost:${VOXTRAL_PORT}/tts`

async function isVoxtralRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${VOXTRAL_PORT}/health`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!GROQ_API_KEY,
    tts: true, // Voxtral local or ElevenLabs fallback
  }
}

/**
 * Transcribe an audio file using Groq Whisper API.
 * Telegram sends voice notes as .oga — we rename to .ogg (Groq requirement).
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured')

  // Rename .oga to .ogg if needed (same format, Groq just needs the extension)
  let actualPath = filePath
  if (filePath.endsWith('.oga')) {
    actualPath = filePath.replace(/\.oga$/, '.ogg')
    renameSync(filePath, actualPath)
  }

  const fileBuffer = readFileSync(actualPath)
  const filename = actualPath.split('/').pop() ?? 'audio.ogg'

  // Build multipart form data manually (no extra deps)
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)

  const parts: Buffer[] = []

  // File part
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: audio/ogg\r\n\r\n`
  ))
  parts.push(fileBuffer)
  parts.push(Buffer.from('\r\n'))

  // Model part
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-large-v3\r\n`
  ))

  parts.push(Buffer.from(`--${boundary}--\r\n`))

  const body = Buffer.concat(parts)

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })

  if (!response.ok) {
    const errText = await response.text()
    logger.error({ status: response.status, body: errText }, 'Groq STT error')
    throw new Error(`Groq STT failed: ${response.status}`)
  }

  const result = await response.json() as { text: string }
  return result.text
}

/**
 * Synthesize speech — tries Voxtral (local, free) first, falls back to ElevenLabs.
 * Returns an audio buffer (WAV from Voxtral, MP3 from ElevenLabs).
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  // Try Voxtral local server first
  if (await isVoxtralRunning()) {
    try {
      const env = readEnvFile(['VOXTRAL_VOICE', 'VOXTRAL_TEMPERATURE', 'VOXTRAL_TOP_K', 'VOXTRAL_TOP_P'])
      const voice = env['VOXTRAL_VOICE'] || 'casual_male'
      const params: Record<string, string> = { text, voice }
      if (env['VOXTRAL_TEMPERATURE']) params.temperature = env['VOXTRAL_TEMPERATURE']
      if (env['VOXTRAL_TOP_K']) params.top_k = env['VOXTRAL_TOP_K']
      if (env['VOXTRAL_TOP_P']) params.top_p = env['VOXTRAL_TOP_P']
      const url = `${VOXTRAL_URL}?${new URLSearchParams(params)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (res.ok) {
        logger.info('TTS: using Voxtral (local)')
        return Buffer.from(await res.arrayBuffer())
      }
    } catch (err) {
      logger.warn({ err }, 'Voxtral TTS failed, falling back to ElevenLabs')
    }
  }

  // Fall back to ElevenLabs
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error('No TTS available: Voxtral not running and ElevenLabs not configured')
  }

  logger.info('TTS: using ElevenLabs (fallback)')
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  )

  if (!response.ok) {
    const errText = await response.text()
    logger.error({ status: response.status, body: errText }, 'ElevenLabs TTS error')
    throw new Error(`ElevenLabs TTS failed: ${response.status}`)
  }

  return Buffer.from(await response.arrayBuffer())
}
