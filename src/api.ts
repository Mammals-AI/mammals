/**
 * HTTP API for Mammals HQ and other external clients.
 * Runs alongside the Grammy bot on port 5062.
 * Routes messages through the real bot pipeline (memory, sessions, agents).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSession, setSession, logConversation } from './db.js'
import { runAgent } from './agent.js'
import { buildMemoryContext, saveConversationTurn } from './memory.js'
import { listAllAgents, getAgentByName, sendToAgent, isAgentBusy } from './agents.js'
import { voiceCapabilities, synthesizeSpeech } from './voice.js'
import { displayState, displayActivity } from './display.js'
import { logger } from './logger.js'
import { ALLOWED_CHAT_ID, PROJECT_ROOT, API_PORT } from './config.js'
import { needsChrome } from './routing.js'
import { readEnvFile } from './env.js'

const FOCUS_BOARD_PATH = resolve(PROJECT_ROOT, 'workspace', 'focus-board.json')
const FOCUS_DASHBOARD_PATH = resolve(PROJECT_ROOT, 'workspace', 'focus-dashboard.html')
const DAEMON_VISUALIZER_PATH = resolve(PROJECT_ROOT, 'workspace', 'daemon-visualizer.html')

const PORT = API_PORT

// Simple bearer token auth for the HTTP API (optional — set CLAUDECLAW_API_TOKEN in .env)
const API_TOKEN = readEnvFile(['CLAUDECLAW_API_TOKEN'])['CLAUDECLAW_API_TOKEN'] ?? ''

// Use the allowed chat ID as the "Mammals HQ" identity so it shares memory/session with Telegram
const HQ_CHAT_ID = ALLOWED_CHAT_ID || 'mammals-hq'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(body))
}

export function startApi() {
  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    const url = req.url || '/'

    try {
      // ── Auth check (skip health check and CORS preflight) ──
      if (API_TOKEN && url !== '/api/status') {
        const authHeader = req.headers.authorization
        if (authHeader !== `Bearer ${API_TOKEN}`) {
          return json(res, 401, { error: 'Unauthorized' })
        }
      }

      // ── Health check ──
      if (url === '/api/status' && req.method === 'GET') {
        return json(res, 200, { ok: true, uptime: process.uptime() })
      }

      // ── Send to Daemon (main bot with full memory) ──
      if (url === '/api/daemon/send' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const message = body.message?.trim()
        if (!message) return json(res, 400, { error: 'No message' })

        // Respond immediately — process in background
        json(res, 200, { ok: true })

        logger.info({ message: message.slice(0, 80) }, 'Mammals HQ daemon request received')

        // Use the real pipeline: memory injection, session resumption, memory saving
        const chatId = HQ_CHAT_ID
        const sessionId = getSession(chatId) ?? undefined
        let fullMessage = `[Mammals HQ] ${message}`

        if (!sessionId) {
          const memoryCtx = await buildMemoryContext(chatId, message)
          if (memoryCtx) {
            fullMessage = `${memoryCtx}\n\n[Mammals HQ] ${message}`
          }
        }

        const needsBrowser = needsChrome(message)
        logger.info({ sessionId, fullMessageLen: fullMessage.length, chrome: needsBrowser }, 'Mammals HQ calling runAgent')
        displayActivity('command', `[Mammals HQ] ${message.slice(0, 80)}`, 'thinking')
        displayState('executing')

        try {
          const { text, newSessionId } = await runAgent(fullMessage, sessionId, undefined, undefined, undefined, needsBrowser)
          logger.info({ replyLen: text?.length, newSessionId }, 'Mammals HQ runAgent completed')
          const reply = text ?? 'Done!'

          if (newSessionId) {
            setSession(chatId, newSessionId)
          }

          saveConversationTurn(chatId, message, reply)
          logConversation(chatId, 'user', message, 'dashboard')
          logConversation(chatId, 'assistant', reply, 'dashboard')
          displayActivity('success', `[Mammals HQ] Reply: ${reply.slice(0, 80)}`, 'talking', reply.slice(0, 500))

          // Push response to Mammals HQ display + dashboard
          const replyPayload = JSON.stringify({ reply: reply.slice(0, 4000), sessionId: newSessionId })
          const postOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: replyPayload, signal: AbortSignal.timeout(3000) }
          await Promise.allSettled([
            fetch('http://localhost:5055/api/daemon-reply', postOpts),
            fetch('http://localhost:5075/api/daemon-reply', { ...postOpts, signal: AbortSignal.timeout(3000) }),
          ])
        } catch (err) {
          const errMsg = `Error: ${err instanceof Error ? err.message : String(err)}`
          const errPayload = JSON.stringify({ error: errMsg })
          const errOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: errPayload, signal: AbortSignal.timeout(3000) }
          await Promise.allSettled([
            fetch('http://localhost:5055/api/daemon-reply', errOpts),
            fetch('http://localhost:5075/api/daemon-reply', { ...errOpts, signal: AbortSignal.timeout(3000) }),
          ])
        } finally {
          setTimeout(() => displayState('idle'), 3000)
        }
        return
      }

      // ── List agents ──
      if (url === '/api/agents' && req.method === 'GET') {
        const agents = listAllAgents().map(a => ({
          name: a.name,
          description: a.description,
          busy: isAgentBusy(a.name),
        }))
        return json(res, 200, agents)
      }

      // ── Send to agent (through the real agent system) ──
      const agentMatch = url.match(/^\/api\/agents\/([^/]+)\/send$/)
      if (agentMatch && req.method === 'POST') {
        const agentName = decodeURIComponent(agentMatch[1])
        const body = JSON.parse(await readBody(req))
        const message = body.message?.trim()
        if (!message) return json(res, 400, { error: 'No message' })

        const agent = getAgentByName(agentName)
        if (!agent) return json(res, 404, { error: 'Agent not found' })

        if (isAgentBusy(agentName)) {
          return json(res, 409, { error: 'Agent is busy' })
        }

        // Respond immediately
        json(res, 200, { ok: true })

        // Use the real sendToAgent (synchronous version — returns result)
        try {
          const reply = await sendToAgent(agentName, message)
          logConversation(ALLOWED_CHAT_ID, 'user', message, `agent:${agentName}`)
          logConversation(ALLOWED_CHAT_ID, 'assistant', reply, `agent:${agentName}`)

          // Push response to Mammals HQ display + dashboard
          const agentPayload = JSON.stringify({ agent: agentName, reply: reply.slice(0, 4000) })
          const agentOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: agentPayload, signal: AbortSignal.timeout(3000) }
          await Promise.allSettled([
            fetch('http://localhost:5055/api/agent-reply', agentOpts),
            fetch('http://localhost:5075/api/agent-reply', { ...agentOpts, signal: AbortSignal.timeout(3000) }),
          ])
        } catch (err) {
          const agentErrPayload = JSON.stringify({ agent: agentName, error: `Error: ${err instanceof Error ? err.message : String(err)}` })
          const agentErrOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: agentErrPayload, signal: AbortSignal.timeout(3000) }
          await Promise.allSettled([
            fetch('http://localhost:5055/api/agent-reply', agentErrOpts),
            fetch('http://localhost:5075/api/agent-reply', { ...agentErrOpts, signal: AbortSignal.timeout(3000) }),
          ])
        }
        return
      }

      // ── Send to raw Claude Code session (no system prompt, no memory) ──
      if (url === '/api/claude/send' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const message = body.message?.trim()
        if (!message) return json(res, 400, { error: 'No message' })

        // Respond immediately — process in background
        json(res, 200, { ok: true })

        logger.info({ message: message.slice(0, 80) }, 'Raw Claude session request')

        // Get or create a dedicated session for raw Claude (separate from daemon)
        const claudeChatId = 'claude-raw'
        const sessionId = getSession(claudeChatId) ?? undefined

        try {
          const { text, newSessionId } = await runAgent(message, sessionId)

          if (newSessionId) {
            setSession(claudeChatId, newSessionId)
          }

          const reply = text ?? 'Done!'
          logConversation(ALLOWED_CHAT_ID, 'user', message, 'claude-raw')
          logConversation(ALLOWED_CHAT_ID, 'assistant', reply, 'claude-raw')

          // Push response via dashboard SSE
          const replyPayload = JSON.stringify({ reply: reply.slice(0, 4000) })
          const postOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: replyPayload, signal: AbortSignal.timeout(3000) }
          await Promise.allSettled([
            fetch('http://localhost:5075/api/claude-reply', postOpts),
          ])
        } catch (err) {
          const errMsg = `Error: ${err instanceof Error ? err.message : String(err)}`
          const errPayload = JSON.stringify({ error: errMsg })
          const errOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: errPayload, signal: AbortSignal.timeout(3000) }
          await Promise.allSettled([
            fetch('http://localhost:5075/api/claude-reply', errOpts),
          ])
        }
        return
      }

      // ── Voice capabilities ──
      if (url === '/api/voice/capabilities' && req.method === 'GET') {
        return json(res, 200, voiceCapabilities())
      }

      // ── TTS — text to speech via ElevenLabs ──
      if (url === '/api/voice/tts' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const text = body.text?.trim()
        if (!text) return json(res, 400, { error: 'No text' })

        const { tts } = voiceCapabilities()
        if (!tts) return json(res, 503, { error: 'TTS not configured' })

        try {
          const audioBuffer = await synthesizeSpeech(text.slice(0, 5000))
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': audioBuffer.length.toString(),
            'Access-Control-Allow-Origin': '*',
          })
          res.end(audioBuffer)
        } catch (err) {
          logger.error({ err }, 'TTS API error')
          json(res, 500, { error: 'TTS failed' })
        }
        return
      }

      // ── Daemon visualizer ──
      if (url === '/visualizer' && req.method === 'GET') {
        if (existsSync(DAEMON_VISUALIZER_PATH)) {
          const html = readFileSync(DAEMON_VISUALIZER_PATH, 'utf-8')
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(html)
        } else {
          json(res, 404, { error: 'Visualizer not found' })
        }
        return
      }

      // ── Focus board dashboard ──
      if (url === '/focus' && req.method === 'GET') {
        if (existsSync(FOCUS_DASHBOARD_PATH)) {
          const html = readFileSync(FOCUS_DASHBOARD_PATH, 'utf-8')
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(html)
        } else {
          json(res, 404, { error: 'Dashboard not found' })
        }
        return
      }

      // ── Focus board data ──
      if (url === '/api/focus/tasks' && req.method === 'GET') {
        if (existsSync(FOCUS_BOARD_PATH)) {
          const data = readFileSync(FOCUS_BOARD_PATH, 'utf-8')
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(data)
        } else {
          json(res, 200, { tasks: [], today_focus: [], weather: null, last_updated: null })
        }
        return
      }

      // ── Webhook receiver ──
      const hookMatch = url.match(/^\/api\/hooks\/(\w+)/)
      if (hookMatch && req.method === 'POST') {
        const { getWebhook, verifyWebhookSignature, buildWebhookMessage } = await import('./webhooks.js')
        const hookId = hookMatch[1]
        const webhook = getWebhook(hookId)

        if (!webhook) return json(res, 404, { error: 'Webhook not found' })

        const body = await readBody(req)

        // Verify signature (skip auth token check — webhooks use their own secret)
        const verified = verifyWebhookSignature(webhook, req.headers as Record<string, string | undefined>, body)
        // Also allow query param secret as fallback
        const urlObj = new URL(url, 'http://localhost')
        const querySecret = urlObj.searchParams.get('secret')
        if (!verified && querySecret !== webhook.secret) {
          return json(res, 401, { error: 'Invalid webhook signature' })
        }

        // Parse payload and build message
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(body)
        } catch {
          payload = { raw: body.slice(0, 2000) }
        }

        const message = buildWebhookMessage(webhook, payload)

        // Route to agent or main bot
        if (webhook.agent) {
          const { getAgentByName, sendToAgentBackground } = await import('./agents.js')
          const agent = getAgentByName(webhook.agent)
          if (agent) {
            sendToAgentBackground(webhook.agent, message, HQ_CHAT_ID)
          }
        } else {
          // Route through main bot pipeline
          const chatId = HQ_CHAT_ID
          const sessionId = getSession(chatId) ?? undefined
          runAgent(`[Webhook: ${webhook.name}] ${message}`, sessionId, undefined, undefined, undefined, false)
            .then(({ text, newSessionId }) => {
              if (newSessionId) setSession(chatId, newSessionId)
              logger.info({ webhook: webhook.name, replyLen: text?.length }, 'Webhook processed')
            })
            .catch(err => logger.error({ err, webhook: webhook.name }, 'Webhook processing failed'))
        }

        return json(res, 200, { ok: true, webhook: webhook.name })
      }

      // ── Device pairing ──
      if (url === '/api/pair' && req.method === 'POST') {
        const { redeemPairingCode } = await import('./pairing.js')
        const body = JSON.parse(await readBody(req))
        const code = body.code?.trim()
        if (!code) return json(res, 400, { error: 'No code' })

        const session = redeemPairingCode(code)
        if (!session) return json(res, 401, { error: 'Invalid or expired pairing code' })

        return json(res, 200, {
          ok: true,
          device: session.device_name,
          token: session.token,
          expires_at: session.expires_at,
        })
      }

      // ── Not found ──
      json(res, 404, { error: 'Not found' })
    } catch (err) {
      logger.error({ err }, 'API error')
      json(res, 500, { error: 'Internal error' })
    }
  })

  server.listen(PORT, '127.0.0.1', () => {
    logger.info(`API server listening on http://127.0.0.1:${PORT}`)
  })

  server.on('error', (err) => {
    logger.error({ err }, 'API server failed to start')
  })
}
