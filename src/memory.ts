import {
  searchMemories, getRecentMemories, touchMemory,
  insertMemory, decayMemories, setMemoryEmbedding,
  getMemoriesWithEmbeddings, getMemoriesWithoutEmbeddings,
  getRecentConversations,
} from './db.js'
import { generateEmbedding, cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from './embeddings.js'
import { matchSkills } from './skills.js'
import { BOT_OWNER } from './config.js'
import { logger } from './logger.js'

const SEMANTIC_PATTERN = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i

// Token budget: ~2000 tokens max for memory context (4 chars ≈ 1 token)
const MAX_MEMORY_CHARS = 8000

// Weights for hybrid search scoring
const VECTOR_WEIGHT = 0.6
const KEYWORD_WEIGHT = 0.4

// MMR diversity parameter (0 = pure diversity, 1 = pure relevance)
const MMR_LAMBDA = 0.7

interface ScoredMemory {
  id: number
  content: string
  sector: string
  score: number
}

/**
 * Hybrid search: combines FTS keyword matches with vector similarity.
 * Falls back to keyword-only if Ollama is unavailable.
 */
async function hybridSearch(chatId: string, query: string, limit: number): Promise<ScoredMemory[]> {
  // 1. FTS keyword search
  const ftsResults = searchMemories(chatId, query, limit * 2)
  const ftsMap = new Map<number, number>()

  // Normalize FTS ranks to 0-1 scores (lower rank = better match in SQLite FTS5)
  if (ftsResults.length > 0) {
    const maxRank = Math.max(...ftsResults.map((_, i) => i + 1))
    ftsResults.forEach((m, i) => {
      ftsMap.set(m.id, 1 - (i / maxRank))
    })
  }

  // 2. Vector similarity search (if Ollama is available)
  const queryEmbedding = await generateEmbedding(query)
  const vectorMap = new Map<number, number>()

  // Cache embedded memories so we don't query DB twice
  const memoriesWithVectors = queryEmbedding ? getMemoriesWithEmbeddings(chatId) : []

  if (queryEmbedding) {
    for (const m of memoriesWithVectors) {
      if (m.embedding) {
        const memEmbed = bufferToEmbedding(m.embedding)
        const sim = cosineSimilarity(queryEmbedding, memEmbed)
        vectorMap.set(m.id, sim)
      }
    }
  }

  // 3. Merge results with weighted scoring
  const allIds = new Set([...ftsMap.keys(), ...vectorMap.keys()])
  const scored: ScoredMemory[] = []

  for (const id of allIds) {
    const ftsScore = ftsMap.get(id) ?? 0
    const vecScore = vectorMap.get(id) ?? 0

    let score: number
    if (ftsMap.has(id) && vectorMap.has(id)) {
      score = VECTOR_WEIGHT * vecScore + KEYWORD_WEIGHT * ftsScore
    } else if (vectorMap.has(id)) {
      score = vecScore
    } else {
      score = ftsScore
    }

    // Find the memory content from cached results (no second DB query)
    const mem = ftsResults.find(m => m.id === id) ??
                memoriesWithVectors.find(m => m.id === id)
    if (mem) {
      scored.push({ id: mem.id, content: mem.content, sector: mem.sector, score })
    }
  }

  // 4. Sort by score descending
  scored.sort((a, b) => b.score - a.score)

  // 5. Apply MMR re-ranking for diversity
  return applyMMR(scored, limit)
}

/**
 * Maximal Marginal Relevance — reduces redundant results.
 * Iteratively selects items that are both relevant and diverse.
 */
function applyMMR(candidates: ScoredMemory[], limit: number): ScoredMemory[] {
  if (candidates.length <= limit) return candidates

  const selected: ScoredMemory[] = []
  const remaining = [...candidates]

  // Always pick the top-scored item first
  selected.push(remaining.shift()!)

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const relevance = candidate.score

      // Compute max similarity to already selected items (using Jaccard on tokens)
      let maxSim = 0
      const candTokens = tokenize(candidate.content)
      for (const sel of selected) {
        const selTokens = tokenize(sel.content)
        const sim = jaccardSimilarity(candTokens, selTokens)
        if (sim > maxSim) maxSim = sim
      }

      // MMR score: balance relevance vs diversity
      const mmrScore = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim

      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0])
  }

  return selected
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\w+/g) ?? [])
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Build memory context with hybrid search, skills, and token budget.
 */
