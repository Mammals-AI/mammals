import { CronExpressionParser } from 'cron-parser'
import { getDueTasks, updateTaskAfterRun } from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'

type Sender = (chatId: string, text: string) => Promise<void>
type TopicSender = (chatId: string, text: string, topicId: number) => Promise<void>

let sender: Sender | null = null
let topicSender: TopicSender | null = null
let systemLogTopicId: number | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null

export function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression)
  return Math.floor(expr.next().getTime() / 1000)
}

export function setSystemLogTopic(topicId: number): void {
  systemLogTopicId = topicId
  logger.info({ topicId }, 'System log topic set')
}

export function getSystemLogTopicId(): number | null {
  return systemLogTopicId
}

async function sendTaskMessage(chatId: string, text: string): Promise<void> {
  // Route to system log topic if available, otherwise fall back to main chat
  if (topicSender && systemLogTopicId) {
    await topicSender(chatId, text, systemLogTopicId)
  } else if (sender) {
    await sender(chatId, text)
  }
}

// Results matching these patterns are "nothing to report" — don't spam the log
const QUIET_PATTERNS = [
  /^all clear/i,
  /^nothing to (?:report|flag|note)/i,
  /^no (?:alerts?|trades?|updates?|issues?|changes?)/i,
  /^\(no output\)$/,
  /^quiet/i,
  /^everything.* normal/i,
  /^all (?:good|systems? (?:go|normal|green))/i,
  /^already (?:got|handled|ran|done|completed|processed)/i,
  /we'?re good/i,
  /market is flat/i,
  /nothing (?:new|to flag|to send|sent)/i,
  /no new leads/i,
  /timed out/i,
  /overloaded/i,
  /no activity for/i,
]

function isQuietResult(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 80) {
    return QUIET_PATTERNS.some(p => p.test(trimmed))
  }
  return false
}

/**
 * Peak hours: 8am–2pm ET on weekdays.
 * Tasks tagged [heavy] are deferred during this window to preserve session budget.
 * Returns true if currently in peak hours.
 */
function isPeakHour(): boolean {
  const now = new Date()
  // Convert to ET (UTC-5 standard, UTC-4 daylight — use a simple offset check)
  const etOffset = isDaylightSaving(now) ? -4 : -5
  const etHour = (now.getUTCHours() + etOffset + 24) % 24
  const dayOfWeek = now.getUTCDay() // 0=Sun, 6=Sat
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5
  return isWeekday && etHour >= 8 && etHour < 14
}

function isDaylightSaving(date: Date): boolean {
  // DST in US: second Sunday in March to first Sunday in November
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset()
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset()
  return date.getTimezoneOffset() < Math.max(jan, jul)
}

async function runSingleTask(task: { id: string; chat_id: string; prompt: string; schedule: string }): Promise<void> {
  // Tasks tagged [heavy] are deferred during peak hours (8am–2pm ET weekdays)
  const isHeavy = /^\[heavy\]/i.test(task.prompt.trim())
  if (isHeavy && isPeakHour()) {
    // Defer to next scheduled run — skip this firing
    logger.info({ taskId: task.id }, 'Deferring heavy task — peak hours')
    const nextRun = computeNextRun(task.schedule)
    updateTaskAfterRun(task.id, nextRun, 'Skipped: peak hours (8am–2pm ET)')
    return
  }

  logger.info({ taskId: task.id, prompt: task.prompt }, 'Running scheduled task')

  try {
    const { text } = await runAgent(task.prompt, undefined, undefined, undefined, { model: 'sonnet', effort: 'medium' })
    const result = text ?? '(no output)'

    // Only send to system log if there's something meaningful to report
    if (!isQuietResult(result)) {
      await sendTaskMessage(task.chat_id, `📋 Task result:\n${result.slice(0, 3500)}`)
    } else {
      logger.info({ taskId: task.id }, 'Task returned quiet result, skipping log message')
    }

    const nextRun = computeNextRun(task.schedule)
    updateTaskAfterRun(task.id, nextRun, result)
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'Scheduled task failed')
    await sendTaskMessage(task.chat_id, `❌ Scheduled task failed: ${err instanceof Error ? err.message : String(err)}`)
    // Still compute next run so we don't re-run a broken task every 60s
    const nextRun = computeNextRun(task.schedule)
    updateTaskAfterRun(task.id, nextRun, `Error: ${err}`)
  }
}

export async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks()
  if (tasks.length === 0) return

  // Run all due tasks concurrently so one slow task doesn't block the others
  await Promise.allSettled(tasks.map(task => runSingleTask(task)))
}

export function initScheduler(send: Sender, topicSend?: TopicSender): void {
  sender = send
  topicSender = topicSend ?? null
  // Poll every 60 seconds for due tasks
  pollInterval = setInterval(() => {
    runDueTasks().catch(err => logger.error({ err }, 'Scheduler poll error'))
  }, 60_000)
  logger.info('Scheduler started (60s poll)')
}

export function stopScheduler(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}
