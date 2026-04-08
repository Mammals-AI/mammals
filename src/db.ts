import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

const DB_PATH = resolve(STORE_DIR, 'claudeclaw.db')

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
  }
  return db
}

export function initDatabase(): void {
  const d = getDb()

  // Sessions — maps each Telegram chat to a Claude Code session
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Full memory — semantic + episodic with salience decay
  d.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  // FTS5 full-text search index on memory content (external content table)
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content=memories,
      content_rowid=id
    )
  `)

  // Triggers to keep FTS in sync with memories table
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)

  // Scheduled tasks
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON scheduled_tasks(status, next_run)
  `)

  // Heartbeat config — single row
  d.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_config (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_min INTEGER NOT NULL DEFAULT 30,
      active_start TEXT NOT NULL DEFAULT '09:00',
      active_end TEXT NOT NULL DEFAULT '22:00'
    )
  `)

  // Named agents
  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL,
      session_id TEXT,
      topic_id INTEGER,
      created_at INTEGER NOT NULL
    )
  `)

  // Add topic_id column if upgrading from older schema
  try {
    d.exec('ALTER TABLE agents ADD COLUMN topic_id INTEGER')
  } catch {
    // Column already exists
  }

  // Add embedding column to memories (BLOB storing Float32Array)
  try {
    d.exec('ALTER TABLE memories ADD COLUMN embedding BLOB')
  } catch {
    // Column already exists
  }

  // Pending agent tasks — tracks in-flight work for crash recovery
  d.exec(`
    CREATE TABLE IF NOT EXISTS pending_agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      message TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      topic_id INTEGER,
      started_at INTEGER NOT NULL
    )
  `)

  // Bot config — simple key-value store for persistent settings
  d.exec(`
    CREATE TABLE IF NOT EXISTS bot_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  // Conversation log — tracks all human ↔ bot exchanges for nightly review
  d.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'telegram',
      created_at INTEGER NOT NULL
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_conversations_time ON conversations(created_at)')

  // Agent message log — tracks cross-agent communication (OpenClaw sessions_history style)
  d.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      message TEXT NOT NULL,
      response TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_agent_msgs_from ON agent_messages(from_agent, created_at)')
  d.exec('CREATE INDEX IF NOT EXISTS idx_agent_msgs_to ON agent_messages(to_agent, created_at)')

  // Agent work log — tracks every task assigned, status, result, duration, token usage
  d.exec(`
    CREATE TABLE IF NOT EXISTS agent_work_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','hung','loop')),
      result TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_work_log_agent ON agent_work_log(agent_name, created_at)')

  // Agent skills — learned capabilities per agent
  d.exec(`
    CREATE TABLE IF NOT EXISTS agent_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      skill TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      last_used INTEGER,
      times_used INTEGER DEFAULT 1,
      notes TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(agent_name, skill)
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_agent_skills_name ON agent_skills(agent_name)')

  // Add tracking columns to agents table
  try { d.exec('ALTER TABLE agents ADD COLUMN total_tokens_in INTEGER DEFAULT 0') } catch {}
  try { d.exec('ALTER TABLE agents ADD COLUMN total_tokens_out INTEGER DEFAULT 0') } catch {}
  try { d.exec('ALTER TABLE agents ADD COLUMN total_runs INTEGER DEFAULT 0') } catch {}
  try { d.exec('ALTER TABLE agents ADD COLUMN last_active INTEGER') } catch {}
  try { d.exec('ALTER TABLE agents ADD COLUMN skills_summary TEXT DEFAULT \'\'') } catch {}

  // Packlog posts — each agent's blog entries, auto-created on task completion
  d.exec(`
    CREATE TABLE IF NOT EXISTS packlog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      artifacts TEXT DEFAULT '[]',
      work_log_id INTEGER,
      created_at INTEGER NOT NULL
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_packlog_agent ON packlog_posts(agent_name, created_at)')

  logger.info('Database initialized')

  // Backfill agent conversations from work logs that aren't already in conversations
  backfillAgentConversations(d)
}

/**
 * Syncs agent_work_log entries into conversations table so agent chats
 * in the dashboard aren't empty. Runs on every startup — only inserts
 * rows that don't already exist (matched by agent name + created_at).
 */
function backfillAgentConversations(d: Database.Database): void {
  const chatId = d.prepare(`SELECT chat_id FROM conversations WHERE source = 'telegram' LIMIT 1`).get() as { chat_id: string } | undefined
  if (!chatId) return

  const inserted = d.prepare(`
    INSERT INTO conversations (chat_id, role, content, source, created_at)
    SELECT ?, 'user', wl.task, 'agent:' || wl.agent_name, wl.created_at
    FROM agent_work_log wl
    WHERE wl.task IS NOT NULL AND wl.task != ''
      AND NOT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.source = 'agent:' || wl.agent_name
          AND c.role = 'user'
          AND c.created_at = wl.created_at
      )
  `).run(chatId.chat_id)

  const inserted2 = d.prepare(`
    INSERT INTO conversations (chat_id, role, content, source, created_at)
    SELECT ?, 'assistant', wl.result, 'agent:' || wl.agent_name, COALESCE(wl.completed_at, wl.created_at + 1000)
    FROM agent_work_log wl
    WHERE wl.result IS NOT NULL AND wl.result != ''
      AND NOT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.source = 'agent:' || wl.agent_name
          AND c.role = 'assistant'
          AND c.created_at = COALESCE(wl.completed_at, wl.created_at + 1000)
      )
  `).run(chatId.chat_id)

  const total = (inserted.changes || 0) + (inserted2.changes || 0)
  if (total > 0) {
    logger.info({ backfilled: total }, 'Backfilled agent conversations from work logs')
  }
}

// --- Bot config helpers ---

export function getBotConfig(key: string): string | null {
  const d = getDb()
  const row = d.prepare('SELECT value FROM bot_config WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setBotConfig(key: string, value: string): void {
  const d = getDb()
  d.prepare('INSERT OR REPLACE INTO bot_config (key, value) VALUES (?, ?)').run(key, value)
}

// --- Session helpers ---

export function getSession(chatId: string): string | null {
  const d = getDb()
  const row = d.prepare('SELECT session_id FROM sessions WHERE chat_id = ?').get(chatId) as { session_id: string } | undefined
  return row?.session_id ?? null
}

export function setSession(chatId: string, sessionId: string): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO sessions (chat_id, session_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
  `).run(chatId, sessionId, Date.now())
}

export function clearSession(chatId: string): void {
  const d = getDb()
  d.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Memory helpers ---

interface MemoryRow {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: string
  salience: number
  created_at: number
  accessed_at: number
}

export function searchMemories(chatId: string, query: string, limit = 3): MemoryRow[] {
  const d = getDb()
  // Sanitize query for FTS: keep only alphanumeric and spaces, add wildcard
  const sanitized = query.replace(/[^\w\s]/g, '').trim()
  if (!sanitized) return []
  const ftsQuery = sanitized.split(/\s+/).map(w => w + '*').join(' ')
  try {
    return d.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts f ON f.rowid = m.id
      WHERE f.content MATCH ? AND m.chat_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, chatId, limit) as MemoryRow[]
  } catch {
    return []
  }
}

export function getRecentMemories(chatId: string, limit = 5): MemoryRow[] {
  const d = getDb()
  return d.prepare(`
    SELECT * FROM memories
    WHERE chat_id = ?
    ORDER BY accessed_at DESC
    LIMIT ?
  `).all(chatId, limit) as MemoryRow[]
}

export function touchMemory(id: number): void {
  const d = getDb()
  d.prepare(`
    UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?
  `).run(Date.now(), id)
}

export function insertMemory(chatId: string, content: string, sector: 'semantic' | 'episodic', topicKey?: string): void {
  const d = getDb()
  const now = Date.now()
  d.prepare(`
    INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
    VALUES (?, ?, ?, ?, 1.0, ?, ?)
  `).run(chatId, topicKey ?? null, content, sector, now, now)
}

export function decayMemories(): void {
  const d = getDb()
  const oneDayAgo = Date.now() - 86400_000
  d.prepare('UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?').run(oneDayAgo)
  const deleted = d.prepare('DELETE FROM memories WHERE salience < 0.1').run()
  if (deleted.changes > 0) {
    logger.info(`Decayed and deleted ${deleted.changes} stale memories`)
  }
}

export function getAllMemories(chatId: string, limit = 20): MemoryRow[] {
  const d = getDb()
  return d.prepare(`
    SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?
  `).all(chatId, limit) as MemoryRow[]
}

// --- Embedding helpers ---

export function setMemoryEmbedding(id: number, embedding: Buffer): void {
  const d = getDb()
  d.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(embedding, id)
}

export function getMemoriesWithEmbeddings(chatId: string): Array<MemoryRow & { embedding: Buffer | null }> {
  const d = getDb()
  return d.prepare(
    'SELECT * FROM memories WHERE chat_id = ? AND embedding IS NOT NULL ORDER BY salience DESC LIMIT 100'
  ).all(chatId) as Array<MemoryRow & { embedding: Buffer | null }>
}

export function getMemoriesWithoutEmbeddings(limit = 50): Array<{ id: number; content: string }> {
  const d = getDb()
  return d.prepare(
    'SELECT id, content FROM memories WHERE embedding IS NULL LIMIT ?'
  ).all(limit) as Array<{ id: number; content: string }>
}

// --- Pending agent task helpers (crash recovery) ---

export function insertPendingTask(agentName: string, message: string, chatId: string, topicId?: number): number {
  const d = getDb()
  const result = d.prepare(`
    INSERT INTO pending_agent_tasks (agent_name, message, chat_id, topic_id, started_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentName, message.slice(0, 2000), chatId, topicId ?? null, Date.now())
  return Number(result.lastInsertRowid)
}

export function completePendingTask(id: number): void {
  const d = getDb()
  d.prepare('DELETE FROM pending_agent_tasks WHERE id = ?').run(id)
}

export function getOrphanedTasks(): Array<{ id: number; agent_name: string; message: string; chat_id: string; topic_id: number | null; started_at: number }> {
  const d = getDb()
  return d.prepare('SELECT * FROM pending_agent_tasks ORDER BY started_at').all() as Array<{ id: number; agent_name: string; message: string; chat_id: string; topic_id: number | null; started_at: number }>
}

export function clearOrphanedTasks(): number {
  const d = getDb()
  return d.prepare('DELETE FROM pending_agent_tasks').run().changes
}

// --- Scheduler helpers ---

interface TaskRow {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: string
  created_at: number
}

export function getDueTasks(): TaskRow[] {
  const d = getDb()
  const now = Math.floor(Date.now() / 1000)
  return d.prepare(`
    SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?
  `).all(now) as TaskRow[]
}

export function createTask(id: string, chatId: string, prompt: string, schedule: string, nextRun: number): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, chatId, prompt, schedule, nextRun, Math.floor(Date.now() / 1000))
}

