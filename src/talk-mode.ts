/**
 * Talk Mode — voice batching with silence detection (OpenClaw-inspired).
 *
 * When the user sends multiple voice messages in quick succession, this batches
 * them into a single message instead of processing each one separately.
 *
 * How it works:
 * 1. First voice message starts a batch timer
 * 2. If another voice message arrives within the silence window, it resets the timer
 * 3. When the timer fires (no new voice for N seconds), all batched transcripts
 *    are combined and sent as one message
 *
 * Configurable via /talkmode command:
 * - silence timeout (how long to wait before auto-sending, default 3s)
 * - enabled/disabled
 */

import { getBotConfig, setBotConfig } from './db.js'
import { logger } from './logger.js'

const SILENCE_KEY = 'talk_mode_silence_ms'
const TALK_MODE_KEY = 'talk_mode_enabled'
const DEFAULT_SILENCE_MS = 3000  // 3 seconds

interface VoiceBatch {
  transcripts: string[]
  timer: ReturnType<typeof setTimeout> | null
  onFlush: (combined: string) => void
}

// Active batches per chat
const activeBatches = new Map<string, VoiceBatch>()

/**
 * Get talk mode configuration.
 */
export function getTalkModeConfig(): { enabled: boolean; silenceMs: number } {
  const enabled = getBotConfig(TALK_MODE_KEY) !== 'false'  // on by default
  const silenceMs = parseInt(getBotConfig(SILENCE_KEY) ?? '', 10) || DEFAULT_SILENCE_MS
  return { enabled, silenceMs }
}

/**
 * Set talk mode enabled/disabled.
 */
export function setTalkModeEnabled(enabled: boolean): void {
  setBotConfig(TALK_MODE_KEY, enabled ? 'true' : 'false')
  logger.info({ enabled }, `Talk mode ${enabled ? 'ON' : 'OFF'}`)
}

/**
 * Set the silence detection timeout in milliseconds.
 */
export function setTalkModeSilence(ms: number): void {
  setBotConfig(SILENCE_KEY, String(ms))
  logger.info({ ms }, `Talk mode silence timeout set to ${ms}ms`)
}

/**
 * Add a voice transcript to the batch. If talk mode is disabled,
 * returns the transcript immediately. If enabled, batches it and
 * calls onFlush when the silence timer fires.
 *
 * Returns true if the transcript was batched (caller should NOT process it yet).
 * Returns false if talk mode is off (caller should process immediately).
 */
export function batchVoiceTranscript(
  chatId: string,
  transcript: string,
  onFlush: (combined: string) => void,
): boolean {
  const config = getTalkModeConfig()
  if (!config.enabled) return false

  const existing = activeBatches.get(chatId)

  if (existing) {
    // Add to existing batch and reset timer
    existing.transcripts.push(transcript)
    if (existing.timer) clearTimeout(existing.timer)
    existing.onFlush = onFlush  // update callback to latest
    existing.timer = setTimeout(() => flushBatch(chatId), config.silenceMs)
    logger.debug({ chatId, count: existing.transcripts.length }, 'Voice added to batch')
    return true
  }

  // Start new batch
  const batch: VoiceBatch = {
    transcripts: [transcript],
    timer: setTimeout(() => flushBatch(chatId), config.silenceMs),
    onFlush,
  }
  activeBatches.set(chatId, batch)
  logger.debug({ chatId }, 'Voice batch started')
  return true
}

/**
 * Flush a voice batch — combine all transcripts and call onFlush.
 */
function flushBatch(chatId: string): void {
  const batch = activeBatches.get(chatId)
  if (!batch) return

  activeBatches.delete(chatId)

  const combined = batch.transcripts.join(' ')
  logger.info({ chatId, parts: batch.transcripts.length, length: combined.length }, 'Voice batch flushed')

  batch.onFlush(combined)
}

/**
 * Cancel any pending voice batch for a chat (e.g., on /newchat).
 */
export function cancelVoiceBatch(chatId: string): void {
  const batch = activeBatches.get(chatId)
  if (batch) {
    if (batch.timer) clearTimeout(batch.timer)
    activeBatches.delete(chatId)
  }
}

/**
 * Get the number of pending voice transcripts in a batch.
 */
export function pendingVoiceCount(chatId: string): number {
  return activeBatches.get(chatId)?.transcripts.length ?? 0
}
