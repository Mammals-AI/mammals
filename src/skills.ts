/**
 * Lightweight skills system — markdown files in ~/claudeclaw/skills/
 * that inject context when a message matches their trigger patterns.
 *
 * Each skill file is structured like:
 *
 * ---
 * name: deploy-site
 * triggers: deploy, publish, cloudflare, vercel
 * description: How to deploy web projects
 * ---
 * [Body text is injected as context when triggered]
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

const SKILLS_DIR = resolve(PROJECT_ROOT, 'skills')

interface Skill {
  name: string
  triggers: string[]
  description: string
  body: string
  createdBy?: string
  category?: string
  version?: string
}

let loadedSkills: Skill[] = []

/**
 * Parse a skill markdown file. Frontmatter delimited by --- lines.
 */
function parseSkillFile(filePath: string): Skill | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parts = raw.split(/^---\s*$/m)
    if (parts.length < 3) {
      logger.warn({ filePath }, 'Skill file missing frontmatter delimiters (---)')
      return null
    }

    const frontmatter = parts[1]
    const body = parts.slice(2).join('---').trim()

    const meta: Record<string, string> = {}
    for (const line of frontmatter.split('\n')) {
      const match = line.match(/^(\w+)\s*:\s*(.+)$/)
      if (match) {
        meta[match[1].toLowerCase()] = match[2].trim()
      }
    }

    if (!meta.name || !meta.triggers) {
      logger.warn({ filePath }, 'Skill missing required name or triggers')
      return null
    }

    return {
      name: meta.name,
      triggers: meta.triggers.split(',').map(t => t.trim().toLowerCase()),
      description: meta.description ?? '',
      body,
      createdBy: meta.created_by,
      category: meta.category ?? 'general',
      version: meta.version ?? '1.0',
    }
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse skill file')
    return null
  }
}

/**
 * Load all skills from the skills/ directory.
 * Call on startup and whenever skills change.
 */
export function loadSkills(): void {
  try {
    loadedSkills = []
    // Load .md files from skills/ and all subdirectories
    const scanDir = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          scanDir(resolve(dir, entry.name))
        } else if (entry.name.endsWith('.md')) {
          const skill = parseSkillFile(resolve(dir, entry.name))
          if (skill) loadedSkills.push(skill)
        }
      }
    }
    scanDir(SKILLS_DIR)
    logger.info(`Loaded ${loadedSkills.length} skills from ${SKILLS_DIR}`)
  } catch {
    // skills/ directory doesn't exist yet — that's fine
    loadedSkills = []
    logger.debug('No skills directory found')
  }
}

/**
 * Find skills that match the user's message.
 * Returns all matching skill bodies joined together.
 */
export function matchSkills(message: string): string {
  const msgLower = message.toLowerCase()
  const matched: Skill[] = []

  for (const skill of loadedSkills) {
    if (skill.triggers.some(trigger => msgLower.includes(trigger))) {
      matched.push(skill)
    }
  }

  if (matched.length === 0) return ''

  const sections = matched.map(s => `[Skill: ${s.name}]\n${s.body}`)
  return sections.join('\n\n')
}

/**
 * Get the list of loaded skills (for /skills command).
 */
export function getLoadedSkills(): Array<{ name: string; description: string; triggers: string[]; createdBy?: string; category?: string; version?: string }> {
  return loadedSkills.map(s => ({
    name: s.name,
    description: s.description,
    triggers: s.triggers,
    createdBy: s.createdBy,
    category: s.category,
    version: s.version,
  }))
}

/**
 * Get skills grouped by category.
 */
export function getSkillsByCategory(): Record<string, typeof loadedSkills> {
  const grouped: Record<string, Skill[]> = {}
  for (const skill of loadedSkills) {
    const cat = skill.category ?? 'general'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(skill)
  }
  return grouped
}

// --- Skill management (agents can create/delete skills) ---

const MAX_SKILLS = 20
const MAX_SKILL_BODY_CHARS = 4000

// Words too common to be useful triggers — would fire on almost every message
const BANNED_TRIGGERS = new Set([
  'the', 'a', 'an', 'is', 'it', 'to', 'do', 'go', 'i', 'me', 'my', 'we', 'he', 'she',
  'and', 'or', 'but', 'if', 'in', 'on', 'at', 'for', 'of', 'up', 'no', 'yes',
  'what', 'how', 'why', 'when', 'where', 'who', 'that', 'this', 'can', 'will',
  'check', 'get', 'set', 'run', 'make', 'help', 'show', 'tell', 'look', 'see',
  'ok', 'hey', 'hi', 'hello', 'thanks', 'please', 'just', 'like', 'know',
  'data', 'file', 'thing', 'stuff', 'work', 'need', 'want', 'use', 'try',
])

