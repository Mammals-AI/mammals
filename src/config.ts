import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const env = readEnvFile()

// Paths
export const PROJECT_ROOT = resolve(__dirname, '..')
export const STORE_DIR = resolve(PROJECT_ROOT, 'store')

// Owner
export const BOT_OWNER = env['BOT_OWNER'] ?? 'User'

// Telegram
export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''
export const ALLOWED_GROUP_ID = env['ALLOWED_GROUP_ID'] ?? ''

// Voice
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? ''
export const ELEVENLABS_API_KEY = env['ELEVENLABS_API_KEY'] ?? ''
export const ELEVENLABS_VOICE_ID = env['ELEVENLABS_VOICE_ID'] ?? ''

// Video
export const GOOGLE_API_KEY = env['GOOGLE_API_KEY'] ?? ''

// Ports
export const API_PORT = parseInt(env['API_PORT'] ?? '5062', 10)
export const DASHBOARD_PORT = parseInt(env['DASHBOARD_PORT'] ?? '5075', 10)
export const VOXTRAL_PORT = parseInt(env['VOXTRAL_PORT'] ?? '5090', 10)

// Limits
export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000
