import { Bot, InputFile } from 'grammy'
import {
  TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, ALLOWED_GROUP_ID, TYPING_REFRESH_MS,
} from './config.js'
import { formatForTelegram, splitMessage } from './format.js'
import { getDb, getSession, setSession, clearSession, getAllMemories, listTasks, createTask, deleteTask, pauseTask, resumeTask, setAgentTopicId, getAgentTopicId, getBotConfig, setBotConfig, logConversation } from './db.js'
import { runAgent } from './agent.js'
import { buildMemoryContext, buildConversationContext, saveConversationTurn, saveSessionSummary } from './memory.js'
import { voiceCapabilities, transcribeAudio, synthesizeSpeech } from './voice.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js'
import { computeNextRun } from './scheduler.js'
import { updateHeartbeat, triggerHeartbeat, type HeartbeatConfig } from './heartbeat.js'
import { getHeartbeatConfig } from './db.js'
import { listAllAgents, getAgentByName, createNamedAgent, deleteNamedAgent, sendToAgent, sendToAgentBackground, agentToAgent, isAgentBusy, getPendingConfirmation, handleConfirmationReply } from './agents.js'
import { getLoadedSkills, createSkill, deleteSkill, loadSkills, importFromOpenClawUrl } from './skills.js'
import { logger } from './logger.js'
import { displayState, displayActivity } from './display.js'
import { getModelConfig, setModelConfig, toggleFastMode, isFastMode } from './model-config.js'
import { needsChrome, autoModel } from './routing.js'
import { isElevated, toggleElevated, elevatedStatus } from './elevated.js'
import { createPairingCode, listDevices as listPairedDevices, revokeDevice, revokeAllDevices } from './pairing.js'
import { deviceCapabilities, getSystemInfo, takeScreenshot, sendNotification } from './devices.js'
import { getTalkModeConfig, setTalkModeEnabled, setTalkModeSilence, batchVoiceTranscript } from './talk-mode.js'
import { exportAllSkills, importSkillBundle } from './skills.js'
import { getAgentDirectory, broadcastToAgents, getAgentStatsOverview, getAgentWorkHistory, getAgentSkillsList, delegateTask, tryAutoRoute, getQueueLength, addAgentSkill, removeAgentSkill } from './agents.js'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { UPLOADS_DIR } from './media.js'
import { PROJECT_ROOT, BOT_OWNER } from './config.js'

// Track which chats have voice reply mode on
const voiceMode = new Set<string>()

// Push messages to Mammals HQ Daemon window for cross-channel visibility
function pushToDaemon(type: string, message: string) {
  fetch('http://localhost:5055/api/daemon-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramEvent: { type, message: message.slice(0, 4000) } }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => { /* display might be down */ })
}

let claimedChatId = ALLOWED_CHAT_ID

function isAuthorised(chatId: number): boolean {
  if (!claimedChatId) return true  // first-run mode — accept anyone (will auto-claim)
  const id = String(chatId)
  return id === claimedChatId || id === ALLOWED_GROUP_ID
}

/** On first message when no ALLOWED_CHAT_ID is set, claim this user as the owner */
function tryClaimOwner(chatId: number): boolean {
  if (claimedChatId) return false
  const id = String(chatId)
  claimedChatId = id
  // Append to .env so it persists across restarts
  const envPath = resolve(PROJECT_ROOT, '.env')
  try {
    let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
    if (content.includes('ALLOWED_CHAT_ID=')) {
      content = content.replace(/ALLOWED_CHAT_ID=.*/, `ALLOWED_CHAT_ID=${id}`)
    } else {
      content += `\nALLOWED_CHAT_ID=${id}\n`
    }
    writeFileSync(envPath, content)
    logger.info({ chatId: id }, 'Auto-claimed owner chat ID and saved to .env')
  } catch (err) {
    logger.error({ err }, 'Failed to save chat ID to .env')
  }
  return true
}

// --- Main message pipeline ---
// Messages run concurrently — no queue, no blocking.

async function handleMessage(
  ctx: { chatId: string; reply: (text: string, parseMode?: string) => Promise<void>; sendTyping: () => Promise<unknown>; sendVoice: (buf: Buffer) => Promise<void> },
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  // Fire off the handler without blocking — each message runs independently
  handleMessageInner(ctx, rawText, forceVoiceReply).catch((err) => {
    logger.error({ err }, 'handleMessage error')
  })
}

async function handleMessageInner(
  ctx: { chatId: string; reply: (text: string, parseMode?: string) => Promise<void>; sendTyping: () => Promise<unknown>; sendVoice: (buf: Buffer) => Promise<void> },
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  const chatId = ctx.chatId

  // Build memory context — keep it short, only inject on first message of a session
  const sessionId = getSession(chatId) ?? undefined
  let fullMessage = `[Telegram] ${rawText}`

  if (!sessionId) {
    // New session: inject recent conversation history so we pick up where we left off
    const convoCtx = buildConversationContext(chatId)
    if (rawText.length > 30) {
      // Substantial message: also inject memory context
      const memoryCtx = await buildMemoryContext(chatId, rawText)
      const parts = [memoryCtx, convoCtx, `[Telegram] ${rawText}`].filter(Boolean)
      fullMessage = parts.join('\n\n')
    } else if (convoCtx) {
      fullMessage = `${convoCtx}\n\n[Telegram] ${rawText}`
    }
  }

  // Log user message
  const msgSource = rawText.startsWith('[Voice transcribed]') ? 'voice' : 'telegram'
  logConversation(chatId, 'user', rawText, msgSource)

  // Notify display
  displayActivity('command', `[Telegram] ${rawText.slice(0, 80)}`, 'thinking')

  // Push to Mammals HQ Daemon window so both channels are visible
  pushToDaemon('telegram-user', rawText)

  // Start typing indicator refresh
  let typingActive = true
  const refreshTyping = async () => {
    while (typingActive) {
      try { await ctx.sendTyping() } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, TYPING_REFRESH_MS))
    }
  }
  const typingPromise = refreshTyping()

  // Run Claude
  displayState('executing')
  const useChrome = needsChrome(rawText)
  const modelOverride = autoModel(rawText)
  const { text, newSessionId } = await runAgent(
    fullMessage,
    sessionId,
    () => { /* typing handled by the loop above */ },
    undefined,
    modelOverride,
    useChrome,
  )

  // Stop typing
  typingActive = false
  await typingPromise

  const reply = text ?? 'Done!'
  displayActivity('success', `[Telegram] Reply: ${reply.slice(0, 80)}`, 'talking', reply.slice(0, 500))

  // Push reply to Mammals HQ Daemon window
  pushToDaemon('telegram-reply', reply)

  // Save session
  if (newSessionId) {
    setSession(chatId, newSessionId)
  }

  // Log assistant response
  logConversation(chatId, 'assistant', reply, 'telegram')

  // Save to memory
  saveConversationTurn(chatId, rawText, reply)

  // Send response
  const { tts } = voiceCapabilities()
  if (tts && (forceVoiceReply || voiceMode.has(chatId))) {
    try {
      const audio = await synthesizeSpeech(reply.slice(0, 5000))
      await ctx.sendVoice(audio)
    } catch (err) {
      logger.error({ err }, 'TTS failed, falling back to text')
      await sendTextReply(ctx, reply)
    }
  } else {
    await sendTextReply(ctx, reply)
  }

  // Back to idle after a short delay so "talking" state is visible
  setTimeout(() => displayState('idle'), 3000)
}