interface CreateSkillResult {
  ok: boolean
  error?: string
}

/**
 * Create a new skill file. Validates triggers and enforces limits.
 */
export function createSkill(
  name: string,
  description: string,
  triggers: string[],
  body: string,
  createdBy?: string,
): CreateSkillResult {
  // Validate name — alphanumeric + hyphens only
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { ok: false, error: 'Skill name must be lowercase alphanumeric with hyphens only (e.g. "solar-tips").' }
  }

  // Check skill cap
  if (loadedSkills.length >= MAX_SKILLS) {
    return { ok: false, error: `Max ${MAX_SKILLS} skills reached. Delete one first.` }
  }

  // Check for duplicate name
  if (loadedSkills.some(s => s.name === name)) {
    return { ok: false, error: `Skill "${name}" already exists. Delete it first or pick a different name.` }
  }

  // Validate triggers
  const cleanTriggers = triggers.map(t => t.trim().toLowerCase()).filter(Boolean)
  if (cleanTriggers.length < 2) {
    return { ok: false, error: 'Need at least 2 trigger words to avoid false matches.' }
  }

  const banned = cleanTriggers.filter(t => BANNED_TRIGGERS.has(t))
  if (banned.length > 0) {
    return { ok: false, error: `These triggers are too generic and would fire on everything: ${banned.join(', ')}` }
  }

  // Also reject single-character triggers
  const tooShort = cleanTriggers.filter(t => t.length < 3)
  if (tooShort.length > 0) {
    return { ok: false, error: `Triggers must be at least 3 characters: ${tooShort.join(', ')}` }
  }

  // Validate body length
  if (body.length > MAX_SKILL_BODY_CHARS) {
    return { ok: false, error: `Skill body too long (${body.length} chars). Max is ${MAX_SKILL_BODY_CHARS}.` }
  }

  if (!body.trim()) {
    return { ok: false, error: 'Skill body cannot be empty.' }
  }

  // Ensure skills/ directory exists
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true })
  }

  // Build the markdown file
  const lines = [
    '---',
    `name: ${name}`,
    `triggers: ${cleanTriggers.join(', ')}`,
    `description: ${description || name}`,
  ]
  if (createdBy) {
    lines.push(`created_by: ${createdBy}`)
  }
  lines.push('---', body)

  const filePath = resolve(SKILLS_DIR, `${name}.md`)
  writeFileSync(filePath, lines.join('\n'), 'utf-8')

  // Reload skills so it's immediately active
  loadSkills()

  logger.info({ name, triggers: cleanTriggers, createdBy }, 'Skill created')
  return { ok: true }
}

/**
 * Delete a skill by name.
 */
export function deleteSkill(name: string): CreateSkillResult {
  const filePath = resolve(SKILLS_DIR, `${name}.md`)
  if (!existsSync(filePath)) {
    return { ok: false, error: `Skill "${name}" not found.` }
  }

  unlinkSync(filePath)
  loadSkills()

  logger.info({ name }, 'Skill deleted')
  return { ok: true }
}

// --- Import/Export (for Daemon Kit sharing) ---

/**
 * Export a skill to a portable JSON format.
 */
export function exportSkill(name: string): { ok: boolean; data?: object; error?: string } {
  const skill = loadedSkills.find(s => s.name === name)
  if (!skill) return { ok: false, error: `Skill "${name}" not found.` }

  return {
    ok: true,
    data: {
      format: 'claudeclaw-skill-v1',
      name: skill.name,
      description: skill.description,
      triggers: skill.triggers,
      category: skill.category ?? 'general',
      version: skill.version ?? '1.0',
      createdBy: skill.createdBy,
      body: skill.body,
    },
  }
}

/**
 * Export all skills as a single bundle.
 */
export function exportAllSkills(): object {
  return {
    format: 'claudeclaw-skills-bundle-v1',
    exported_at: new Date().toISOString(),
    skills: loadedSkills.map(s => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      category: s.category ?? 'general',
      version: s.version ?? '1.0',
      createdBy: s.createdBy,
      body: s.body,
    })),
  }
}