export function updateTaskAfterRun(id: string, nextRun: number, result: string): void {
  const d = getDb()
  d.prepare(`
    UPDATE scheduled_tasks SET last_run = ?, last_result = ?, next_run = ? WHERE id = ?
  `).run(Math.floor(Date.now() / 1000), result.slice(0, 1000), nextRun, id)
}

export function listTasks(chatId?: string): TaskRow[] {
  const d = getDb()
  if (chatId) {
    return d.prepare('SELECT * FROM scheduled_tasks WHERE chat_id = ?').all(chatId) as TaskRow[]
  }
  return d.prepare('SELECT * FROM scheduled_tasks').all() as TaskRow[]
}

export function deleteTask(id: string): boolean {
  const d = getDb()
  return d.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
}

export function pauseTask(id: string): void {
  const d = getDb()
  d.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id)
}

export function resumeTask(id: string): void {
  const d = getDb()
  d.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id)
}

// --- Heartbeat helpers ---

interface HeartbeatConfigRow {
  enabled: number
  interval_min: number
  active_start: string
  active_end: string
}

export interface HeartbeatConfig {
  enabled: boolean
  interval_min: number
  active_start: string
  active_end: string
}

export function getHeartbeatConfig(): HeartbeatConfig | null {
  const d = getDb()
  const row = d.prepare('SELECT * FROM heartbeat_config WHERE id = 1').get() as HeartbeatConfigRow | undefined
  if (!row) return null
  return {
    enabled: row.enabled === 1,
    interval_min: row.interval_min,
    active_start: row.active_start,
    active_end: row.active_end,
  }
}

