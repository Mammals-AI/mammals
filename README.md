# Mammals

A personal AI agent system that runs on your Mac. Chat through the HQ web dashboard from any device, or use Telegram as a mobile fallback.

Mammals gives you a persistent Claude Code session with multi-agent support, voice I/O, semantic memory, a skill system, and a full command center — all running locally on your machine.

## What You Get

- **Mammals HQ** — Your command center. A full web dashboard for chatting, managing agents, configuring settings, viewing memory, and monitoring everything. Accessible from any device on your network (or anywhere via Tailscale).
- **Multi-agent system** — Spin up specialist agents (auto-named after animals) for parallel tasks
- **Semantic memory** — The bot remembers context across conversations with hybrid search and salience decay
- **Skill system** — Teach it repeatable workflows as markdown files
- **Voice I/O** — Speak to it, hear it respond (Voxtral local TTS or ElevenLabs)
- **Telegram integration** — Optional mobile interface for chatting on the go
- **Scheduled tasks** — Cron-based automation (heartbeat, daily notes, custom jobs)
- **Knowledge graph** — Entities, relations, facts tracked across conversations
- **Remote access** — Access HQ from anywhere via Tailscale

## How You Interact

**Primary: Mammals HQ (web dashboard)**
- Chat with your AI directly from the browser
- Switch between agents, view their work logs and status
- Configure voice, model settings, generation preferences
- Manage memory, skills, and scheduled tasks
- Access from phone, tablet, or laptop via Tailscale

**Secondary: Telegram**
- Chat on the go when you're away from a browser
- Send voice messages for hands-free interaction
- Receive alerts from scheduled tasks and agents
- All the same capabilities as HQ, just in a chat interface

## Requirements

- **macOS** (Apple Silicon or Intel)
- **Node.js 20+**
- **Python 3** (for HQ dashboard)
- **Claude Code CLI** — [Install](https://docs.anthropic.com/en/docs/claude-code/overview)
- **Telegram account** — Free (for mobile access)

## Quick Start

```bash
# Clone the repo
git clone https://github.com/ginovarisano/mammals.git
cd mammals

# Install dependencies
npm install

# Run the setup wizard
npm run setup
```

The setup wizard walks you through everything — no coding required:
1. Checking requirements (Node, Claude CLI, Python, SQLite)
2. Signing into Claude Code
3. Setting your name and identity
4. Creating your Telegram bot via @BotFather
5. Setting up Tailscale for remote access (optional)
6. Configuring voice features (optional)
7. Building, installing as a background service, and starting HQ

## Architecture

For a full technical deep-dive with diagrams, see [ARCHITECTURE.md](ARCHITECTURE.md).

```
mammals/
├── src/                  # TypeScript source (30 modules)
│   ├── index.ts          # Entry point — starts all services
│   ├── bot.ts            # Telegram bot (Grammy)
│   ├── agent.ts          # Claude Code CLI subprocess runner
│   ├── agents.ts         # Multi-agent framework
│   ├── api.ts            # HTTP API server
│   ├── dashboard.ts      # Mission Control + SSE event stream
│   ├── memory.ts         # Hybrid memory (FTS5 + vector search)
│   ├── voice.ts          # STT (Groq Whisper) + TTS (Voxtral/ElevenLabs)
│   ├── scheduler.ts      # Cron job engine
│   ├── skills.ts         # Markdown skill system
│   ├── db.ts             # SQLite persistence (30+ tables)
│   └── ...               # Config, formatting, devices, security, etc.
├── workspace/
│   └── pack-hq/          # Mammals HQ Dashboard (Flask)
│       ├── app.py        # Web server
│       ├── index.html    # Single-page UI
│       └── avatars/      # Agent avatar images (40 animals)
├── scripts/              # Automation + setup
├── skills/               # Skill library (markdown files)
├── store/                # SQLite database (created at runtime)
├── .env.example          # Configuration template
├── CLAUDE.md.dist        # System prompt template
├── ARCHITECTURE.md       # Full technical reference
└── LICENSE               # Personal use license
```

## Services

| Service | Default Port | Description |
|---------|-------------|-------------|
| **Mammals HQ** | 5067 | Primary interface — web dashboard |
| HTTP API | 5062 | Backend REST API |
| Mission Control | 5075 | SSE event stream + data endpoints |
| Telegram Bot | — | Mobile chat interface |
| Voxtral TTS | 5090 | Local text-to-speech (optional) |

All ports configurable via `.env`.

## Agents

Agents are specialist Claude Code sessions with their own identity, memory, and persistent sessions.

Create them from HQ or Telegram:
```
/agent create "Researches topics and summarizes findings"
→ Agent "wolf" created

/agent wolf look into the latest developments in local AI models
→ [wolf] On it.
```

Features:
- Auto-assigned animal code names (40 animals)
- Task queuing with side-replies (agent acknowledges while busy)
- Stuck detection (loop, stall, hang — auto-recovery)
- Work logging and token tracking
- Cross-agent communication
- Persistent sessions across restarts

## Skills

Markdown files that teach the bot repeatable workflows:

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

Drop skill files in `skills/` — automatically loaded and matched by trigger keywords.

## Voice

**Voxtral (local, free)** — Runs on your Mac, 20 voices, configurable temperature/sampling:
```bash
python3 scripts/voxtral_server.py
```

**ElevenLabs (cloud, paid)** — Higher quality, requires API key. Used as fallback.

**Groq Whisper (STT)** — Free tier for voice message transcription.

Configure voice settings directly in HQ under the Technical page.

## Configuration

Copy `.env.example` to `.env` and fill in your values — or just run `npm run setup` and the wizard handles it.

Key variables:
- `BOT_OWNER` — Your name
- `TELEGRAM_BOT_TOKEN` — From @BotFather
- `ALLOWED_CHAT_ID` — Auto-detected on first message

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

Personal Use License — see [LICENSE](LICENSE) for details.
Copyright (c) 2026 Gino Varisano. All rights reserved.
