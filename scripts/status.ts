import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
const ok = (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`)
const fail = (msg: string) => console.log(`${RED}✗${RESET} ${msg}`)

console.log('\n  ClaudeClaw Status\n  ─────────────────\n')

// Node version
const major = parseInt(process.version.slice(1))
major >= 20 ? ok(`Node.js ${process.version}`) : fail(`Node.js ${process.version} (need 20+)`)

// Claude CLI
try {
  const ver = execSync('claude --version 2>&1', { encoding: 'utf-8' }).trim()
  ok(`Claude Code ${ver}`)
} catch {
  fail('Claude Code CLI not found')
}

// .env
const envPath = resolve(PROJECT_ROOT, '.env')
if (existsSync(envPath)) {
  const env = readFileSync(envPath, 'utf-8')
  const has = (k: string) => env.includes(`${k}=`) && !env.includes(`${k}=\n`)

  has('TELEGRAM_BOT_TOKEN') ? ok('Telegram bot token configured') : fail('TELEGRAM_BOT_TOKEN missing')
  has('ALLOWED_CHAT_ID') ? ok('Chat ID configured') : fail('ALLOWED_CHAT_ID missing')
  has('GROQ_API_KEY') ? ok('Voice STT (Groq) configured') : fail('GROQ_API_KEY not set')
  has('ELEVENLABS_API_KEY') ? ok('Voice TTS (ElevenLabs) configured') : fail('ELEVENLABS_API_KEY not set')
  has('GOOGLE_API_KEY') ? ok('Video (Gemini) configured') : fail('GOOGLE_API_KEY not set')
} else {
  fail('.env not found — run: npm run setup')
}

// Database
const dbPath = resolve(PROJECT_ROOT, 'store', 'claudeclaw.db')
if (existsSync(dbPath)) {
  ok('Database exists')
} else {
  fail('Database not created yet (starts on first run)')
}

// Service status
try {
  const result = execSync('launchctl list com.claudeclaw.app 2>&1', { encoding: 'utf-8' })
  if (result.includes('PID')) {
    ok('Service running (launchd)')
  } else {
    fail('Service loaded but not running')
  }
} catch {
  fail('Service not installed')
}

// PID file
const pidPath = resolve(PROJECT_ROOT, 'store', 'claudeclaw.pid')
if (existsSync(pidPath)) {
  const pid = readFileSync(pidPath, 'utf-8').trim()
  try {
    process.kill(parseInt(pid), 0)
    ok(`Process running (PID ${pid})`)
  } catch {
    fail(`Stale PID file (${pid} not running)`)
  }
} else {
  fail('No PID file (bot not running)')
}

console.log('')
