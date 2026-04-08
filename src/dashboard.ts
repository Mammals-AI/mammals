/**
 * Mission Control — Mammals command center dashboard.
 * Serves the mission-control UI and provides API endpoints.
 * Runs on port 5075.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, createReadStream } from 'node:fs'
import { resolve, extname } from 'node:path'
import { homedir } from 'node:os'
import { getDb, listAgents, getAllMemories, listTasks, getPacklogPosts, getPacklogAgentSummary, insertPacklogPost, type PacklogArtifact } from './db.js'
import { logger } from './logger.js'
import { PROJECT_ROOT, DASHBOARD_PORT } from './config.js'

const PORT = DASHBOARD_PORT
const HTML_PATH = resolve(PROJECT_ROOT, 'mission-control', 'index.html')
const PACKLOG_HTML_PATH = resolve(PROJECT_ROOT, 'workspace', 'packlog.html')
const PACKLOG_MEDIA_DIR = resolve(PROJECT_ROOT, 'store', 'packlog-media')

// Ensure media dir exists
try { mkdirSync(PACKLOG_MEDIA_DIR, { recursive: true }) } catch {}
const HQ_PATH = resolve(PROJECT_ROOT, 'workspace', 'daemon-hq.html')

// SSE clients for live updates
const sseClients = new Set<ServerResponse>()

// Activity buffer
const activityBuffer: Array<Record<string, unknown>> = []
const MAX_ACTIVITY = 100
let currentState = 'idle'

// Chat reply buffer
const chatReplies: Array<Record<string, unknown>> = []
const MAX_CHAT_REPLIES = 50

/**
 * Push a live event to all connected SSE clients.
 */
export function pushDashboardEvent(type: string, data: unknown): void {
  const payload = JSON.stringify(typeof data === 'object' ? { ...data as Record<string, unknown>, timestamp: Date.now() } : { data, timestamp: Date.now() })
  const msg = `event: ${type}\ndata: ${payload}\n\n`
  for (const client of sseClients) {
    try {
      client.write(msg)
    } catch {
      sseClients.delete(client)
    }
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() })
  res.end(JSON.stringify(body))
}

