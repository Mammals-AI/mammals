import { execSync } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const ENV_FILE = resolve(PROJECT_ROOT, '.env')
const CLAUDE_MD = resolve(PROJECT_ROOT, 'CLAUDE.md')
const CLAUDE_MD_DIST = resolve(PROJECT_ROOT, 'CLAUDE.md.dist')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r))

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const ok = (msg: string) => console.log(`${GREEN}  ✓${RESET} ${msg}`)
const warn = (msg: string) => console.log(`${YELLOW}  ⚠${RESET} ${msg}`)
const fail = (msg: string) => console.log(`${RED}  ✗${RESET} ${msg}`)
const info = (msg: string) => console.log(`${DIM}    ${msg}${RESET}`)
const section = (title: string) => console.log(`\n${CYAN}${BOLD}  ── ${title} ──${RESET}\n`)
const step = (n: number, total: number, msg: string) => console.log(`  ${DIM}[${n}/${total}]${RESET} ${msg}`)

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

async function main() {
  console.log(`
${BOLD}  ┌─────────────────────────────────┐
  │       🐾 Mammals v1.0 Setup      │
  │    Personal AI Agent System       │
  └─────────────────────────────────┘${RESET}

  Mammals is a personal AI assistant that lives on your Mac
  and talks to you through Telegram. It can run agents, remember
  things, respond to voice, and automate tasks for you.

  This wizard will walk you through everything. No coding required.
  `)

  await ask('  Press Enter to start...')

  const TOTAL_STEPS = 7

  // ════════════════════════════════════════
  // STEP 1: Check requirements
  // ════════════════════════════════════════
  section('Step 1 of ' + TOTAL_STEPS + ': Checking Your System')

  // Node version
  const nodeVer = process.version
  const major = parseInt(nodeVer.slice(1))
  if (major >= 20) {
    ok(`Node.js ${nodeVer}`)
  } else {
    fail(`Node.js ${nodeVer} — you need version 20 or newer`)
    console.log()
    info('How to install:')
    info('  1. Go to https://nodejs.org')
    info('  2. Download the LTS version')
    info('  3. Run the installer')
    info('  4. Close this terminal, open a new one, and run setup again')
    process.exit(1)
  }

  // Python 3 (needed for HQ dashboard and voice)
  let hasPython = false
  try {
    const pyVer = execSync('python3 --version 2>&1', { encoding: 'utf-8' }).trim()
    ok(pyVer)
    hasPython = true
  } catch {
    warn('Python 3 not found — needed for the web dashboard and voice')
    info('macOS usually has it. Try: xcode-select --install')
  }

  // Flask (needed for HQ dashboard)
  let hasFlask = false
  if (hasPython) {
    try {
      execSync('python3 -c "import flask" 2>&1', { encoding: 'utf-8' })
      ok('Flask (Python web framework)')
      hasFlask = true
    } catch {
      warn('Flask not installed — needed for the web dashboard')
      info('Will install it for you in a moment.')
    }
  }

  // SQLite
  if (commandExists('sqlite3')) {
    ok('SQLite3')
  } else {
    warn('SQLite3 not found — some features need it')
    info('macOS should have it built in. Try: brew install sqlite3')
  }

  // ════════════════════════════════════════
  // STEP 2: Claude Code CLI
  // ════════════════════════════════════════
  section('Step 2 of ' + TOTAL_STEPS + ': Claude Code (Your AI Brain)')

  info('Claude Code is what powers Mammals. It\'s an AI assistant')
  info('made by Anthropic that runs on your computer.')
  console.log()

  let claudeReady = false
  try {
    const claudeVer = execSync('claude --version 2>&1', { encoding: 'utf-8', cwd: PROJECT_ROOT }).trim()
    ok(`Claude Code CLI installed (${claudeVer})`)

    // Check if authenticated
    try {
      execSync('claude --print-system-prompt 2>&1', { encoding: 'utf-8', timeout: 10000 })
      ok('Claude Code is authenticated')
      claudeReady = true
    } catch {
      warn('Claude Code is installed but not logged in')
    }
  } catch {
    fail('Claude Code CLI not found')
    console.log()
    info('You need to install Claude Code first:')
    info('  1. Go to https://docs.anthropic.com/en/docs/claude-code/overview')
    info('  2. Follow the install instructions for your Mac')
    info('  3. Come back and run this setup again')
    console.log()
    const openDocs = await ask('  Want me to open the install page in your browser? [Y/n]: ')
    if (openDocs.toLowerCase() !== 'n') {
      try { execSync('open "https://docs.anthropic.com/en/docs/claude-code/overview"', { stdio: 'ignore' }) } catch {}
    }
    process.exit(1)
  }

  if (!claudeReady) {
    console.log()
    info('You need to sign in to Claude Code. This connects it to your')
    info('Anthropic account (you\'ll need a subscription or API credits).')
    console.log()
    const loginNow = await ask('  Run "claude login" now? [Y/n]: ')
    if (loginNow.toLowerCase() !== 'n') {
      try {
        execSync('claude login', { stdio: 'inherit', cwd: PROJECT_ROOT })
        ok('Claude Code authenticated!')
        claudeReady = true
      } catch {
        fail('Login didn\'t complete — you can run "claude login" later')
      }
    } else {
      warn('Skipping — run "claude login" before starting Mammals')
    }
  }

  // Accept permissions non-interactively
  if (claudeReady) {
    try {
      execSync('claude settings set --global allowedTools \'["*"]\'  2>/dev/null', { encoding: 'utf-8', timeout: 5000 })
    } catch { /* non-critical */ }
  }

  // ════════════════════════════════════════
  // STEP 3: Your identity
  // ════════════════════════════════════════
  section('Step 3 of ' + TOTAL_STEPS + ': About You')

  const config: Record<string, string> = {}

  // Load existing .env if present
  if (existsSync(ENV_FILE)) {
    const existing = readFileSync(ENV_FILE, 'utf-8')
    for (const line of existing.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) {
        config[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
      }
    }
  }

  info('What should your AI call you? This appears in conversations')
  info('and agent prompts.')
  console.log()
  const ownerDefault = config['BOT_OWNER'] || ''
  config['BOT_OWNER'] = await ask(`  Your name: ${ownerDefault ? `[${ownerDefault}] ` : ''}`) || ownerDefault
  if (!config['BOT_OWNER']) {
    fail('A name is required so your agents know who they work for')
    process.exit(1)
  }
  ok(`Got it, ${config['BOT_OWNER']}!`)

  // ════════════════════════════════════════
  // STEP 4: Telegram
  // ════════════════════════════════════════
  section('Step 4 of ' + TOTAL_STEPS + ': Telegram Bot')

  info('Mammals talks to you through a Telegram bot. You\'ll need')
  info('to create one — it takes about 60 seconds:')
  console.log()
  info('  1. Open Telegram on your phone or computer')
  info('  2. Search for @BotFather and start a chat')
  info('  3. Send the message: /newbot')
  info('  4. Pick a name (like "My Mammals Bot")')
  info('  5. Pick a username (like "my_mammals_bot")')
  info('  6. BotFather will give you a token — paste it below')
  console.log()

  const tokenDisplay = config['TELEGRAM_BOT_TOKEN'] ? '***already set***' : ''
  const tokenInput = await ask(`  Paste your bot token here${tokenDisplay ? ` [${tokenDisplay}]` : ''}: `)
  config['TELEGRAM_BOT_TOKEN'] = tokenInput || config['TELEGRAM_BOT_TOKEN'] || ''

  if (!config['TELEGRAM_BOT_TOKEN']) {
    fail('Bot token is required — this is how Mammals communicates with you')
    info('Run this setup again when you have your token from @BotFather')
    process.exit(1)
  }
  ok('Bot token saved')

  console.log()
  info('Your chat ID tells the bot to only respond to YOU.')
  info('If you don\'t know it, leave this blank — the bot will')
  info('auto-detect it when you send your first message.')
  console.log()
  const chatIdDisplay = config['ALLOWED_CHAT_ID'] || ''
  config['ALLOWED_CHAT_ID'] = await ask(`  Your Telegram chat ID [leave blank to auto-detect]: `) || config['ALLOWED_CHAT_ID'] || ''

  if (config['ALLOWED_CHAT_ID']) {
    ok(`Chat ID: ${config['ALLOWED_CHAT_ID']}`)
  } else {
    ok('Will auto-detect on your first message')
  }

  // ════════════════════════════════════════
  // STEP 5: Remote access (Tailscale)
  // ════════════════════════════════════════
  section('Step 5 of ' + TOTAL_STEPS + ': Remote Access (Optional)')

  info('Tailscale lets you access Mammals from anywhere — your phone,')
  info('laptop, or another computer. It\'s free for personal use.')
  info('Without it, the web dashboard only works on this Mac.')
  console.log()

  let hasTailscale = false
  try {
    const tsStatus = execSync('tailscale status --json 2>/dev/null', { encoding: 'utf-8' })
    const ts = JSON.parse(tsStatus)
    if (ts.Self?.TailscaleIPs?.[0]) {
      const tsIp = ts.Self.TailscaleIPs[0]
      ok(`Tailscale is running — your IP: ${tsIp}`)
      config['TAILSCALE_IP'] = tsIp
      hasTailscale = true
    }
  } catch { /* not installed */ }

  if (!hasTailscale) {
    const wantTs = await ask('  Set up Tailscale? [y/N]: ')
    if (wantTs.toLowerCase() === 'y') {
      console.log()
      info('Here\'s how to set up Tailscale:')
      info('  1. Go to https://tailscale.com/download')
      info('  2. Download and install it')
      info('  3. Sign in with Google, Apple, or email')
      info('  4. Run this setup again — it\'ll auto-detect')
      console.log()
      const openTs = await ask('  Open the download page now? [Y/n]: ')
      if (openTs.toLowerCase() !== 'n') {
        try { execSync('open "https://tailscale.com/download"', { stdio: 'ignore' }) } catch {}
      }
      info('You can continue setup now and add Tailscale later.')
    } else {
      ok('Skipping — dashboard will be available on localhost')
    }
  }

  // ════════════════════════════════════════
  // STEP 6: Voice (optional)
  // ════════════════════════════════════════
  section('Step 6 of ' + TOTAL_STEPS + ': Voice (Optional)')

  info('Voice lets you send audio messages to Mammals and hear')
  info('responses read aloud. You can skip this for now.')
  console.log()

  const wantVoice = await ask('  Set up voice features? [y/N]: ')
  if (wantVoice.toLowerCase() === 'y') {
    console.log()
    info('Speech-to-Text: powered by Groq (free tier available)')
    info('  Sign up at: https://console.groq.com')
    info('  Create an API key and paste it below')
    console.log()
    const groqDisplay = config['GROQ_API_KEY'] ? '***already set***' : 'press Enter to skip'
    config['GROQ_API_KEY'] = await ask(`  Groq API key [${groqDisplay}]: `) || config['GROQ_API_KEY'] || ''
    if (config['GROQ_API_KEY']) ok('Groq STT configured')

    console.log()
    info('Text-to-Speech options:')
    info('  voxtral   — Free, runs on your Mac (needs ~4GB RAM)')
    info('  elevenlabs — Cloud-based, high quality ($5/mo for hobby)')
    info('  skip      — No voice responses')
    console.log()
    const ttsChoice = await ask('  TTS engine [voxtral/elevenlabs/skip]: ') || 'skip'
    if (ttsChoice === 'elevenlabs') {
      config['TTS_ENGINE'] = 'elevenlabs'
      info('Sign up at: https://elevenlabs.io')
      const elDisplay = config['ELEVENLABS_API_KEY'] ? '***already set***' : ''
      config['ELEVENLABS_API_KEY'] = await ask(`  ElevenLabs API key${elDisplay ? ` [${elDisplay}]` : ''}: `) || config['ELEVENLABS_API_KEY'] || ''
      config['ELEVENLABS_VOICE_ID'] = await ask(`  Voice ID: `) || config['ELEVENLABS_VOICE_ID'] || ''
      if (config['ELEVENLABS_API_KEY']) ok('ElevenLabs TTS configured')
    } else if (ttsChoice === 'voxtral') {
      config['TTS_ENGINE'] = 'voxtral'
      config['VOXTRAL_VOICE'] = 'casual_male'
      ok('Voxtral selected')
      info('Start the voice server with: python3 scripts/voxtral_server.py')
      info('It will download the model (~2GB) on first run.')
    }
  } else {
    ok('Skipping voice — you can set it up later in .env')
  }

  // ════════════════════════════════════════
  // STEP 7: Build and Install
  // ════════════════════════════════════════
  section('Step 7 of ' + TOTAL_STEPS + ': Building & Installing')

  // Write .env
  const envContent = Object.entries(config)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n'
  writeFileSync(ENV_FILE, envContent)
  ok('Configuration saved to .env')

  // Generate CLAUDE.md from template
  if (existsSync(CLAUDE_MD_DIST)) {
    const template = readFileSync(CLAUDE_MD_DIST, 'utf-8')
    const personalized = template.replace(/\{\{BOT_OWNER\}\}/g, config['BOT_OWNER'])

    if (!existsSync(CLAUDE_MD)) {
      writeFileSync(CLAUDE_MD, personalized)
      ok(`CLAUDE.md created for ${config['BOT_OWNER']}`)
    } else {
      // Don't overwrite without asking
      const overwrite = await ask('  CLAUDE.md already exists. Replace with fresh template? [y/N]: ')
      if (overwrite.toLowerCase() === 'y') {
        writeFileSync(CLAUDE_MD, personalized)
        ok('CLAUDE.md replaced')
      } else {
        ok('Keeping existing CLAUDE.md')
      }
    }
  }

  // Install Flask if needed
  if (hasPython && !hasFlask) {
    console.log()
    info('Installing Flask for the web dashboard...')
    try {
      execSync('python3 -m pip install flask --break-system-packages -q 2>&1', { encoding: 'utf-8' })
      ok('Flask installed')
      hasFlask = true
    } catch {
      try {
        execSync('pip3 install flask -q 2>&1', { encoding: 'utf-8' })
        ok('Flask installed')
        hasFlask = true
      } catch {
        warn('Could not install Flask — dashboard won\'t be available')
        info('Try manually: pip3 install flask')
      }
    }
  }

  // Build TypeScript
  console.log()
  info('Compiling the bot...')
  try {
    execSync('npm run build', { stdio: 'inherit', cwd: PROJECT_ROOT })
    ok('Build successful')
  } catch {
    fail('Build failed — check the errors above')
    info('This usually means a missing dependency. Try: npm install')
    process.exit(1)
  }

  // Install background service
  console.log()
  info('Mammals can run in the background and auto-start when your Mac boots.')
  const installService = await ask('  Install as background service? [Y/n]: ')

  if (installService.toLowerCase() !== 'n') {
    const plistName = 'com.mammals.bot'
    const plistPath = resolve(process.env.HOME ?? '~', 'Library', 'LaunchAgents', `${plistName}.plist`)
    const nodePath = execSync('which node', { encoding: 'utf-8' }).trim()

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${resolve(PROJECT_ROOT, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/mammals.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/mammals.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${dirname(nodePath)}</string>
  </dict>
</dict>
</plist>`

    writeFileSync(plistPath, plist)
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { cwd: PROJECT_ROOT }) } catch {}
    execSync(`launchctl load "${plistPath}"`, { cwd: PROJECT_ROOT })
    ok('Background service installed — Mammals will auto-start on boot')
    info(`Logs: tail -f /tmp/mammals.log`)
  } else {
    ok('Skipping — start manually with: npm start')
  }

  // Start HQ dashboard
  if (hasFlask) {
    console.log()
    info('Starting the web dashboard (Mammals HQ)...')
    const hqDir = resolve(PROJECT_ROOT, 'workspace', 'pack-hq')
    if (existsSync(resolve(hqDir, 'app.py'))) {
      try {
        // Kill any existing HQ process
        try { execSync('/usr/sbin/lsof -ti :5067 | xargs kill 2>/dev/null') } catch {}
        execSync(`cd "${hqDir}" && nohup python3 app.py > /tmp/mammals-hq.log 2>&1 &`, { cwd: hqDir })
        ok('Mammals HQ running on port 5067')
      } catch {
        warn('Could not start HQ dashboard — start manually:')
        info(`cd ${hqDir} && python3 app.py`)
      }
    }
  }

  // ════════════════════════════════════════
  // DONE!
  // ════════════════════════════════════════
  console.log()
  console.log(`${BOLD}  ┌─────────────────────────────────┐`)
  console.log(`  │        🎉 You're all set!        │`)
  console.log(`  └─────────────────────────────────┘${RESET}`)
  console.log()

  ok(`Mammals is running for ${config['BOT_OWNER']}`)
  console.log()

  if (!config['ALLOWED_CHAT_ID']) {
    console.log(`  ${YELLOW}${BOLD}Next:${RESET} Open Telegram and send any message to your bot.`)
    console.log(`       It will auto-lock to your account on the first message.`)
    console.log()
  } else {
    console.log(`  ${CYAN}Try it:${RESET} Send a message to your bot on Telegram!`)
    console.log()
  }

  const dashHost = hasTailscale ? config['TAILSCALE_IP'] : 'localhost'
  if (hasFlask) {
    console.log(`  ${CYAN}Dashboard:${RESET} http://${dashHost}:5067`)
  }
  console.log(`  ${CYAN}Logs:${RESET}      tail -f /tmp/mammals.log`)
  console.log()

  console.log(`  ${DIM}Useful commands:${RESET}`)
  console.log(`    ${DIM}npm start${RESET}     — Run in foreground`)
  console.log(`    ${DIM}npm run setup${RESET} — Re-run this wizard`)
  console.log(`    ${DIM}npm run status${RESET} — Check bot status`)
  console.log()

  rl.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
