# Mammals

A personal AI agent system that runs on your Mac and talks to you through Telegram.

Mammals gives you a persistent Claude Code session with multi-agent support, voice I/O, a web dashboard, semantic memory, and a skill system — all running locally on your machine.

## What You Get

- **Telegram bot** — Chat with Claude from anywhere, hands-free with voice
- **Multi-agent system** — Spin up specialist agents (auto-named after animals) for parallel tasks
- **Semantic memory** — The bot remembers context across conversations
- **Skill system** — Teach it repeatable workflows as markdown files
- **HQ Dashboard** — Web UI for agent management, memory, settings
- **Voice I/O** — Speak to it, hear it respond (Voxtral local TTS or ElevenLabs)
- **Scheduled tasks** — Cron-based automation (heartbeat, daily notes, custom jobs)
- **Knowledge graph** — Entities, relations, facts tracked across conversations
- **Remote access** — Works from anywhere via Tailscale

## Requirements

- **macOS** (Apple Silicon or Intel)
- **Node.js 20+**
- **Claude Code CLI** — [Install](https://docs.anthropic.com/en/docs/claude-code/overview)
- **Telegram account** — Free

## Quick Start

```bash
# Clone the repo
git clone https://github.com/your-username/mammals.git
cd mammals

# Install dependencies
npm install

# Run the setup wizard
npm run setup
```

The setup wizard walks you through:
1. Checking requirements (Node, Claude CLI, SQLite)
2. Creating your Telegram bot via @BotFather
3. Setting up Tailscale for remote access (optional)
4. Configuring voice features (optional)
5. Building and installing as a background service

## Architecture

```
mammals/
├── src/                  # TypeScript source
│   ├── index.ts          # Entry point — starts all services
│   ├── bot.ts            # Telegram bot (Grammy)
│   ├── agent.ts          # Claude Code CLI subprocess runner
│   ├── agents.ts         # Multi-agent framework
│   ├── api.ts            # HTTP API server (port 5062)
│   ├── dashboard.ts      # Mission Control server (port 5075)
│   ├── memory.ts         # Semantic/episodic memory with vector search
│   ├── voice.ts          # STT (Groq Whisper) + TTS (Voxtral/ElevenLabs)
│   ├── scheduler.ts      # Cron job engine
│   ├── skills.ts         # Markdown skill system
│   ├── db.ts             # SQLite persistence (30+ tables)
│   └── ...               # Config, formatting, devices, etc.
├── scripts/              # Core automation scripts
│   ├── setup.ts          # Setup wizard
│   ├── voxtral_server.py # Local TTS server
│   ├── daily-note.py     # Daily planning notes
│   └── ...               # Heartbeat, knowledge graph, etc.
├── skills/               # Skill library (markdown files)
├── store/                # SQLite database + config
├── workspace/
│   └── pack-hq/          # HQ Dashboard (Flask web UI)
├── dist/                 # Compiled JavaScript
├── .env.example          # Configuration template
├── CLAUDE.md.dist        # System prompt template
└── package.json
```

## Services

| Service | Default Port | Description |
|---------|-------------|-------------|
| Telegram Bot | — | Grammy bot, always connected |
| HTTP API | 5062 | REST API for external clients |
| Mission Control | 5075 | Dashboard + SSE event stream |
| HQ Dashboard | 5067 | Flask web UI (workspace/pack-hq) |
| Voxtral TTS | 5090 | Local text-to-speech server |

All ports are configurable via `.env`.

## Agents

Agents are specialist Claude Code sessions with their own system prompts, memory, and persistent sessions.

```
# Create an agent
/agent create "Monitors crypto prices and alerts on big moves"

# It auto-assigns an animal name, e.g. "wolf"
# Send it a task
/agent wolf check BTC price action today

# List agents
/agents list
```

Agents feature:
- Auto-assigned animal code names (40 animals)
- Task queuing (messages queue while agent is busy)
- Stuck detection (loop, stall, hang — auto-recovery)
- Work logging and token tracking
- Cross-agent communication

## Skills

Skills are markdown files that teach the bot repeatable workflows:

```markdown
---
name: deploy-to-cloudflare
triggers: [deploy, cloudflare, publish site]
description: Deploy an Astro site to Cloudflare Pages
---

1. Run `npm run build` in the project directory
2. Run `npx wrangler pages deploy dist/`
3. Verify the deployment URL works
```

Place skill files in `skills/` — they're automatically loaded and matched by trigger keywords.

## Voice

Two TTS options:

**Voxtral (local, free)** — Runs on your Mac, 20 voices, configurable temperature/sampling:
```bash
python3 scripts/voxtral_server.py
```

**ElevenLabs (cloud, paid)** — Higher quality, requires API key.

STT uses Groq's Whisper API (free tier available).

## Configuration

Copy `.env.example` to `.env` and fill in your values. See the file for full documentation of all options.

Key variables:
- `BOT_OWNER` — Your name (used in agent prompts)
- `TELEGRAM_BOT_TOKEN` — From @BotFather
- `ALLOWED_CHAT_ID` — Your Telegram user ID

## Managing the Service

```bash
# View logs
tail -f /tmp/mammals.log

# Restart
launchctl unload ~/Library/LaunchAgents/com.mammals.bot.plist
launchctl load ~/Library/LaunchAgents/com.mammals.bot.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.mammals.bot.plist

# Manual start (foreground)
npm start
```

## License

MIT