function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try { client.write(msg) } catch { sseClients.delete(client) }
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => data += chunk.toString())
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function startDashboard(): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }

    const url = req.url || '/'

    try {
      // ── Serve dashboard HTML ──
      if (url === '/' && req.method === 'GET') {
        if (existsSync(HTML_PATH)) {
          const html = readFileSync(HTML_PATH, 'utf-8')
          res.writeHead(200, { 'Content-Type': 'text/html', ...corsHeaders() })
          res.end(html)
        } else {
          res.writeHead(404, corsHeaders())
          res.end('Dashboard HTML not found')
        }
        return
      }

      // ── Serve daemon-hq.html ──
      if (url === '/daemon-hq' || url === '/daemon-hq.html') {
        if (existsSync(HQ_PATH)) {
          const html = readFileSync(HQ_PATH, 'utf-8')
          res.writeHead(200, { 'Content-Type': 'text/html', ...corsHeaders() })
          res.end(html)
        } else {
          res.writeHead(404, corsHeaders())
          res.end('HQ HTML not found')
        }
        return
      }

      // ── SSE stream ──
      if (url === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...corsHeaders(),
        })
        res.write(`event: state\ndata: ${JSON.stringify({ state: currentState })}\n\n`)
        for (const item of activityBuffer.slice(-20)) {
          res.write(`event: activity\ndata: ${JSON.stringify(item)}\n\n`)
        }
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
        return
      }

      // ── Receive state updates ──
      if (url === '/api/state' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        currentState = body.state || 'idle'
        broadcast('state', { state: currentState })
        jsonResponse(res, 200, { ok: true })
        return
      }

      // ── Receive activity updates ──
      if (url === '/api/activity' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const item = {
          type: body.type || 'info',
          message: body.message || '',
          speech: body.speech || null,
          state: body.state || currentState,
          timestamp: Date.now(),
          time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        }
        activityBuffer.push(item)
        if (activityBuffer.length > MAX_ACTIVITY) activityBuffer.shift()
        broadcast('activity', item)
        jsonResponse(res, 200, { ok: true })
        return
      }

      // ── Receive daemon reply ──
      if (url === '/api/daemon-reply' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const reply = { target: 'daemon', reply: body.reply || body.error || '', timestamp: Date.now(), error: !!body.error }
        chatReplies.push(reply)
        if (chatReplies.length > MAX_CHAT_REPLIES) chatReplies.shift()
        broadcast('chat-reply', reply)
        jsonResponse(res, 200, { ok: true })
        return
      }

      // ── Receive agent reply ──
      if (url === '/api/agent-reply' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const reply = { target: body.agent || 'unknown', reply: body.reply || body.error || '', timestamp: Date.now(), error: !!body.error }
        chatReplies.push(reply)
        if (chatReplies.length > MAX_CHAT_REPLIES) chatReplies.shift()
        broadcast('chat-reply', reply)
        jsonResponse(res, 200, { ok: true })
        return
      }

      // ── Receive raw Claude reply ──
      if (url === '/api/claude-reply' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const reply = { target: 'claude', reply: body.reply || body.error || '', timestamp: Date.now(), error: !!body.error }
        chatReplies.push(reply)
        if (chatReplies.length > MAX_CHAT_REPLIES) chatReplies.shift()
        broadcast('chat-reply', reply)
        jsonResponse(res, 200, { ok: true })
        return
      }

      // ── List agents ──
      if (url === '/api/agents' && req.method === 'GET') {
        const agents = listAgents()
        jsonResponse(res, 200, agents)
        return
      }

      // ── Update agent prompt ──
      const agentUpdateMatch = url.match(/^\/api\/agents\/([^/]+)\/update$/)
      if (agentUpdateMatch && req.method === 'PUT') {
        const agentName = decodeURIComponent(agentUpdateMatch[1])
        const body = JSON.parse(await readBody(req))
        const db = getDb()
        const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(agentName)
        if (!agent) {
          jsonResponse(res, 404, { error: 'Agent not found' })
          return
        }
        if (body.system_prompt !== undefined) {
          db.prepare('UPDATE agents SET system_prompt = ? WHERE name = ?').run(body.system_prompt, agentName)
        }
        if (body.description !== undefined) {
          db.prepare('UPDATE agents SET description = ? WHERE name = ?').run(body.description, agentName)
        }
        if (body.system_prompt !== undefined) {
          db.prepare('UPDATE agents SET session_id = NULL WHERE name = ?').run(agentName)
        }
        const updated = db.prepare('SELECT * FROM agents WHERE name = ?').get(agentName)
        jsonResponse(res, 200, updated)
        return
      }

      // ── List memories ──
      if (url.startsWith('/api/memories') && req.method === 'GET') {
        const params = new URL(url, 'http://localhost').searchParams
        const sector = params.get('sector')
        const limit = Math.min(parseInt(params.get('limit') || '50'), 200)
        const search = params.get('q')
        const db = getDb()
        let memories: unknown[]
        if (search) {
          const sanitized = search.replace(/[^\w\s]/g, '').trim()
          if (sanitized) {
            const ftsQuery = sanitized.split(/\s+/).map(w => w + '*').join(' ')
            memories = db.prepare(`
              SELECT m.* FROM memories m
              JOIN memories_fts f ON f.rowid = m.id
              WHERE f.content MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(ftsQuery, limit)
          } else {
            memories = []
          }
        } else if (sector) {
          memories = db.prepare(
            'SELECT * FROM memories WHERE sector = ? ORDER BY accessed_at DESC LIMIT ?'
          ).all(sector, limit)
        } else {
          memories = db.prepare(
            'SELECT * FROM memories ORDER BY accessed_at DESC LIMIT ?'
          ).all(limit)
        }
        const total = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }
        const semanticCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE sector = 'semantic'").get() as { count: number }
        const episodicCount = db.prepare("SELECT COUNT(*) as count FROM memories WHERE sector = 'episodic'").get() as { count: number }
        jsonResponse(res, 200, {
          memories,
          stats: { total: total.count, semantic: semanticCount.count, episodic: episodicCount.count }
        })
        return
      }

      // ── Agent activity log (living history) ──
      if (url.startsWith('/api/activity-log') && req.method === 'GET') {
        const params = new URL(url, 'http://localhost').searchParams
        const agent = params.get('agent')
        const status = params.get('status')
        const limit = Math.min(parseInt(params.get('limit') || '200'), 500)
        const before = params.get('before')
        const search = params.get('q')
        const db = getDb()

        // --- Work log entries ---
        let wlQuery = 'SELECT * FROM agent_work_log WHERE 1=1'
        const wlBinds: unknown[] = []
        if (agent) { wlQuery += ' AND agent_name = ?'; wlBinds.push(agent) }
        if (status) { wlQuery += ' AND status = ?'; wlBinds.push(status) }
        if (before) { wlQuery += ' AND created_at < ?'; wlBinds.push(parseInt(before)) }
        if (search) { wlQuery += ' AND (task LIKE ? OR result LIKE ?)'; wlBinds.push(`%${search}%`, `%${search}%`) }
        wlQuery += ' ORDER BY created_at DESC LIMIT ?'
        wlBinds.push(limit)
        const workEntries = db.prepare(wlQuery).all(...wlBinds) as any[]

        // --- Agent conversation history (from conversations table) ---
        let convQuery = `SELECT role, content, source, created_at FROM conversations WHERE source LIKE 'agent:%'`
        const convBinds: unknown[] = []
        if (agent) { convQuery += ' AND source = ?'; convBinds.push(`agent:${agent}`) }
        if (before) { convQuery += ' AND created_at < ?'; convBinds.push(parseInt(before)) }
        if (search) { convQuery += ' AND content LIKE ?'; convBinds.push(`%${search}%`) }
        convQuery += ' ORDER BY created_at DESC LIMIT ?'
        convBinds.push(limit)
        const agentConvs = db.prepare(convQuery).all(...convBinds) as any[]

        // --- Episodic memories (the project history narrative) ---
        let memQuery = `SELECT id, sector, content, accessed_at FROM memories WHERE sector = 'episodic'`
        const memBinds: unknown[] = []
        if (search) { memQuery += ' AND content LIKE ?'; memBinds.push(`%${search}%`) }
        if (before) { memQuery += ' AND accessed_at < ?'; memBinds.push(parseInt(before)) }
        memQuery += ' ORDER BY accessed_at DESC LIMIT ?'
        memBinds.push(Math.min(limit, 300))
        const memories = db.prepare(memQuery).all(...memBinds) as any[]

        // --- Main conversation history (telegram) ---
        let telegramQuery = `SELECT role, content, source, created_at FROM conversations WHERE source = 'telegram'`
        const tgBinds: unknown[] = []
        if (search) { telegramQuery += ' AND content LIKE ?'; tgBinds.push(`%${search}%`) }
        if (before) { telegramQuery += ' AND created_at < ?'; tgBinds.push(parseInt(before)) }
        telegramQuery += ' ORDER BY created_at DESC LIMIT ?'
        tgBinds.push(limit)
        const telegramConvs = db.prepare(telegramQuery).all(...tgBinds) as any[]

        // --- Per-agent summary stats ---
        const agentStats = db.prepare(`
          SELECT
            a.name as agent_name, a.description,
            COUNT(w.id) as total_tasks,
            SUM(CASE WHEN w.status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN w.status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(w.tokens_in + w.tokens_out) as total_tokens,
            MAX(w.created_at) as last_active
          FROM agents a
          LEFT JOIN agent_work_log w ON w.agent_name = a.name
          GROUP BY a.name ORDER BY last_active DESC NULLS LAST
        `).all() as any[]

        // --- Summary stats ---
        const totalTasks = db.prepare('SELECT COUNT(*) as n FROM agent_work_log').get() as any
        const totalTokens = db.prepare('SELECT SUM(tokens_in + tokens_out) as n FROM agent_work_log').get() as any
        const dateRange = db.prepare('SELECT MIN(created_at) as mn, MAX(created_at) as mx FROM conversations').get() as any

        jsonResponse(res, 200, {
          workEntries,
          agentConvs,
          memories,
          telegramConvs,
          agentStats,
          summary: {
            totalTasks: totalTasks?.n || 0,
            totalTokens: totalTokens?.n || 0,
            totalMemories: memories.length,
            since: dateRange?.mn || null,
          }
        })
        return
      }

      // ── List scheduled tasks ──
      if (url === '/api/tasks' && req.method === 'GET') {
        const tasks = listTasks()
        jsonResponse(res, 200, tasks)
        return
      }

      // ── System status ──
      if (url === '/api/system' && req.method === 'GET') {
        const db = getDb()
        const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }
        const memoryCount = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }
        const taskCount = db.prepare("SELECT COUNT(*) as count FROM scheduled_tasks WHERE status = 'active'").get() as { count: number }
        const heartbeat = db.prepare('SELECT * FROM heartbeat_config WHERE id = 1').get()
        let botRunning = false
        try {
          const pidFile = resolve(PROJECT_ROOT, 'store', 'claudeclaw.pid')
          if (existsSync(pidFile)) {
            const pid = readFileSync(pidFile, 'utf-8').trim()
            process.kill(parseInt(pid), 0)
            botRunning = true
          }
        } catch { botRunning = false }
        jsonResponse(res, 200, {
          botRunning, uptime: process.uptime(),
          agents: agentCount.count, memories: memoryCount.count,
          activeTasks: taskCount.count, heartbeat: heartbeat || null,
          sseClients: sseClients.size,
        })
        return
      }

      // ── Proxy send to daemon ──
      if (url === '/api/daemon/send' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const resp = await fetch('http://127.0.0.1:5062/api/daemon/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(5000),
          })
          const result = await resp.json()
          jsonResponse(res, resp.status, result)
        } catch {
          jsonResponse(res, 502, { error: 'Bot API unreachable' })
        }
        return
      }

      // ── Proxy send to agent ──
      const agentSendMatch = url.match(/^\/api\/agents\/([^/]+)\/send$/)
      if (agentSendMatch && req.method === 'POST') {
        const agentName = decodeURIComponent(agentSendMatch[1])
        const body = await readBody(req)
        try {
          const resp = await fetch(`http://127.0.0.1:5062/api/agents/${encodeURIComponent(agentName)}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(5000),
          })
          const result = await resp.json()
          jsonResponse(res, resp.status, result)
        } catch {
          jsonResponse(res, 502, { error: 'Bot API unreachable' })
        }
        return
      }

      // ── Proxy send to raw Claude ──
      if (url === '/api/claude/send' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const resp = await fetch('http://127.0.0.1:5062/api/claude/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(5000),
          })
          const result = await resp.json()
          jsonResponse(res, resp.status, result)
        } catch {
          jsonResponse(res, 502, { error: 'Bot API unreachable' })
        }
        return
      }

      // ── List editable files ──
      if (url === '/api/files' && req.method === 'GET') {
        const home = homedir()
        const scriptsDir = resolve(PROJECT_ROOT, 'scripts')
        const memoryDir = resolve(home, '.claude', 'projects', PROJECT_ROOT.replace(/\//g, '-').replace(/^-/, ''), 'memory')
        const categories = [
          {
            name: 'System',
            files: [
              { name: 'CLAUDE.md', path: resolve(PROJECT_ROOT, 'CLAUDE.md'), category: 'system' },
            ],
          },
          {
            name: 'Scripts',
            files: (() => {
              try {
                return readdirSync(scriptsDir)
                  .filter(f => f.endsWith('.py') || f.endsWith('.sh') || f.endsWith('.ts'))
                  .map(f => ({ name: f, path: resolve(scriptsDir, f), category: 'script' }))
              } catch { return [] }
            })(),
          },
          {
            name: 'Memory',
            files: (() => {
              try {
                return readdirSync(memoryDir)
                  .filter(f => f.endsWith('.md'))
                  .map(f => ({ name: f, path: resolve(memoryDir, f), category: 'memory' }))
              } catch { return [] }
            })(),
          },
          {
            name: 'Config',
            files: [
              { name: 'model-config.json', path: resolve(PROJECT_ROOT, 'store', 'model-config.json'), category: 'config' },
            ],
          },
        ]
        jsonResponse(res, 200, { categories })
        return
      }

      // ── Read file ──
      if (url.startsWith('/api/files/read') && req.method === 'GET') {
        const params = new URL(url, 'http://localhost').searchParams
        const filePath = params.get('path')
        const home = homedir()
        const allowed = [
          PROJECT_ROOT,
          resolve(home, '.claude', 'projects', PROJECT_ROOT.replace(/\//g, '-').replace(/^-/, ''), 'memory'),
        ]
        if (!filePath || !allowed.some(p => filePath.startsWith(p))) {
          jsonResponse(res, 403, { error: 'Forbidden' })
          return
        }
        try {
          const content = readFileSync(filePath, 'utf-8')
          jsonResponse(res, 200, { content, path: filePath })
        } catch {
          jsonResponse(res, 404, { error: 'File not found' })
        }
        return
      }

      // ── Write file ──
      if (url === '/api/files/write' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const { path: filePath, content } = body
        const home = homedir()
        const allowed = [
          PROJECT_ROOT,
          resolve(home, '.claude', 'projects', PROJECT_ROOT.replace(/\//g, '-').replace(/^-/, ''), 'memory'),
        ]
        if (!filePath || !allowed.some(p => filePath.startsWith(p))) {
          jsonResponse(res, 403, { error: 'Forbidden' })
          return
        }
        try {
          writeFileSync(filePath, content, 'utf-8')
          jsonResponse(res, 200, { ok: true })
        } catch {
          jsonResponse(res, 500, { error: 'Write failed' })
        }
        return
      }

      // ── Chat history (main daemon) ──
      if (url.startsWith('/api/conversations') && req.method === 'GET') {
        const params = new URL(url, 'http://localhost').searchParams
        const limit = Math.min(parseInt(params.get('limit') || '50'), 200)
        const before = params.get('before') // created_at cursor for pagination
        const db = getDb()
        let rows: any[]
        if (before) {
          rows = db.prepare(
            `SELECT id, role, content, source, created_at FROM conversations WHERE source = 'dashboard' AND created_at < ? ORDER BY created_at DESC LIMIT ?`
          ).all(parseInt(before), limit) as any[]
        } else {
          rows = db.prepare(
            `SELECT id, role, content, source, created_at FROM conversations WHERE source = 'dashboard' ORDER BY created_at DESC LIMIT ?`
          ).all(limit) as any[]
        }
        jsonResponse(res, 200, { messages: rows.reverse() })
        return
      }

      // ── Agent message history ──
      const agentHistoryMatch = url.match(/^\/api\/agents\/([^/]+)\/history(?:\?.*)?$/)
      if (agentHistoryMatch && req.method === 'GET') {
        const agentName = decodeURIComponent(agentHistoryMatch[1])
        const params = new URL(url, 'http://localhost').searchParams
        const limit = Math.min(parseInt(params.get('limit') || '50'), 200)
        const db = getDb()
        // Agent messages are stored in conversations with a source tag, or we pull from memories
        const rows = db.prepare(
          `SELECT id, role, content, source, created_at FROM conversations WHERE source = ? ORDER BY created_at DESC LIMIT ?`
        ).all(`agent:${agentName}`, limit) as any[]
        jsonResponse(res, 200, { messages: rows.reverse() })
        return
      }

      // ── Packlog site ──
      if ((url === '/packlog' || url === '/packlog.html') && req.method === 'GET') {
        if (existsSync(PACKLOG_HTML_PATH)) {
          const html = readFileSync(PACKLOG_HTML_PATH, 'utf-8')
          res.writeHead(200, { 'Content-Type': 'text/html', ...corsHeaders() })
          res.end(html)
        } else {
          res.writeHead(404, corsHeaders())
          res.end('Packlog HTML not found')
        }
        return
      }

      // ── Packlog media ──
      const mediaMatch = url.match(/^\/api\/packlog\/media\/(.+)$/)
      if (mediaMatch && req.method === 'GET') {
        const filename = decodeURIComponent(mediaMatch[1]).replace(/\.\./g, '')
        const filePath = resolve(PACKLOG_MEDIA_DIR, filename)
        if (existsSync(filePath)) {
          const ext = extname(filename).toLowerCase()
          const mime: Record<string, string> = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
            '.webm': 'video/webm', '.pdf': 'application/pdf',
          }
          res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', ...corsHeaders() })
          createReadStream(filePath).pipe(res)
        } else {
          res.writeHead(404, corsHeaders())
          res.end('Not found')
        }
        return
      }

      // ── Packlog API: agent summary ──
      if (url === '/api/packlog' && req.method === 'GET') {
        jsonResponse(res, 200, { agents: getPacklogAgentSummary() })
        return
      }

      // ── Packlog API: posts for agent ──
      const packlogAgentMatch = url.match(/^\/api\/packlog\/([^/?]+)/)
      if (packlogAgentMatch && req.method === 'GET') {
        const agentName = decodeURIComponent(packlogAgentMatch[1])
        const params = new URL(url, 'http://localhost').searchParams
        const limit = Math.min(parseInt(params.get('limit') || '50'), 200)
        const offset = parseInt(params.get('offset') || '0')
        jsonResponse(res, 200, { posts: getPacklogPosts(agentName, limit, offset) })
        return
      }

      // ── Packlog API: add post ──
      if (url === '/api/packlog' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const { agent_name, title, post_body, artifacts, work_log_id } = body
        if (!agent_name || !title) {
          jsonResponse(res, 400, { error: 'agent_name and title required' })
          return
        }
        const id = insertPacklogPost(
          agent_name,
          title,
          post_body || '',
          (artifacts || []) as PacklogArtifact[],
          work_log_id,
        )
        jsonResponse(res, 200, { ok: true, id })
        return
      }

      jsonResponse(res, 404, { error: 'Not found' })
    } catch (err) {
      logger.error({ err }, 'Mission Control error')
      jsonResponse(res, 500, { error: 'Internal error' })
    }
  })

  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`Mission Control running on http://localhost:${PORT}`)
  })
}
