// Must clear this BEFORE any imports that might spawn Claude Code
delete process.env.CLAUDECODE

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR, TELEGRAM_BOT_TOKEN } from './config.js'
import { initDatabase } from './db.js'
import { runDecaySweep, backfillEmbeddings } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { initScheduler, setSystemLogTopic } from './scheduler.js'
import { initHeartbeat, stopHeartbeat } from './heartbeat.js'
import { initAgents, recoverOrphanedTasks } from './agents.js'
import { createBot, createSendFn, createTopicSendFn, ensureSystemLogTopic } from './bot.js'
import { startApi } from './api.js'
import { loadSkills } from './skills.js'
import { initWebhooks } from './webhooks.js'
import { createBackup } from './backup.js'
import { initPairing } from './pairing.js'
import { cleanupCaptures } from './devices.js'
import { startDashboard } from './dashboard.js'
import { logger } from './logger.js'

const PID_FILE = resolve(STORE_DIR, 'claudeclaw.pid')

async function acquireLock(): Promise<void> {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    try {
      process.kill(oldPid, 0)  // check if alive
      logger.info(`Killing old instance (PID ${oldPid})`)
      process.kill(oldPid)
      // Wait for old process to fully die (up to 10s)
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500))
        try { process.kill(oldPid, 0) } catch { break }  // gone
      }
    } catch {
      // stale pid, ignore
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
}

function releaseLock(): void {
  try { unlinkSync(PID_FILE) } catch { /* ignore */ }
}

async function main() {
  console.log(`
  ╔═══════════════════════════════╗
  ║         Mammals  v1.0         ║
  ╚═══════════════════════════════╝
  `)

  // Check config
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN in .env — run: npm run setup')
    process.exit(1)
  }

  // Lock + init
  await acquireLock()
  initDatabase()

  // Load skills from skills/ directory
  loadSkills()

  // Init webhook table
  initWebhooks()

  // Init device pairing security
  initPairing()

  // Daily auto-backup (runs at startup + every 24h)
  try { createBackup(); logger.info('Startup backup created') } catch (err) { logger.error({ err }, 'Startup backup failed') }
  setInterval(() => {
    try { createBackup(); logger.info('Daily backup created') } catch (err) { logger.error({ err }, 'Daily backup failed') }
  }, 24 * 60 * 60 * 1000)

  // Memory decay sweep on startup + daily
  runDecaySweep()
  setInterval(runDecaySweep, 24 * 60 * 60 * 1000)

  // Backfill vector embeddings on startup + every 10 minutes
  backfillEmbeddings().catch(err => logger.error({ err }, 'Initial embedding backfill failed'))
  setInterval(() => backfillEmbeddings().catch(err => logger.error({ err }, 'Embedding backfill failed')), 10 * 60 * 1000)

  // Clean up old media uploads
  cleanupOldUploads()

  // Create bot
  const bot = createBot()
  const sendFn = createSendFn(bot)
  const topicSendFn = createTopicSendFn(bot)

  // Create System Log topic for task updates (keeps main chat clean)
  const systemLogTopicId = await ensureSystemLogTopic(bot)
  if (systemLogTopicId) {
    setSystemLogTopic(systemLogTopicId)
    logger.info({ topicId: systemLogTopicId }, 'System Log topic ready')
  }

  // Start scheduler (with topic routing if available)
  initScheduler(sendFn, topicSendFn)

  // Start heartbeat
  initHeartbeat(sendFn)

  // Init multi-agent system
  initAgents(sendFn)

  // Check for agent tasks interrupted by last crash/restart
  recoverOrphanedTasks().catch(err => logger.error({ err }, 'Orphaned task recovery failed'))

  // Start HTTP API for Mammals HQ
  startApi()

  // Start Gateway Dashboard
  startDashboard()

  // Clean up old device captures on startup + daily
  cleanupCaptures()
  setInterval(cleanupCaptures, 24 * 60 * 60 * 1000)

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`Shutting down (${signal})...`)
    stopHeartbeat()
    releaseLock()
    bot.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception')
    shutdown('uncaughtException')
  })
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection')
  })

  // Start polling
  logger.info('Mammals starting...')
  try {
    await bot.start({ drop_pending_updates: true })
  } catch (err) {
    logger.error({ err }, 'Failed to start bot — check TELEGRAM_BOT_TOKEN in .env')
    releaseLock()
    process.exit(1)
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error')
  releaseLock()
  process.exit(1)
})