export function setHeartbeatConfig(config: HeartbeatConfig): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO heartbeat_config (id, enabled, interval_min, active_start, active_end)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = ?, interval_min = ?, active_start = ?, active_end = ?
  `).run(
    config.enabled ? 1 : 0, config.interval_min, config.active_start, config.active_end,
    config.enabled ? 1 : 0, config.interval_min, config.active_start, config.active_end,
  )
}

// --- Animal code name pool ---
// All names are mammals. Used when creating agents without an explicit name.

const ANIMAL_POOL = [
  'wolf', 'fox', 'bear', 'lynx', 'otter', 'mink', 'badger', 'coyote',
  'panther', 'jaguar', 'bison', 'elk', 'ram', 'hound', 'ferret', 'weasel',
  'bobcat', 'wolverine', 'moose', 'puma', 'ocelot', 'marten', 'jackal',
  'dingo', 'hyena', 'mongoose', 'stoat', 'sable', 'ibex', 'kudu',
  'impala', 'gazelle', 'oryx', 'gnu', 'boar', 'stag', 'bull', 'vole',
  'shrew', 'marmot', 'chinchilla', 'lemur', 'gibbon', 'tamarin', 'coati',
  'kinkajou', 'genet', 'civet', 'serval', 'caracal',
]

/** Get the next available animal name not already used by an agent */
export function getNextAnimalName(): string {
  const d = getDb()
  const taken = new Set(
    (d.prepare('SELECT name FROM agents').all() as Array<{ name: string }>).map(r => r.name)
  )
  const available = ANIMAL_POOL.find(name => !taken.has(name))
  if (available) return available
  // Fallback: append number to a name
  for (let i = 2; ; i++) {
    const fallback = `wolf-${i}`
    if (!taken.has(fallback)) return fallback
  }
}

/** Check if a name is in the animal pool */
export function isAnimalName(name: string): boolean {
  return ANIMAL_POOL.includes(name.toLowerCase())
}

/** Get all available (unused) animal names */
export function getAvailableAnimalNames(): string[] {
  const d = getDb()
  const taken = new Set(
    (d.prepare('SELECT name FROM agents').all() as Array<{ name: string }>).map(r => r.name)
  )
  return ANIMAL_POOL.filter(name => !taken.has(name))
}

// --- Agent helpers ---

interface AgentRow {
  name: string
  description: string
  system_prompt: string
  session_id: string | null
  topic_id: number | null
  created_at: number
}

export function listAgents(): AgentRow[] {
  const d = getDb()
  return d.prepare('SELECT * FROM agents ORDER BY created_at').all() as AgentRow[]
}

export function getAgent(name: string): AgentRow | null {
  const d = getDb()
  return (d.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow) ?? null
}

export function createAgentRow(name: string, description: string, systemPrompt: string): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO agents (name, description, system_prompt, created_at)
    VALUES (?, ?, ?, ?)
  `).run(name, description, systemPrompt, Math.floor(Date.now() / 1000))
}