export async function buildMemoryContext(chatId: string, userMessage: string): Promise<string> {
  // Hybrid search (FTS + vector)
  const hybridResults = await hybridSearch(chatId, userMessage, 5)

  // Also grab most recently accessed memories
  const recentResults = getRecentMemories(chatId, 3)

  // Deduplicate by id
  const seen = new Set<number>()
  const combined: ScoredMemory[] = []
  for (const m of hybridResults) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      combined.push(m)
    }
  }
  for (const m of recentResults) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      combined.push({ id: m.id, content: m.content, sector: m.sector, score: 0 })
    }
  }

  if (combined.length === 0 && !matchSkills(userMessage)) return ''

  // Touch each memory (boost salience, update access time)
  for (const m of combined) {
    touchMemory(m.id)
  }

  // Build memory lines with token budget enforcement
  const memoryLines: string[] = []
  let totalChars = 0

  for (const m of combined) {
    const line = `- ${m.content} (${m.sector})`
    if (totalChars + line.length > MAX_MEMORY_CHARS) break
    memoryLines.push(line)
    totalChars += line.length
  }

  // Skills context (from skills/ folder)
  const skillsCtx = matchSkills(userMessage)

  const parts: string[] = []
  if (memoryLines.length > 0) {
    parts.push(`[Memory context]\n${memoryLines.join('\n')}`)
  }
  if (skillsCtx) {
    parts.push(skillsCtx)
  }

  return parts.join('\n\n')
}

/**
 * Read-only shared memory for agents. Pulls from the owner's main chat memory
 * without touching salience or access times (so agents don't pollute the ranking).
 * Returns a compact context string or empty string if nothing relevant.
 */
export async function buildAgentMemoryContext(mainChatId: string, userMessage: string): Promise<string> {
  const hybridResults = await hybridSearch(mainChatId, userMessage, 4)
  const recentResults = getRecentMemories(mainChatId, 2)

  const seen = new Set<number>()
  const combined: ScoredMemory[] = []
  for (const m of hybridResults) {
    if (!seen.has(m.id)) { seen.add(m.id); combined.push(m) }
  }
  for (const m of recentResults) {
    if (!seen.has(m.id)) { seen.add(m.id); combined.push({ id: m.id, content: m.content, sector: m.sector, score: 0 }) }
  }

  if (combined.length === 0) return ''

  // No touchMemory here — read-only access
  const lines: string[] = []
  let chars = 0
  for (const m of combined) {
    const line = `- ${m.content} (${m.sector})`
    if (chars + line.length > 4000) break
    lines.push(line)
    chars += line.length
  }

  if (lines.length === 0) return ''
  return `[Shared memory — read only]\n${lines.join('\n')}`
}

/**
 * Save a conversation turn to memory, and generate an embedding in the background.
 */
const SKIP_PATTERNS = /^(hey|hi|yo|sup|hello|thanks|ok|yeah|yep|nah|lol|haha|nice|cool|good|sure|bet|word|aight)\b/i

export function saveConversationTurn(chatId: string, userMsg: string, assistantMsg: string): void {
  // Skip short messages, commands, and low-info chatter
  if (userMsg.length <= 40 || userMsg.startsWith('/')) return
  if (SKIP_PATTERNS.test(userMsg.trim())) return

  const sector = SEMANTIC_PATTERN.test(userMsg) ? 'semantic' : 'episodic'

  const content = `User: ${userMsg.slice(0, 200)} → Assistant: ${assistantMsg.slice(0, 200)}`
  insertMemory(chatId, content, sector)

  logger.debug({ chatId, sector }, 'Saved memory')
}

/**
 * Background job: generate embeddings for any memories that don't have one yet.
 * Runs periodically to keep the vector index up to date.
 */
export async function backfillEmbeddings(): Promise<void> {
  const unembedded = getMemoriesWithoutEmbeddings(20)
  if (unembedded.length === 0) return

  logger.info(`Backfilling embeddings for ${unembedded.length} memories`)

  for (const m of unembedded) {
    const embedding = await generateEmbedding(m.content)
    if (embedding) {
      setMemoryEmbedding(m.id, embeddingToBuffer(embedding))
    }
  }
}

export function runDecaySweep(): void {
  decayMemories()
}

/**
 * Session-memory hook (inspired by OpenClaw's session-memory).
 * When a session ends (/newchat), save the most recent conversation turns
 * as a session summary so the bot remembers what it was working on.
 */
/**
 * Build a recent conversation transcript to inject into new sessions.
 * Gives the bot/agent context about where the conversation left off.
 */
export function buildConversationContext(chatId: string, limit = 30, maxChars = 4000): string {
  const rows = getRecentConversations(chatId, limit)
  if (rows.length === 0) return ''

  let transcript = ''
  for (const r of rows) {
    const prefix = r.role === 'user' ? BOT_OWNER : 'You'
    const line = `${prefix}: ${r.content.slice(0, 300)}\n`
    if (transcript.length + line.length > maxChars) break
    transcript += line
  }

  if (!transcript) return ''
  return `[Recent conversation history — use this to get up to speed]\n${transcript.trim()}`
}

export function saveSessionSummary(chatId: string): void {
  const recent = getRecentMemories(chatId, 5)
  if (recent.length === 0) return

  // Build a brief summary from recent episodic memories
  const topics = recent
    .filter(m => m.sector === 'episodic')
    .map(m => m.content.slice(0, 100))
    .slice(0, 3)

  if (topics.length === 0) return

  const summary = `[Session ended ${new Date().toLocaleDateString()}] Topics discussed: ${topics.join(' | ')}`
  insertMemory(chatId, summary, 'episodic', 'session-summary')

  logger.info({ chatId, topics: topics.length }, 'Saved session summary')
}