/**
 * Import a skill from the portable JSON format.
 */
export function importSkill(data: Record<string, unknown>): CreateSkillResult {
  if (data.format !== 'claudeclaw-skill-v1') {
    return { ok: false, error: 'Invalid skill format. Expected claudeclaw-skill-v1.' }
  }

  const name = data.name as string
  const description = (data.description as string) || name
  const triggers = data.triggers as string[]
  const body = data.body as string
  const createdBy = data.createdBy as string | undefined

  if (!name || !triggers || !body) {
    return { ok: false, error: 'Missing required fields: name, triggers, body.' }
  }

  return createSkill(name, description, triggers, body, createdBy)
}

/**
 * Import a skill from an OpenClaw SKILL.md string.
 * Translates OpenClaw frontmatter (name, description, metadata) to our format.
 * Auto-generates triggers from the skill name and description since OpenClaw doesn't have them.
 */
export function importFromOpenClaw(rawMarkdown: string, sourceUrl?: string): CreateSkillResult {
  const parts = rawMarkdown.split(/^---\s*$/m)
  if (parts.length < 3) {
    return { ok: false, error: 'Invalid SKILL.md — missing frontmatter delimiters.' }
  }

  const frontmatter = parts[1]
  const body = parts.slice(2).join('---').trim()

  const meta: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/)
    if (match) meta[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '')
  }

  const name = meta.name?.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  if (!name) return { ok: false, error: 'SKILL.md missing name field.' }
  if (!body) return { ok: false, error: 'SKILL.md has empty body.' }

  const description = meta.description || name

  // Auto-generate triggers from skill name words + key description words
  const nameWords = name.split('-').filter(w => w.length >= 3)
  const descWords = description.toLowerCase()
    .split(/\W+/)
    .filter(w => w.length >= 4 && !BANNED_TRIGGERS.has(w))
    .slice(0, 4)

  const triggers = [...new Set([...nameWords, ...descWords])].slice(0, 8)
  if (triggers.length < 2) {
    return { ok: false, error: `Could not generate enough triggers from skill name "${name}". Add them manually.` }
  }

  return createSkill(name, description, triggers, body, sourceUrl ? `openclaw:${sourceUrl}` : 'openclaw')
}

/**
 * Fetch and import a skill from a GitHub raw URL or openclaw/clawhub slug.
 * Slug format: "skill-name" → fetches from openclaw/clawhub on GitHub.
 */
export async function importFromOpenClawUrl(urlOrSlug: string): Promise<CreateSkillResult> {
  let url = urlOrSlug

  // Convert slug to raw GitHub URL
  if (!url.startsWith('http')) {
    const slug = url.replace(/^@?openclaw\//, '')
    url = `https://raw.githubusercontent.com/openclaw/clawhub/main/skills/${slug}/SKILL.md`
  }

  // Convert github.com URLs to raw
  url = url
    .replace('github.com', 'raw.githubusercontent.com')
    .replace('/blob/', '/')

  try {
    const { default: https } = await import('https')
    const { default: http } = await import('http')

    const raw = await new Promise<string>((resolve, reject) => {
      const proto = url.startsWith('https') ? https : http
      proto.get(url, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return importFromOpenClawUrl(res.headers.location!).then(r => resolve(r.ok ? 'ok' : '')).catch(reject)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
        }
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })

    if (raw === 'ok') return { ok: true } // handled by redirect
    return importFromOpenClaw(raw, url)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to fetch skill: ${msg}` }
  }
}

/**
 * Import a skills bundle.
 */
export function importSkillBundle(data: Record<string, unknown>): { imported: number; errors: string[] } {
  if (data.format !== 'claudeclaw-skills-bundle-v1') {
    return { imported: 0, errors: ['Invalid bundle format. Expected claudeclaw-skills-bundle-v1.'] }
  }

  const skills = data.skills as Array<Record<string, unknown>>
  if (!Array.isArray(skills)) {
    return { imported: 0, errors: ['Bundle missing skills array.'] }
  }

  let imported = 0
  const errors: string[] = []

  for (const skill of skills) {
    const result = importSkill({ ...skill, format: 'claudeclaw-skill-v1' })
    if (result.ok) {
      imported++
    } else {
      errors.push(`${skill.name}: ${result.error}`)
    }
  }

  return { imported, errors }
}