/** Rename an agent across all tables (agents, work_log, skills, messages, pending_tasks) */
export function renameAgent(oldName: string, newName: string): boolean {
  const d = getDb()
  const agent = d.prepare('SELECT name FROM agents WHERE name = ?').get(oldName)
  if (!agent) return false
  const existing = d.prepare('SELECT name FROM agents WHERE name = ?').get(newName)
  if (existing) throw new Error(`Agent "${newName}" already exists`)

  d.exec('BEGIN TRANSACTION')
  try {
    d.prepare('UPDATE agents SET name = ? WHERE name = ?').run(newName, oldName)
    d.prepare('UPDATE agent_work_log SET agent_name = ? WHERE agent_name = ?').run(newName, oldName)
    d.prepare('UPDATE agent_skills SET agent_name = ? WHERE agent_name = ?').run(newName, oldName)
    d.prepare('UPDATE agent_messages SET from_agent = ? WHERE from_agent = ?').run(newName, oldName)
    d.prepare('UPDATE agent_messages SET to_agent = ? WHERE to_agent = ?').run(newName, oldName)
    d.prepare('UPDATE pending_agent_tasks SET agent_name = ? WHERE agent_name = ?').run(newName, oldName)
    // Update conversations source references (agent:oldname → agent:newname)
    try {
      d.prepare("UPDATE conversations SET source = ? WHERE source = ?").run(`agent:${newName}`, `agent:${oldName}`)
    } catch {
      // conversations table may not exist in all schemas
    }
    d.exec('COMMIT')
    return true
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

export function deleteAgentRow(name: string): boolean {
  const d = getDb()
  return d.prepare('DELETE FROM agents WHERE name = ?').run(name).changes > 0
}

export function getAgentSession(name: string): string | null {
  const d = getDb()
  const row = d.prepare('SELECT session_id FROM agents WHERE name = ?').get(name) as { session_id: string | null } | undefined
  return row?.session_id ?? null
}

export function setAgentSession(name: string, sessionId: string): void {
  const d = getDb()
  d.prepare('UPDATE agents SET session_id = ? WHERE name = ?').run(sessionId, name)
}

export function getAgentTopicId(name: string): number | null {
  const d = getDb()
  const row = d.prepare('SELECT topic_id FROM agents WHERE name = ?').get(name) as { topic_id: number | null } | undefined
  return row?.topic_id ?? null
}

export function setAgentTopicId(name: string, topicId: number): void {
  const d = getDb()
  d.prepare('UPDATE agents SET topic_id = ? WHERE name = ?').run(topicId, name)
}

// --- Agent message log (cross-agent communication history) ---

interface AgentMessageRow {
  id: number
  from_agent: string
  to_agent: string
  message: string
  response: string | null
  created_at: number
}

export function logAgentMessage(from: string, to: string, message: string, response?: string): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO agent_messages (from_agent, to_agent, message, response, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(from, to, message, response ?? null, Date.now())
}

export function getAgentMessageHistory(agentName: string, limit = 20): AgentMessageRow[] {
  const d = getDb()
  return d.prepare(`
    SELECT * FROM agent_messages
    WHERE from_agent = ? OR to_agent = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(agentName, agentName, limit) as AgentMessageRow[]
}

// --- Conversation log helpers ---

export function logConversation(chatId: string, role: 'user' | 'assistant', content: string, source = 'telegram'): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO conversations (chat_id, role, content, source, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chatId, role, content.slice(0, 5000), source, Date.now())
}

export function getTodaysConversations(chatId?: string): Array<{ role: string; content: string; source: string; created_at: number }> {
  const d = getDb()
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const startMs = startOfDay.getTime()

  if (chatId) {
    return d.prepare(`
      SELECT role, content, source, created_at FROM conversations
      WHERE chat_id = ? AND created_at >= ?
      ORDER BY created_at
    `).all(chatId, startMs) as Array<{ role: string; content: string; source: string; created_at: number }>
  }
  return d.prepare(`
    SELECT role, content, source, created_at FROM conversations
    WHERE created_at >= ?
    ORDER BY created_at
  `).all(startMs) as Array<{ role: string; content: string; source: string; created_at: number }>
}

export function getRecentConversations(chatId: string, limit = 30): Array<{ role: string; content: string; source: string; created_at: number }> {
  const d = getDb()
  const rows = d.prepare(`
    SELECT role, content, source, created_at FROM conversations
    WHERE chat_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(chatId, limit) as Array<{ role: string; content: string; source: string; created_at: number }>
  return rows.reverse()
}

export function getAgentConversation(agent1: string, agent2: string, limit = 10): AgentMessageRow[] {
  const d = getDb()
  return d.prepare(`
    SELECT * FROM agent_messages
    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)
    ORDER BY created_at DESC LIMIT ?
  `).all(agent1, agent2, agent2, agent1, limit) as AgentMessageRow[]
}

// --- Agent work log helpers ---

export function startWorkLog(agentName: string, task: string): number {
  const d = getDb()
  const result = d.prepare(`
    INSERT INTO agent_work_log (agent_name, task, status, created_at)
    VALUES (?, ?, 'running', ?)
  `).run(agentName, task.slice(0, 2000), Date.now())
  return result.lastInsertRowid as number
}

export function completeWorkLog(id: number, status: 'completed' | 'failed' | 'hung' | 'loop', result: string, tokensIn: number, tokensOut: number, durationMs: number): void {
  const d = getDb()
  d.prepare(`
    UPDATE agent_work_log SET status = ?, result = ?, tokens_in = ?, tokens_out = ?, duration_ms = ?, completed_at = ?
    WHERE id = ?
  `).run(status, result?.slice(0, 2000) ?? '', tokensIn, tokensOut, durationMs, Date.now(), id)
}

export function updateAgentStats(agentName: string, tokensIn: number, tokensOut: number): void {
  const d = getDb()
  d.prepare(`
    UPDATE agents SET
      total_tokens_in = total_tokens_in + ?,
      total_tokens_out = total_tokens_out + ?,
      total_runs = total_runs + 1,
      last_active = ?
    WHERE name = ?
  `).run(tokensIn, tokensOut, Date.now(), agentName)
}

export function getAgentWorkLog(agentName: string, limit = 20): Array<{ id: number; task: string; status: string; result: string; tokens_in: number; tokens_out: number; duration_ms: number; created_at: number; completed_at: number | null }> {
  const d = getDb()
  return d.prepare(`
    SELECT * FROM agent_work_log WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?
  `).all(agentName, limit) as any[]
}

export function getAgentStats(agentName: string): { total_runs: number; total_tokens_in: number; total_tokens_out: number; last_active: number | null } | null {
  const d = getDb()
  const row = d.prepare('SELECT total_runs, total_tokens_in, total_tokens_out, last_active FROM agents WHERE name = ?').get(agentName) as any
  return row ?? null
}

export function getAllAgentStats(): Array<{ name: string; description: string; total_runs: number; total_tokens_in: number; total_tokens_out: number; last_active: number | null }> {
  const d = getDb()
  return d.prepare('SELECT name, description, total_runs, total_tokens_in, total_tokens_out, last_active FROM agents ORDER BY last_active DESC NULLS LAST').all() as any[]
}

// --- Agent skills helpers ---

export function addAgentSkill(agentName: string, skill: string, notes = ''): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO agent_skills (agent_name, skill, notes, last_used, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, skill) DO UPDATE SET
      times_used = times_used + 1,
      last_used = excluded.last_used,
      notes = CASE WHEN excluded.notes != '' THEN excluded.notes ELSE notes END
  `).run(agentName, skill, notes, Date.now(), Date.now())
}

export function getAgentSkills(agentName: string): Array<{ skill: string; confidence: number; times_used: number; last_used: number; notes: string }> {
  const d = getDb()
  return d.prepare('SELECT skill, confidence, times_used, last_used, notes FROM agent_skills WHERE agent_name = ? ORDER BY times_used DESC').all(agentName) as any[]
}

export function updateSkillConfidence(agentName: string, skill: string, confidence: number): void {
  const d = getDb()
  d.prepare('UPDATE agent_skills SET confidence = ? WHERE agent_name = ? AND skill = ?').run(confidence, agentName, skill)
}

export function removeAgentSkill(agentName: string, skill: string): boolean {
  const d = getDb()
  return d.prepare('DELETE FROM agent_skills WHERE agent_name = ? AND skill = ?').run(agentName, skill).changes > 0
}

// --- Packlog helpers ---

export interface PacklogArtifact {
  type: 'image' | 'video' | 'doc' | 'link' | 'code'
  name: string
  url: string
}

export function insertPacklogPost(
  agentName: string,
  title: string,
  body: string,
  artifacts: PacklogArtifact[] = [],
  workLogId?: number,
): number {
  const d = getDb()
  const result = d.prepare(`
    INSERT INTO packlog_posts (agent_name, title, body, artifacts, work_log_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(agentName, title.slice(0, 200), body.slice(0, 6000), JSON.stringify(artifacts), workLogId ?? null, Date.now())
  return result.lastInsertRowid as number
}

export function getPacklogPosts(agentName?: string, limit = 50, offset = 0): Array<{
  id: number; agent_name: string; title: string; body: string;
  artifacts: string; work_log_id: number | null; created_at: number
}> {
  const d = getDb()
  if (agentName) {
    return d.prepare(`SELECT * FROM packlog_posts WHERE agent_name = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(agentName, limit, offset) as any[]
  }
  return d.prepare(`SELECT * FROM packlog_posts ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as any[]
}

export function getPacklogAgentSummary(): Array<{
  name: string; description: string; post_count: number; last_post: number | null
}> {
  const d = getDb()
  return d.prepare(`
    SELECT a.name, a.description, COUNT(p.id) as post_count, MAX(p.created_at) as last_post
    FROM agents a
    LEFT JOIN packlog_posts p ON p.agent_name = a.name
    GROUP BY a.name
    ORDER BY last_post DESC NULLS LAST
  `).all() as any[]
}

// --- Agent session reports ---

export function insertAgentSession(
  agentName: string,
  summary: string,
  problems: string[],
  solutions: string[],
  task: string,
  status: string,
  tokensIn: number,
  tokensOut: number,
  durationMs: number,
): number {
  const d = getDb()
  const result = d.prepare(`
    INSERT INTO agent_sessions (agent_name, summary, problems, solutions, task, status, tokens_in, tokens_out, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(agentName, summary, JSON.stringify(problems), JSON.stringify(solutions), task, status, tokensIn, tokensOut, durationMs, Date.now())
  return result.lastInsertRowid as number
}

export function getAgentSessions(agentName: string, limit = 20): Array<{
  id: number; agent_name: string; summary: string; problems: string;
  solutions: string; task: string; status: string; tokens_in: number;
  tokens_out: number; duration_ms: number; created_at: number
}> {
  const d = getDb()
  return d.prepare(`SELECT * FROM agent_sessions WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?`)
    .all(agentName, limit) as any[]
}

export function hasRecentSession(agentName: string, withinMs: number): boolean {
  const d = getDb()
  const cutoff = Date.now() - withinMs
  const row = d.prepare(`SELECT 1 FROM agent_sessions WHERE agent_name = ? AND created_at > ? LIMIT 1`)
    .get(agentName, cutoff) as any
  return !!row
}

export function insertAgentRecommendation(
  agentName: string,
  sessionId: number | null,
  title: string,
  description: string,
  category: string,
  severity: string,
): number {
  const d = getDb()
  // Check for duplicate pending recommendation with same title
  const existing = d.prepare(`SELECT id, upvotes, upvoted_by FROM agent_recommendations WHERE title = ? AND status = 'pending'`)
    .get(title) as any
  if (existing) {
    const upvotedBy = JSON.parse(existing.upvoted_by || '[]') as string[]
    if (!upvotedBy.includes(agentName)) {
      upvotedBy.push(agentName)
      d.prepare(`UPDATE agent_recommendations SET upvotes = upvotes + 1, upvoted_by = ? WHERE id = ?`)
        .run(JSON.stringify(upvotedBy), existing.id)
    }
    return existing.id
  }
  const result = d.prepare(`
    INSERT INTO agent_recommendations (agent_name, session_id, title, description, category, severity, status, upvotes, upvoted_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
  `).run(agentName, sessionId, title, description, category, severity, JSON.stringify([agentName]), Date.now())
  return result.lastInsertRowid as number
}

export function getPendingRecommendations(limit = 50): Array<{
  id: number; agent_name: string; session_id: number | null; title: string;
  description: string; category: string; severity: string; status: string;
  upvotes: number; upvoted_by: string; daemon_notes: string; created_at: number
}> {
  const d = getDb()
  return d.prepare(`SELECT * FROM agent_recommendations WHERE status = 'pending' ORDER BY upvotes DESC, created_at DESC LIMIT ?`)
    .all(limit) as any[]
}

export function updateRecommendationStatus(id: number, status: string, daemonNotes?: string): void {
  const d = getDb()
  if (daemonNotes !== undefined) {
    d.prepare(`UPDATE agent_recommendations SET status = ?, daemon_notes = ?, resolved_at = ? WHERE id = ?`)
      .run(status, daemonNotes, status === 'implemented' || status === 'dismissed' ? Date.now() : null, id)
  } else {
    d.prepare(`UPDATE agent_recommendations SET status = ?, resolved_at = ? WHERE id = ?`)
      .run(status, status === 'implemented' || status === 'dismissed' ? Date.now() : null, id)
  }
}