async function sendTextReply(
  ctx: { reply: (text: string, parseMode?: string) => Promise<void> },
  text: string
): Promise<void> {
  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, 'HTML')
    } catch {
      // If HTML parsing fails, send as plain text (still chunked so we don't lose content)
      const plainChunks = splitMessage(text)
      for (const plain of plainChunks) {
        await ctx.reply(plain)
      }
      return  // already sent the full text as plain, don't continue the HTML loop
    }
  }
}

// --- Bot setup ---

export function createBot() {
  const bot = new Bot(TELEGRAM_BOT_TOKEN)

  // /start
  bot.command('start', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    await ctx.reply(
      "Hey! I'm your Mammals agent running on the Mac Mini.\n\n" +
      "Just text me anything — I can chat AND do things:\n" +
      "• Check on your services\n" +
      "• Run commands, edit files\n" +
      "• Analyze photos and documents\n" +
      "• Send voice notes — I'll understand and reply\n\n" +
      "/newchat — fresh conversation\n" +
      "/voice — toggle voice replies\n" +
      "/fast — toggle fast mode (speed vs quality)\n" +
      "/memory — see what I remember\n" +
      "/schedule — manage timed tasks\n" +
      "/heartbeat — proactive check-ins\n" +
      "/skills — manage knowledge packs\n" +
      "/agents — named AI agents\n" +
      "/gpt <question> — ask ChatGPT\n" +
      "/grok <question> — ask Grok\n" +
      "/backup — create/verify backups\n" +
      "/webhooks — manage webhook endpoints\n" +
      "/elevated — toggle permission safety checks\n" +
      "/pair — device pairing security\n" +
      "/devices — screenshots, system info, notifications\n" +
      "/talkmode — voice batching config\n" +
      "/restart — restart the bot\n" +
      "/chatid — show your chat ID\n\n" +
      "Dashboard: http://localhost:5075"
    )
  })

  // /chatid
  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID: ${ctx.chat.id}`)
  })

  // /restart — safe restart from Telegram
  bot.command('restart', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    await ctx.reply('Restarting...')
    clearSession(String(ctx.chat.id))
    setTimeout(() => process.exit(1), 500)  // launchd restarts on non-zero exit
  })

  bot.command('model', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text?.replace(/^\/model\s*/, '').trim() || ''

    if (!text) {
      const mc = getModelConfig()
      await ctx.reply(`Model: ${mc.model}\nEffort: ${mc.effort}\n\nUsage:\n/model opus high\n/model sonnet medium\n/model haiku low`)
      return
    }

    const parts = text.toLowerCase().split(/\s+/)
    const validModels = ['opus', 'sonnet', 'haiku']
    const validEfforts = ['low', 'medium', 'high']

    const model = parts.find(p => validModels.includes(p))
    const effort = parts.find(p => validEfforts.includes(p))

    if (!model && !effort) {
      await ctx.reply('Invalid. Use: /model <opus|sonnet|haiku> <low|medium|high>')
      return
    }

    const updated = setModelConfig({
      ...(model && { model }),
      ...(effort && { effort }),
    })
    await ctx.reply(`Updated:\nModel: ${updated.model}\nEffort: ${updated.effort}`)
  })

  // /fast — quick toggle between quality and speed (OpenClaw-inspired)
  bot.command('fast', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const result = toggleFastMode()
    if (result.fast) {
      await ctx.reply(`Fast mode ON — ${result.model}/${result.effort}. Quick responses, less depth.`)
    } else {
      await ctx.reply(`Fast mode OFF — ${result.model}/${result.effort}. Full power.`)
    }
  })

  // /newchat — with session-memory save (OpenClaw-inspired)
  bot.command('newchat', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    // Save session summary before clearing (so we remember what we were working on)
    saveSessionSummary(chatId)
    clearSession(chatId)
    await ctx.reply('Fresh start! New conversation.')
  })

  // /forget (alias)
  bot.command('forget', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    clearSession(String(ctx.chat.id))
    await ctx.reply('Session cleared.')
  })

  // /voice — toggle voice reply mode
  bot.command('voice', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    const { tts } = voiceCapabilities()
    if (!tts) {
      await ctx.reply('Voice replies not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env')
      return
    }
    if (voiceMode.has(chatId)) {
      voiceMode.delete(chatId)
      await ctx.reply('Voice replies OFF — back to text.')
    } else {
      voiceMode.add(chatId)
      await ctx.reply('Voice replies ON — I\'ll speak back to you.')
    }
  })

  // /memory — show recent memories
  bot.command('memory', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const memories = getAllMemories(String(ctx.chat.id), 10)
    if (memories.length === 0) {
      await ctx.reply('No memories stored yet.')
      return
    }
    const lines = memories.map((m, i) => `${i + 1}. [${m.sector}] ${m.content.slice(0, 120)}`)
    await ctx.reply(`Recent memories:\n\n${lines.join('\n')}`)
  })

  // /schedule — inline task management
  bot.command('schedule', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatId = String(ctx.chat.id)
    const text = ctx.message?.text ?? ''
    const parts = text.replace('/schedule', '').trim().split(' ')
    const subcmd = parts[0]

    if (!subcmd || subcmd === 'list') {
      const tasks = listTasks(chatId)
      if (tasks.length === 0) {
        await ctx.reply('No scheduled tasks.\n\nUsage: /schedule create "prompt" "cron"\nExample: /schedule create "check system health" "0 9 * * *"')
        return
      }
      const lines = tasks.map(t => {
        const next = new Date(t.next_run * 1000).toLocaleString()
        return `[${t.id}] ${t.status} | "${t.prompt.slice(0, 50)}" | next: ${next}`
      })
      await ctx.reply(lines.join('\n'))
      return
    }

    if (subcmd === 'create') {
      // Parse: /schedule create "prompt" "cron"
      const match = text.match(/create\s+"([^"]+)"\s+"([^"]+)"/)
      if (!match) {
        await ctx.reply('Usage: /schedule create "prompt text" "cron expression"\nExample: /schedule create "summarize emails" "0 9 * * *"')
        return
      }
      try {
        const nextRun = computeNextRun(match[2])
        const id = randomUUID().slice(0, 8)
        createTask(id, chatId, match[1], match[2], nextRun)
        await ctx.reply(`Task ${id} created! Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
      } catch {
        await ctx.reply('Invalid cron expression. Example: "0 9 * * *" (daily at 9am)')
      }
      return
    }

    if (subcmd === 'delete' && parts[1]) {
      deleteTask(parts[1])
      await ctx.reply(`Task ${parts[1]} deleted.`)
      return
    }

    if (subcmd === 'pause' && parts[1]) {
      pauseTask(parts[1])
      await ctx.reply(`Task ${parts[1]} paused.`)
      return
    }

    if (subcmd === 'resume' && parts[1]) {
      resumeTask(parts[1])
      await ctx.reply(`Task ${parts[1]} resumed.`)
      return
    }

    await ctx.reply('Unknown subcommand. Use: list, create, delete, pause, resume')
  })

  // /heartbeat — manage heartbeat system
  bot.command('heartbeat', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text ?? ''
    const parts = text.replace('/heartbeat', '').trim().split(/\s+/)
    const subcmd = parts[0]

    if (!subcmd || subcmd === 'status') {
      const config = getHeartbeatConfig()
      if (!config) {
        await ctx.reply('Heartbeat not configured yet.\n\nUsage:\n/heartbeat on — enable (30min default)\n/heartbeat off — disable\n/heartbeat interval 15 — set to 15min\n/heartbeat hours 09:00 22:00 — active hours\n/heartbeat now — run one immediately')
        return
      }
      await ctx.reply(
        `Heartbeat: ${config.enabled ? 'ON' : 'OFF'}\n` +
        `Interval: ${config.interval_min}min\n` +
        `Active hours: ${config.active_start} - ${config.active_end}`
      )
      return
    }

    if (subcmd === 'on') {
      const existing = getHeartbeatConfig()
      const config: HeartbeatConfig = existing ?? {
        enabled: true,
        interval_min: 30,
        active_start: '09:00',
        active_end: '22:00',
      }
      config.enabled = true
      updateHeartbeat(config)
      await ctx.reply(`Heartbeat ON — checking every ${config.interval_min}min (${config.active_start}-${config.active_end})`)
      return
    }

    if (subcmd === 'off') {
      const existing = getHeartbeatConfig()
      if (existing) {
        existing.enabled = false
        updateHeartbeat(existing)
      }
      await ctx.reply('Heartbeat OFF.')
      return
    }

    if (subcmd === 'interval' && parts[1]) {
      const min = parseInt(parts[1], 10)
      if (isNaN(min) || min < 1) {
        await ctx.reply('Interval must be a positive number of minutes.')
        return
      }
      const existing = getHeartbeatConfig() ?? { enabled: true, interval_min: min, active_start: '09:00', active_end: '22:00' }
      existing.interval_min = min
      updateHeartbeat(existing)
      await ctx.reply(`Heartbeat interval set to ${min}min.`)
      return
    }

    if (subcmd === 'hours' && parts[1] && parts[2]) {
      const timeRe = /^\d{2}:\d{2}$/
      if (!timeRe.test(parts[1]) || !timeRe.test(parts[2])) {
        await ctx.reply('Use HH:MM format. Example: /heartbeat hours 09:00 22:00')
        return
      }
      const existing = getHeartbeatConfig() ?? { enabled: true, interval_min: 30, active_start: parts[1], active_end: parts[2] }
      existing.active_start = parts[1]
      existing.active_end = parts[2]
      updateHeartbeat(existing)
      await ctx.reply(`Active hours set to ${parts[1]} - ${parts[2]}.`)
      return
    }

    if (subcmd === 'now') {
      await ctx.reply('Running heartbeat now...')
      triggerHeartbeat().catch(err => logger.error({ err }, 'Manual heartbeat error'))
      return
    }

    await ctx.reply('Unknown subcommand. Use: status, on, off, interval <min>, hours <start> <end>, now')
  })

  // /skills — list and manage skills
  bot.command('skills', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text ?? ''
    const parts = text.replace('/skills', '').trim()
    const subcmd = parts.split(/\s+/)[0]

    if (!subcmd || subcmd === 'list') {
      const skills = getLoadedSkills()
      if (skills.length === 0) {
        await ctx.reply('No skills loaded.\n\nSkills are auto-created by agents or placed in ~/claudeclaw/skills/\n\n/skills delete <name> — remove a skill\n/skills reload — reload from disk')
        return
      }
      const lines = skills.map(s => {
        const by = s.createdBy ? ` (by ${s.createdBy})` : ''
        return `[${s.name}] ${s.description}${by}\n  triggers: ${s.triggers.join(', ')}`
      })
      await ctx.reply(`Skills (${skills.length}):\n\n${lines.join('\n\n')}`)
      return
    }

    if (subcmd === 'delete') {
      const name = parts.split(/\s+/)[1]
      if (!name) {
        await ctx.reply('Usage: /skills delete <name>')
        return
      }
      const result = deleteSkill(name)
      await ctx.reply(result.ok ? `Skill "${name}" deleted.` : result.error!)
      return
    }

    if (subcmd === 'reload') {
      loadSkills()
      const skills = getLoadedSkills()
      await ctx.reply(`Reloaded ${skills.length} skill(s) from disk.`)
      return
    }

    if (subcmd === 'import') {
      const urlOrSlug = parts.split(/\s+/)[1]
      if (!urlOrSlug) {
        await ctx.reply('Usage: /skills import <openclaw-slug or github-url>\n\nExample: /skills import todoist-cli')
        return
      }
      await ctx.reply(`Fetching skill "${urlOrSlug}"...`)
      const result = await importFromOpenClawUrl(urlOrSlug)
      await ctx.reply(result.ok
        ? `Skill imported from OpenClaw. Use /skills to see it.`
        : `Import failed: ${result.error}`)
      return
    }

    await ctx.reply('Usage: /skills [list | delete <name> | reload | import <slug>]')
  })

  // /backup — create and manage backups (OpenClaw-inspired)
  bot.command('backup', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const { createBackup, listBackups, verifyBackup } = await import('./backup.js')
    const text = ctx.message?.text ?? ''
    const subcmd = text.replace('/backup', '').trim().split(/\s+/)[0]

    if (!subcmd || subcmd === 'create') {
      try {
        const { path, manifest } = createBackup()
        const size = (manifest.dbSizeBytes / 1024).toFixed(0)
        await ctx.reply(`Backup created!\n${manifest.files.length} files, DB: ${size}KB\n${path}`)
      } catch (err) {
        await ctx.reply(`Backup failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (subcmd === 'list') {
      const backups = listBackups()
      if (backups.length === 0) {
        await ctx.reply('No backups found. Use /backup create')
        return
      }
      const lines = backups.map(b => {
        const date = new Date(b.timestamp).toLocaleString()
        const size = (b.dbSize / 1024).toFixed(0)
        return `${b.name} — ${date} (${b.files} files, ${size}KB)`
      })
      await ctx.reply(`Backups:\n\n${lines.join('\n')}`)
      return
    }

    if (subcmd === 'verify') {
      const backups = listBackups()
      if (backups.length === 0) {
        await ctx.reply('No backups to verify.')
        return
      }
      const latest = backups[0]
      const result = verifyBackup(latest.path)
      if (result.ok) {
        await ctx.reply(`Latest backup verified OK: ${latest.name}`)
      } else {
        await ctx.reply(`Backup issues:\n${result.errors.join('\n')}`)
      }
      return
    }

    await ctx.reply('Usage: /backup [create | list | verify]')
  })

  // /webhooks — manage webhook endpoints (OpenClaw-inspired)
  bot.command('webhooks', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const { listWebhooks, createWebhook, deleteWebhook } = await import('./webhooks.js')
    const text = ctx.message?.text ?? ''
    const parts = text.replace('/webhooks', '').trim()
    const subcmd = parts.split(/\s+/)[0]

    if (!subcmd || subcmd === 'list') {
      const hooks = listWebhooks()
      if (hooks.length === 0) {
        await ctx.reply('No webhooks.\n\nUsage:\n/webhooks create <name> [agent]\n/webhooks delete <name>')
        return
      }
      const lines = hooks.map(h => {
        const target = h.agent ? `→ agent:${h.agent}` : '→ main bot'
        return `[${h.name}] ${target}\nURL: /api/hooks/${h.id}`
      })
      await ctx.reply(`Webhooks:\n\n${lines.join('\n\n')}`)
      return
    }

    if (subcmd === 'create') {
      const match = parts.match(/create\s+(\S+)(?:\s+(\S+))?/)
      if (!match) {
        await ctx.reply('Usage: /webhooks create <name> [agent-name]')
        return
      }
      const [, name, agent] = match
      const hook = createWebhook(name, agent)
      await ctx.reply(
        `Webhook "${name}" created!\n\n` +
        `URL: http://localhost:5062/api/hooks/${hook.id}\n` +
        `Secret: ${hook.secret}\n` +
        `Target: ${agent ? `agent:${agent}` : 'main bot'}\n\n` +
        `Send POST requests with X-Webhook-Secret header or X-Hub-Signature-256.`
      )
      return
    }

    if (subcmd === 'delete') {
      const name = parts.split(/\s+/)[1]
      if (!name) {
        await ctx.reply('Usage: /webhooks delete <name>')
        return
      }
      if (deleteWebhook(name)) {
        await ctx.reply(`Webhook "${name}" deleted.`)
      } else {
        await ctx.reply(`Webhook "${name}" not found.`)
      }
      return
    }

    await ctx.reply('Usage: /webhooks [list | create <name> [agent] | delete <name>]')
  })

  // /elevated — toggle elevated mode (skip confirmation for dangerous commands)
  bot.command('elevated', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text?.replace(/^\/elevated\s*/, '').trim() || ''

    if (!text) {
      const status = elevatedStatus()
      await ctx.reply(
        `Elevated mode: ${status.elevated ? 'ON' : 'OFF'}\n${status.description}\n\n` +
        `/elevated on — enable (skip dangerous command confirmation)\n` +
        `/elevated off — disable (require confirmation, default)`
      )
      return
    }

    if (text === 'on') {
      toggleElevated()
      await ctx.reply('Elevated mode ON. Dangerous commands will execute without confirmation.\nFinancial actions still require confirmation.')
      return
    }
    if (text === 'off') {
      if (isElevated()) toggleElevated()
      await ctx.reply('Elevated mode OFF. Dangerous commands require confirmation.')
      return
    }

    await ctx.reply('Usage: /elevated [on | off]')
  })

  // /pair — device pairing security
  bot.command('pair', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text?.replace(/^\/pair\s*/, '').trim() || ''
    const subcmd = text.split(/\s+/)[0]

    if (!subcmd || subcmd === 'new') {
      const deviceName = text.replace(/^new\s*/, '').trim() || `device-${Date.now()}`
      const code = createPairingCode(deviceName)
      const expiresIn = Math.round((code.expires_at - Date.now()) / 1000)
      await ctx.reply(
        `Pairing code for "${deviceName}":\n\n` +
        `${code.code}\n\n` +
        `Expires in ${expiresIn}s. Send this code to POST /api/pair to complete pairing.`
      )
      return
    }

    if (subcmd === 'list') {
      const devices = listPairedDevices()
      if (devices.length === 0) {
        await ctx.reply('No paired devices.\n\nUsage: /pair <device-name> — generate a pairing code')
        return
      }
      const lines = devices.map(d => {
        const lastUsed = new Date(d.last_used_at).toLocaleString()
        const expires = new Date(d.expires_at).toLocaleString()
        return `[${d.device_name}] last used: ${lastUsed}, expires: ${expires}`
      })
      await ctx.reply(`Paired devices:\n\n${lines.join('\n')}`)
      return
    }

    if (subcmd === 'revoke') {
      const target = text.split(/\s+/)[1]
      if (!target) {
        await ctx.reply('Usage: /pair revoke <device-name-or-id>\n/pair revoke all')
        return
      }
      if (target === 'all') {
        const count = revokeAllDevices()
        await ctx.reply(`Revoked ${count} device session(s).`)
      } else {
        if (revokeDevice(target)) {
          await ctx.reply(`Device "${target}" revoked.`)
        } else {
          await ctx.reply(`Device "${target}" not found.`)
        }
      }
      return
    }

    // If just a name, treat as "new"
    const code = createPairingCode(subcmd)
    const expiresIn = Math.round((code.expires_at - Date.now()) / 1000)
    await ctx.reply(
      `Pairing code for "${subcmd}":\n\n` +
      `${code.code}\n\n` +
      `Expires in ${expiresIn}s.`
    )
  })

  // /devices — show device capabilities and system info
  bot.command('devices', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text?.replace(/^\/devices\s*/, '').trim() || ''

    if (text === 'screenshot') {
      try {
        const path = takeScreenshot()
        await ctx.replyWithPhoto(new InputFile(path))
      } catch (err) {
        await ctx.reply(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (text === 'sysinfo') {
      const info = getSystemInfo()
      const lines = Object.entries(info).map(([k, v]) => `${k}: ${v}`)
      await ctx.reply(lines.join('\n') || 'No system info available.')
      return
    }

    if (text.startsWith('notify ')) {
      const msg = text.replace(/^notify\s*/, '')
      try {
        sendNotification('Mammals', msg)
        await ctx.reply('Notification sent.')
      } catch (err) {
        await ctx.reply(`Notification failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    const caps = deviceCapabilities()
    const lines = Object.entries(caps).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`)
    await ctx.reply(
      `Device capabilities:\n\n${lines.join('\n')}\n\n` +
      `/devices screenshot — take a screenshot\n` +
      `/devices sysinfo — system information\n` +
      `/devices notify <msg> — send a macOS notification`
    )
  })

  // /talkmode — voice batching / silence detection config
  bot.command('talkmode', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text?.replace(/^\/talkmode\s*/, '').trim() || ''
    const config = getTalkModeConfig()

    if (!text) {
      await ctx.reply(
        `Talk mode: ${config.enabled ? 'ON' : 'OFF'}\n` +
        `Silence timeout: ${config.silenceMs}ms\n\n` +
        `When ON, rapid voice messages are batched into one.\n\n` +
        `/talkmode on — enable batching\n` +
        `/talkmode off — disable (process each voice immediately)\n` +
        `/talkmode silence <ms> — set silence timeout (default 3000)`
      )
      return
    }

    if (text === 'on') {
      setTalkModeEnabled(true)
      await ctx.reply('Talk mode ON. Voice messages will be batched with silence detection.')
      return
    }
    if (text === 'off') {
      setTalkModeEnabled(false)
      await ctx.reply('Talk mode OFF. Each voice message processed immediately.')
      return
    }
    if (text.startsWith('silence')) {
      const ms = parseInt(text.split(/\s+/)[1], 10)
      if (isNaN(ms) || ms < 500 || ms > 30000) {
        await ctx.reply('Silence timeout must be between 500ms and 30000ms.')
        return
      }
      setTalkModeSilence(ms)
      await ctx.reply(`Silence timeout set to ${ms}ms.`)
      return
    }

    await ctx.reply('Usage: /talkmode [on | off | silence <ms>]')
  })

  // /autoroute — toggle automatic agent routing for incoming messages
  bot.command('autoroute', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const arg = ctx.message?.text?.replace('/autoroute', '').trim().toLowerCase()
    const current = getBotConfig('auto_route') === 'on'

    if (!arg) {
      await ctx.reply(`Auto-routing: ${current ? 'ON' : 'OFF'}\n\nWhen ON, messages that clearly belong to a specialist agent are routed automatically.\n\n/autoroute on — enable\n/autoroute off — disable`)
      return
    }
    if (arg === 'on') {
      setBotConfig('auto_route', 'on')
      await ctx.reply('Auto-routing ON. Obvious agent tasks will be routed automatically.')
      return
    }
    if (arg === 'off') {
      setBotConfig('auto_route', 'off')
      await ctx.reply('Auto-routing OFF. All messages go to main bot.')
      return
    }
    await ctx.reply('Usage: /autoroute [on | off]')
  })

  // /agents — manage named agents
  bot.command('agents', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text ?? ''
    const parts = text.replace('/agents', '').trim()
    const subcmd = parts.split(/\s+/)[0]

    if (!subcmd || subcmd === 'list') {
      const agents = listAllAgents()
      if (agents.length === 0) {
        await ctx.reply(
          'No agents yet.\n\n' +
          '/agents create <name> "<description>" "<system prompt>"\n' +
          '/agents status — full overview\n' +
          '/agents send <name> <message>\n' +
          '/agents delegate <task> — auto-route to best agent\n' +
          '/agents work <name> — recent work log\n' +
          '/agents skills <name> — agent skills\n' +
          '/agents skill-add <name> <skill>\n' +
          '/agents cross <from> <to> <message>\n' +
          '/agents broadcast <message>\n' +
          '/agents delete <name>\n' +
          '/agents reset <name>'
        )
        return
      }
      const lines = agents.map(a => {
        const busy = isAgentBusy(a.name)
        const q = getQueueLength(a.name)
        const session = a.session_id ? 'active' : 'no session'
        const qStr = q > 0 ? ` [${q} queued]` : ''
        return `${busy ? '⟳' : '·'} ${a.name}${qStr} — ${a.description} (${session})`
      })
      await ctx.reply(`Agents (${agents.length}):\n\n${lines.join('\n')}`)
      return
    }

    if (subcmd === 'status') {
      const overview = getAgentStatsOverview()
      await ctx.reply(overview)
      return
    }

    if (subcmd === 'work') {
      const name = parts.split(/\s+/)[1]
      if (!name) { await ctx.reply('Usage: /agents work <name>'); return }
      await ctx.reply(getAgentWorkHistory(name, 10))
      return
    }

    if (subcmd === 'skills') {
      const name = parts.split(/\s+/)[1]
      if (!name) { await ctx.reply('Usage: /agents skills <name>'); return }
      await ctx.reply(getAgentSkillsList(name))
      return
    }

    if (subcmd === 'skill-add') {
      const m = parts.match(/skill-add\s+(\S+)\s+(.+)/)
      if (!m) { await ctx.reply('Usage: /agents skill-add <name> <skill description>'); return }
      addAgentSkill(m[1], m[2])
      await ctx.reply(`Skill added to ${m[1]}: "${m[2]}"`)
      return
    }

    if (subcmd === 'skill-rm') {
      const m = parts.match(/skill-rm\s+(\S+)\s+(.+)/)
      if (!m) { await ctx.reply('Usage: /agents skill-rm <name> <skill>'); return }
      const removed = removeAgentSkill(m[1], m[2])
      await ctx.reply(removed ? `Removed "${m[2]}" from ${m[1]}.` : 'Skill not found.')
      return
    }

    if (subcmd === 'delegate') {
      const task = parts.replace(/^delegate\s+/, '').trim()
      if (!task) { await ctx.reply('Usage: /agents delegate <task description>'); return }
      const chatIdStr = String(ctx.chat.id)
      const replyCb = async (text: string) => { await ctx.reply(text) }
      const photoCbDelegate = async (photoPath: string, caption: string) => {
        await bot.api.sendPhoto(Number(chatIdStr), new InputFile(photoPath), { caption })
      }
      await delegateTask(task, chatIdStr, replyCb, undefined, photoCbDelegate)
      return
    }

    if (subcmd === 'create') {
      // /agents create "description" "system prompt"          — auto-assigns animal name
      // /agents create <name> "description" "system prompt"   — use specific name
      const matchWithName = parts.match(/create\s+(\S+)\s+"([^"]+)"\s+"([^"]+)"/)
      const matchAutoName = parts.match(/create\s+"([^"]+)"\s+"([^"]+)"/)
      if (!matchWithName && !matchAutoName) {
        await ctx.reply('Usage:\n/agents create "<description>" "<system prompt>"\n/agents create <name> "<description>" "<system prompt>"')
        return
      }
      const explicitName = matchWithName ? matchWithName[1] : undefined
      const desc = matchWithName ? matchWithName[2] : matchAutoName![1]
      const prompt = matchWithName ? matchWithName[3] : matchAutoName![2]
      try {
        const name = createNamedAgent(explicitName, desc, prompt)

        // Auto-create a forum topic in the group if we're in a forum-enabled group
        if (ALLOWED_GROUP_ID) {
          try {
            const topic = await bot.api.createForumTopic(Number(ALLOWED_GROUP_ID), name)
            setAgentTopicId(name, topic.message_thread_id)
            await bot.api.sendMessage(Number(ALLOWED_GROUP_ID), `Agent "${name}" ready.\n${desc}`, {
              message_thread_id: topic.message_thread_id,
            })
          } catch (topicErr) {
            logger.error({ topicErr }, 'Failed to create forum topic')
          }
        }

        await ctx.reply(`Agent "${name}" created.`)
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (subcmd === 'rename') {
      const renameMatch = parts.match(/rename\s+(\S+)\s+(\S+)/)
      if (!renameMatch) {
        await ctx.reply('Usage: /agents rename <old-name> <new-name>')
        return
      }
      const [, oldName, newName] = renameMatch
      try {
        const { renameNamedAgent } = await import('./agents.js')
        if (renameNamedAgent(oldName, newName)) {
          await ctx.reply(`Agent "${oldName}" → "${newName}"`)
        } else {
          await ctx.reply(`Agent "${oldName}" not found.`)
        }
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (subcmd === 'send') {
      // /agents send wolf check latest news
      const sendMatch = parts.match(/send\s+(\S+)\s+(.+)/)
      if (!sendMatch) {
        await ctx.reply('Usage: /agents send <name> <message>')
        return
      }
      const [, name, message] = sendMatch
      const agent = getAgentByName(name)
      if (!agent) {
        await ctx.reply(`Agent "${name}" not found.`)
        return
      }

      const topicId = getAgentTopicId(name)
      const chatIdStr = String(ctx.chat.id)

      if (isAgentBusy(name)) {
        await ctx.reply(`Agent "${name}" is busy. Try again in a bit.`)
        return
      }

      // Build a reply callback that routes to the right place
      const replyCb = async (text: string) => {
        const formatted = formatForTelegram(text.slice(0, 3500))
        if (topicId && ALLOWED_GROUP_ID) {
          try {
            await bot.api.sendMessage(Number(ALLOWED_GROUP_ID), formatted, {
              parse_mode: 'HTML',
              message_thread_id: topicId,
              link_preview_options: { is_disabled: true },
            })
          } catch {
            await bot.api.sendMessage(Number(ALLOWED_GROUP_ID), text.slice(0, 3500), {
              message_thread_id: topicId,
              link_preview_options: { is_disabled: true },
            })
          }
        } else {
          try {
            await bot.api.sendMessage(Number(chatIdStr), formatted, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
          } catch {
            await bot.api.sendMessage(Number(chatIdStr), text.slice(0, 3500), { link_preview_options: { is_disabled: true } })
          }
        }
      }

      const photoCb = async (photoPath: string, caption: string) => {
        const buf = readFileSync(photoPath)
        if (topicId && ALLOWED_GROUP_ID) {
          await bot.api.sendPhoto(Number(ALLOWED_GROUP_ID), new InputFile(buf, 'avatar.png'), {
            caption,
            message_thread_id: topicId,
          })
        } else {
          await bot.api.sendPhoto(Number(chatIdStr), new InputFile(buf, 'avatar.png'), { caption })
        }
      }

      sendToAgentBackground(name, message, chatIdStr, replyCb, topicId ?? undefined, photoCb)
      return
    }

    if (subcmd === 'cross') {
      // /agents cross wolf crow summarize your findings
      const crossMatch = parts.match(/cross\s+(\S+)\s+(\S+)\s+(.+)/)
      if (!crossMatch) {
        await ctx.reply('Usage: /agents cross <from-agent> <to-agent> <message>')
        return
      }
      const [, from, to, message] = crossMatch

      await ctx.api.sendChatAction(ctx.chat.id, 'typing')
      const response = await agentToAgent(from, to, message, String(ctx.chat.id))
      await ctx.reply(`[${from} -> ${to}] ${response.slice(0, 3500)}`)
      return
    }

    if (subcmd === 'broadcast') {
      const message = parts.replace(/^broadcast\s+/, '').trim()
      if (!message) {
        await ctx.reply('Usage: /agents broadcast <message>')
        return
      }
      await ctx.reply('Broadcasting to all agents...')
      const results = await broadcastToAgents(message, undefined, String(ctx.chat.id))
      const lines = results.map(r => `[${r.agent}] ${r.response.slice(0, 200)}`)
      await ctx.reply(lines.join('\n\n') || 'No agents to broadcast to.')
      return
    }

    if (subcmd === 'directory') {
      const dir = getAgentDirectory()
      await ctx.reply(dir)
      return
    }

    if (subcmd === 'delete') {
      const name = parts.split(/\s+/)[1]
      if (!name) {
        await ctx.reply('Usage: /agents delete <name>')
        return
      }
      if (deleteNamedAgent(name)) {
        await ctx.reply(`Agent "${name}" deleted.`)
      } else {
        await ctx.reply(`Agent "${name}" not found.`)
      }
      return
    }

    if (subcmd === 'reset') {
      const name = parts.split(/\s+/)[1]
      if (!name) {
        await ctx.reply('Usage: /agents reset <name>')
        return
      }
      const agent = getAgentByName(name)
      if (!agent) {
        await ctx.reply(`Agent "${name}" not found.`)
        return
      }
      // Clear the agent's session by setting it to null via DB
      getDb().prepare('UPDATE agents SET session_id = NULL WHERE name = ?').run(name)
      await ctx.reply(`Agent "${name}" session cleared.`)
      return
    }

    await ctx.reply('Unknown subcommand. Use: list, create, send, cross, delete, reset')
  })

  // /gpt — ask ChatGPT via browser automation
  bot.command('gpt', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const question = ctx.message?.text?.replace(/^\/gpt\s*/, '').trim() || ''
    if (!question) {
      await ctx.reply('Usage: /gpt <question>')
      return
    }
    await handleMessage(
      buildHandlerCtx(ctx),
      `Use Puppeteer to open chat.openai.com, wait for the page to load, type this message into the chat input and submit it, wait for the full response, then return the response text verbatim: ${question}`
    )
  })

  // /grok — ask Grok via browser automation
  bot.command('grok', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const question = ctx.message?.text?.replace(/^\/grok\s*/, '').trim() || ''
    if (!question) {
      await ctx.reply('Usage: /grok <question>')
      return
    }
    await handleMessage(
      buildHandlerCtx(ctx),
      `Use Puppeteer to open grok.com, wait for the page to load, type this message into the chat input and submit it, wait for the full response, then return the response text verbatim: ${question}`
    )
  })

  // Helper to build handler context from Grammy ctx (avoids 5x copy-paste)
  function buildHandlerCtx(ctx: { chat: { id: number }; reply: typeof Bot.prototype.api.sendMessage extends never ? never : any; api: any; replyWithVoice: any }) {
    return {
      chatId: String(ctx.chat.id),
      reply: async (text: string, parseMode?: string) => {
        await ctx.reply(text, parseMode ? { parse_mode: parseMode as 'HTML' } : undefined)
      },
      sendTyping: () => ctx.api.sendChatAction(ctx.chat.id, 'typing'),
      sendVoice: async (buf: Buffer) => {
        const tmpPath = resolve(UPLOADS_DIR, `voice_${Date.now()}.mp3`)
        writeFileSync(tmpPath, buf)
        await ctx.replyWithVoice(new InputFile(tmpPath))
      },
    }
  }

  // --- Text messages ---
  // Dedup: track recent message IDs, clear every 5 minutes to prevent unbounded growth
  const recentMessageIds = new Set<number>()
  setInterval(() => recentMessageIds.clear(), 5 * 60 * 1000)

  bot.on('message:text', async (ctx) => {
    // Dedup: skip if we already processed this message
    const msgId = ctx.message.message_id
    if (recentMessageIds.has(msgId)) return
    recentMessageIds.add(msgId)

    if (!isAuthorised(ctx.chat.id)) {
      await ctx.reply('Unauthorized.')
      return
    }
    // Auto-claim: first message when no owner is set locks this chat as the owner
    if (tryClaimOwner(ctx.chat.id)) {
      const name = BOT_OWNER || ctx.from?.first_name || 'there'
      await ctx.reply(`Hey ${name}! I've locked to your chat ID. You're my owner now. Let's go.`)
    }
    if (ctx.message.text.startsWith('/')) return  // skip unknown commands

    // Check if this message is in an agent's topic thread
    const threadId = ctx.message.message_thread_id
    if (threadId && ALLOWED_GROUP_ID && String(ctx.chat.id) === ALLOWED_GROUP_ID) {
      // Check for pending confirmation first
      const chatIdStr = String(ctx.chat.id)
      const pending = getPendingConfirmation(chatIdStr, threadId)
      if (pending) {
        await handleConfirmationReply(chatIdStr, ctx.message.text, threadId)
        return
      }

      // Find which agent owns this topic
      const agents = listAllAgents()
      const agent = agents.find(a => a.topic_id === threadId)
      if (agent) {
        await ctx.api.sendChatAction(ctx.chat.id, 'typing', { message_thread_id: threadId })

        const replyCb = async (text: string) => {
          const formatted = formatForTelegram(text.slice(0, 3500))
          try {
            await bot.api.sendMessage(Number(ALLOWED_GROUP_ID), formatted, {
              parse_mode: 'HTML',
              message_thread_id: threadId,
              link_preview_options: { is_disabled: true },
            })
          } catch {
            await bot.api.sendMessage(Number(ALLOWED_GROUP_ID), text.slice(0, 3500), {
              message_thread_id: threadId,
              link_preview_options: { is_disabled: true },
            })
          }
        }

        const photoCbTopic = async (photoPath: string, caption: string) => {
          const buf = readFileSync(photoPath)
          await bot.api.sendPhoto(Number(ALLOWED_GROUP_ID), new InputFile(buf, 'avatar.png'), {
            caption,
            message_thread_id: threadId,
          })
        }

        // Use confirmation flow
        sendToAgentBackground(agent.name, ctx.message.text, chatIdStr, replyCb, threadId, photoCbTopic)
        return
      }

      // Message is in the group but not in any agent's topic (e.g. #general) — probably a mistake
      await ctx.reply('Wrong chat.')
      return
    }

    // If we're in the group but no threadId, also a mistake (General topic without thread ID)
    if (ALLOWED_GROUP_ID && String(ctx.chat.id) === ALLOWED_GROUP_ID) {
      await ctx.reply('Wrong chat.')
      return
    }

    // Check for pending agent confirmation in DM context
    const dmPending = getPendingConfirmation(String(ctx.chat.id))
    if (dmPending) {
      await handleConfirmationReply(String(ctx.chat.id), ctx.message.text)
      return
    }

    // Auto-routing handled by Daemon inline — no pre-intercept
    await handleMessage(buildHandlerCtx(ctx), ctx.message.text)
  })

  // --- Voice messages (with talk mode batching) ---
  bot.on('message:voice', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return

    const { stt } = voiceCapabilities()
    if (!stt) {
      await ctx.reply('Voice transcription not configured. Set GROQ_API_KEY in .env')
      return
    }

    try {
      displayActivity('info', 'Voice message received', 'thinking')
      const fileId = ctx.message.voice.file_id
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, fileId, 'voice.oga')
      const transcript = await transcribeAudio(localPath)

      await ctx.reply(`🎤 "${transcript}"`, { parse_mode: undefined })

      // Try to batch with talk mode (silence detection)
      const chatId = String(ctx.chat.id)
      const batched = batchVoiceTranscript(chatId, transcript, (combined) => {
        // This fires when the silence timer expires
        handleMessage(buildHandlerCtx(ctx), `[Voice transcribed]: ${combined}`)
      })

      if (!batched) {
        // Talk mode off — process immediately
        await handleMessage(buildHandlerCtx(ctx), `[Voice transcribed]: ${transcript}`)
      }
    } catch (err) {
      logger.error({ err }, 'Voice handling error')
      await ctx.reply(`Voice error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // --- Photos ---
  bot.on('message:photo', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return

    try {
      displayActivity('info', 'Photo received', 'thinking')
      const photo = ctx.message.photo[ctx.message.photo.length - 1]  // highest res
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, photo.file_id, 'photo.jpg')
      const message = buildPhotoMessage(localPath, ctx.message.caption)

      await handleMessage(buildHandlerCtx(ctx), message)
    } catch (err) {
      logger.error({ err }, 'Photo handling error')
      await ctx.reply('Failed to process photo.')
    }
  })

  // --- Documents ---
  bot.on('message:document', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const doc = ctx.message.document
    if (!doc) return

    try {
      displayActivity('info', `Document: ${doc.file_name ?? 'file'}`, 'thinking')
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, doc.file_id, doc.file_name)
      const message = buildDocumentMessage(localPath, doc.file_name ?? 'document', ctx.message.caption)

      await handleMessage(buildHandlerCtx(ctx), message)
    } catch (err) {
      logger.error({ err }, 'Document handling error')
      await ctx.reply('Failed to process document.')
    }
  })

  // --- Video ---
  bot.on('message:video', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return

    try {
      displayActivity('info', 'Video received', 'thinking')
      const video = ctx.message.video
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, video.file_id, video.file_name ?? 'video.mp4')
      const message = buildVideoMessage(localPath, ctx.message.caption)

      await handleMessage(buildHandlerCtx(ctx), message)
    } catch (err) {
      logger.error({ err }, 'Video handling error')
      await ctx.reply('Failed to process video.')
    }
  })

  return bot
}

/**
 * Helper to send a message to a specific chat (used by scheduler).
 */
export function createSendFn(bot: Bot) {
  return async (chatId: string, text: string) => {
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted)
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(Number(chatId), chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      } catch {
        // HTML failed — send as plain text, still chunked
        const plainChunks = splitMessage(text)
        for (const plain of plainChunks) {
          await bot.api.sendMessage(Number(chatId), plain, { link_preview_options: { is_disabled: true } })
        }
        return
      }
    }
  }
}

/**
 * Helper to send a message to a specific forum topic (used by scheduler for system log).
 */
export function createTopicSendFn(bot: Bot) {
  return async (chatId: string, text: string, topicId: number) => {
    const groupId = Number(ALLOWED_GROUP_ID)
    if (!groupId) return
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted)
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(groupId, chunk, { parse_mode: 'HTML', message_thread_id: topicId })
      } catch {
        // HTML failed — send as plain text, still chunked
        const plainChunks = splitMessage(text)
        for (const plain of plainChunks) {
          await bot.api.sendMessage(groupId, plain, { message_thread_id: topicId })
        }
        return
      }
    }
  }
}

/**
 * Create or find the "System Log" forum topic for routing task updates.
 * Persists the topic ID in bot_config so it survives restarts.
 */
export async function ensureSystemLogTopic(bot: Bot): Promise<number | null> {
  if (!ALLOWED_GROUP_ID) return null
  const groupId = Number(ALLOWED_GROUP_ID)

  // Check if we already have a saved topic ID
  const saved = getBotConfig('system_log_topic_id')
  if (saved) {
    const topicId = parseInt(saved, 10)
    // Verify it still works by sending a test message
    try {
      await bot.api.sendMessage(groupId, '🔄 System Log reconnected.', {
        message_thread_id: topicId,
      })
      return topicId
    } catch {
      // Topic was deleted or invalid, create a new one
      logger.info('Saved System Log topic invalid, creating new one')
    }
  }

  // Create a new topic
  try {
    const topic = await bot.api.createForumTopic(groupId, '📋 System Log')
    await bot.api.sendMessage(groupId, 'Scheduled task updates and system logs will appear here.', {
      message_thread_id: topic.message_thread_id,
    })
    setBotConfig('system_log_topic_id', String(topic.message_thread_id))
    return topic.message_thread_id
  } catch (err) {
    logger.error({ err }, 'Failed to create System Log topic')
    return null
  }
}
