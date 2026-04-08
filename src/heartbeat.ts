import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT, ALLOWED_CHAT_ID } from './config.js'
import { getHeartbeatConfig, setHeartbeatConfig } from './db.js'
import { runAgent } from './agent.js'
import { displayActivity, displayState } from './display.js'
import { logger } from './logger.js'

const HEARTBEAT_MD = resolve(PROJECT_ROOT, 'HEARTBEAT.md')
const HEARTBEAT_OK = 'HEARTBEAT_OK'
const ACK_MAX_CHARS = 300

type Sender = (chatId: string, text: string) => Promise<void>

let sender: Sender | null = null
let timer: ReturnType<typeof setInterval> | null = null

export interface HeartbeatConfig {
  enabled: boolean
  interval_min: number
  active_start: string  // HH:MM
  active_end: string    // HH:MM
}

const DEFAULTS: HeartbeatConfig = {
  enabled: false,
  interval_min: 30,
  active_start: '09:00',
  active_end: '22:00',
}

function isWithinActiveHours(start: string, end: string): boolean {
  const now = new Date()
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em

  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin
  }
  // Wraps midnight (e.g. 22:00 - 06:00)
  return nowMin >= startMin || nowMin < endMin
}

function buildHeartbeatPrompt(): string | null {
  let tasks = ''
  if (existsSync(HEARTBEAT_MD)) {
    tasks = readFileSync(HEARTBEAT_MD, 'utf-8').trim()
    // Skip if file is empty or only headers
    if (tasks.replace(/^#.*$/gm, '').replace(/\s+/g, '').length === 0) {
      return null
    }
  }

  return [
    'This is a scheduled heartbeat check. Read the tasks below and check on them.',
    'If nothing needs attention, respond with exactly HEARTBEAT_OK and nothing else.',
    'If something needs attention, describe it clearly and do NOT include HEARTBEAT_OK.',
    '',
    tasks || 'No HEARTBEAT.md found. Just confirm all systems are nominal.',
  ].join('\n')
}

function shouldSuppress(response: string): boolean {
  // If response starts with HEARTBEAT_OK and remaining content is short, suppress
  if (!response.includes(HEARTBEAT_OK)) return false
  const stripped = response.replace(HEARTBEAT_OK, '').trim()
  return stripped.length <= ACK_MAX_CHARS
}

async function runHeartbeat(): Promise<void> {
  const config = getHeartbeatConfig() ?? DEFAULTS
  if (!config.enabled) return

  if (!isWithinActiveHours(config.active_start, config.active_end)) {
    logger.debug('Heartbeat skipped — outside active hours')
    return
  }

  const prompt = buildHeartbeatPrompt()
  if (!prompt) {
    logger.debug('Heartbeat skipped — no tasks in HEARTBEAT.md')
    return
  }

  logger.info('Running heartbeat check')
  displayActivity('heartbeat', 'Heartbeat check running', 'thinking')
  displayState('executing')

  try {
    const { text } = await runAgent(prompt, undefined, undefined, undefined, { model: 'haiku', effort: 'low' })
    const response = text ?? ''

    if (shouldSuppress(response)) {
      logger.info('Heartbeat: all clear (HEARTBEAT_OK)')
      displayActivity('heartbeat', 'All clear', 'idle')
    } else {
      logger.info({ response: response.slice(0, 200) }, 'Heartbeat: alert')
      displayActivity('heartbeat', `Alert: ${response.slice(0, 80)}`, 'talking')

      if (sender && ALLOWED_CHAT_ID) {
        await sender(ALLOWED_CHAT_ID, `Heartbeat alert:\n${response.slice(0, 3500)}`)
      }
    }
  } catch (err) {
    logger.error({ err }, 'Heartbeat failed')
  } finally {
    setTimeout(() => displayState('idle'), 3000)
  }
}

export function initHeartbeat(send: Sender): void {
  sender = send
  const config = getHeartbeatConfig() ?? DEFAULTS
  if (!config.enabled) {
    logger.info('Heartbeat disabled')
    return
  }
  startTimer(config.interval_min)
}

function startTimer(intervalMin: number): void {
  stopTimer()
  const ms = intervalMin * 60 * 1000
  timer = setInterval(() => {
    runHeartbeat().catch(err => logger.error({ err }, 'Heartbeat poll error'))
  }, ms)
  logger.info(`Heartbeat started (every ${intervalMin}min)`)
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function updateHeartbeat(config: HeartbeatConfig): void {
  setHeartbeatConfig(config)
  if (config.enabled) {
    startTimer(config.interval_min)
  } else {
    stopTimer()
  }
}

/** Trigger a heartbeat right now regardless of schedule */
export async function triggerHeartbeat(): Promise<void> {
  const config = getHeartbeatConfig() ?? DEFAULTS
  // Force run even if disabled — user asked for it
  const prompt = buildHeartbeatPrompt()
  if (!prompt) return

  displayActivity('heartbeat', 'Manual heartbeat check', 'thinking')
  displayState('executing')

  try {
    const { text } = await runAgent(prompt, undefined, undefined, undefined, { model: 'haiku', effort: 'low' })
    const response = text ?? 'No response'

    if (sender && ALLOWED_CHAT_ID) {
      if (shouldSuppress(response)) {
        await sender(ALLOWED_CHAT_ID, 'Heartbeat: All systems clear.')
      } else {
        await sender(ALLOWED_CHAT_ID, `Heartbeat:\n${response.slice(0, 3500)}`)
      }
    }
  } catch (err) {
    logger.error({ err }, 'Manual heartbeat failed')
    if (sender && ALLOWED_CHAT_ID) {
      await sender(ALLOWED_CHAT_ID, `Heartbeat error: ${err instanceof Error ? err.message : String(err)}`)
    }
  } finally {
    setTimeout(() => displayState('idle'), 3000)
  }
}

export function stopHeartbeat(): void {
  stopTimer()
}
