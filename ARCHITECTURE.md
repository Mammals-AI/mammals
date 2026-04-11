# Mammals — System Architecture

A complete technical reference for how the Mammals personal AI agent system works.

## System Overview

Mammals is a multi-service system that runs on a single Mac. It connects to Telegram for messaging, spawns Claude Code CLI subprocesses for AI work, maintains persistent memory in SQLite, and serves web dashboards for management.

```
                          +------------------+
                          |   Telegram Cloud  |
                          +--------+---------+
                                   |
                              (polling)
                                   |
+------------------------------+   |   +------------------------------+
|     External Services        |   |   |      Local Services          |
|                              |   |   |                              |
| Groq Whisper (STT)          |   |   | Ollama (embeddings:11434)    |
| ElevenLabs (TTS fallback)   |   |   | Voxtral TTS (:5090)          |
| Claude API (via CLI)        |   |   | Chrome/Puppeteer (browser)   |
+------------------------------+   |   +------------------------------+
                                   |
                    +--------------+--------------+
                    |        MAMMALS BOT          |
                    |       (Node.js process)      |
                    |                              |
                    |  +--------+  +----------+   |
                    |  | Grammy |  | Scheduler |   |
                    |  | Bot    |  | (60s poll)|   |
                    |  +---+----+  +-----+----+   |
                    |      |             |         |
                    |  +---+-------------+----+    |
                    |  |   Message Pipeline    |    |
                    |  |                       |    |
                    |  | Memory  → Agent  →    |    |
                    |  | Context   (Claude CLI)|    |
                    |  |           ↓           |    |
                    |  |         Response      |    |
                    |  +-----------+-----------+    |
                    |              |                |
                    |  +-----------+-----------+    |
                    |  |      SQLite DB        |    |
                    |  | (WAL mode, 20+ tables)|    |
                    |  +-----------------------+    |
                    |                              |
                    |  +----------+ +----------+   |
                    |  | API :5062| | Dash:5075|   |
                    |  +----+-----+ +----+-----+   |
                    +-------|------------|----------+
                            |            |
                    +-------+------------+--------+
                    |       HQ Dashboard          |
                    |     (Flask :5067)            |
                    +-----------------------------+
```

## Services & Ports

| Port | Service | Process | Purpose |
|------|---------|---------|---------|
| — | Telegram Bot | Node.js (main) | Grammy polling, message handling |
| 5062 | HTTP API | Node.js (main) | REST endpoints for HQ and external clients |
| 5075 | Dashboard | Node.js (main) | Mission Control UI + SSE event stream |
| 5067 | Mammals HQ | Python (Flask) | Web dashboard for agent management |
| 5090 | Voxtral TTS | Python | Local text-to-speech server |
| 11434 | Ollama | External | Local embedding generation |

All configurable via `.env` (`API_PORT`, `DASHBOARD_PORT`, `VOXTRAL_PORT`).

## Startup Sequence

The bot initializes in a specific order — each stage depends on the previous one:

```
1.  Delete CLAUDECODE env var (prevents subprocess conflicts)
2.  Acquire PID lock (kills stale instance if needed)
3.  Initialize SQLite database (create tables, WAL mode)
4.  Load skills from skills/ directory
5.  Initialize webhook tables
6.  Initialize device pairing tables
7.  Create daily backup + schedule 24h repeating
8.  Run memory salience decay + schedule 24h repeating
9.  Start embedding backfill loop (every 10 min)
10. Clean old media uploads
11. Create Grammy Telegram bot
12. Create sender functions (regular + topic)
13. Find/create System Log topic in Telegram
14. Start cron scheduler (60s polling)
15. Start heartbeat check-in loop
16. Initialize agent system (set sender callback)
17. Recover orphaned agent tasks (from last crash)
18. Start HTTP API server (:5062)
19. Start Dashboard server (:5075)
20. Clean old device captures + schedule daily
21. Register SIGINT/SIGTERM/SIGHUP handlers
22. Start Telegram polling (drop pending updates)
```

## Message Flow

What happens when you send a message through Telegram:

```
You send "Check my disk space"
         |
         v
+------------------+
| Grammy receives  |
| message via poll |
+--------+---------+
         |
         v
+------------------+
| isAuthorised()?  |----NO----> "Unauthorized."
| Check chat ID    |
+--------+---------+
         | YES
         v
+------------------+     +-------------------+
| First message?   |---->| Auto-claim owner  |
| (no chat ID set) | YES | Save ID to .env   |
+--------+---------+     | Welcome message   |
         | NO             +-------------------+
         v
+------------------+
| Get session      |  Lookup stored Claude Code session ID
| from database    |  for this chat
+--------+---------+
         |
    +----+----+
    |         |
  NEW      EXISTING
 SESSION   SESSION
    |         |
    v         |
+------------------+     |
| Build context:   |     |
| - Recent history |     |
|   (30 turns)     |     |
| - Memory search  |     |
|   (hybrid FTS5 + |     |
|    vector, top 5) |     |
| - Matched skills |     |
+--------+---------+     |
         |               |
         +-------+-------+
                 |
                 v
+------------------+
| Start typing     |  Refresh every 4 seconds
| indicator        |  to prevent "not responding"
+--------+---------+
         |
         v
+------------------+
| Spawn Claude CLI |  claude -p "message"
| subprocess       |  --output-format stream-json
|                  |  --model opus --effort high
|                  |  --resume <sessionId>
+--------+---------+
         |
    (streaming output)
         |
    +----+----+
    |    |    |
  Tool  Text  Usage
  calls  ↓   tokens
    |    |    |
    v    |    v
+------------------+
| Monitor for:     |
| - Loops (8x same |
|   tool+args)     |
| - Stalls (10min  |
|   silence)       |
| - Hangs (30min)  |
+--------+---------+
         |
         v
+------------------+
| Parse result     |
| Get session ID   |
| Get token counts |
+--------+---------+
         |
         v
+------------------+
| Save to memory   |  Skip if <40 chars or low-info
| Auto-detect:     |  ("hey", "thanks", "ok", etc.)
| semantic vs      |
| episodic         |
+--------+---------+
         |
    +----+----+
    |         |
  TEXT      VOICE
  MODE      MODE
    |         |
    v         v
+----------+ +-------------+
| Format   | | Synthesize  |
| HTML     | | speech via  |
| Split at | | Voxtral or  |
| 4096 ch  | | ElevenLabs  |
+----------+ +-------------+
    |              |
    +------+-------+
           |
           v
     Send response
     to Telegram
```

## Agent System

Agents are specialist Claude Code sessions with their own identity, memory, and persistent state.

### Agent Lifecycle

```
                    CREATE
                      |
                      v
            +-------------------+
            |   agents table    |
            | name, description |
            | system_prompt     |
            | session_id (null) |
            +--------+----------+
                     |
              RECEIVE TASK
                     |
               +-----+-----+
               |           |
             IDLE        BUSY
               |           |
               v           v
        +----------+  +-----------+
        | Execute  |  | Is this a |
        | task     |  | new task? |
        +----+-----+  +-----+-----+
             |           |       |
             |         YES      NO
             |           |       |
             |           v       v
             |    +--------+ +----------+
             |    | Queue  | | Side-    |
             |    | it     | | reply    |
             |    +--------+ | (quick)  |
             |               +----------+
             v
  +---------------------+
  | Build agent context  |
  | - Owner's memories   |
  |   (read-only, no     |
  |    salience boost)   |
  | - Recent chat history|
  | - Agent base rules   |
  +----------+-----------+
             |
             v
  +---------------------+
  | Run Claude CLI       |
  | with stall detection |
  +----------+-----------+
             |
        +----+----+
        |         |
     STALLED    NORMAL
   (10min)    COMPLETION
        |         |
        v         |
  +----------+    |
  | Kill &   |    |
  | resume   |    |
  | session  |    |
  +----+-----+    |
       |          |
       +----+-----+
            |
            v
  +---------------------+
  | Log results          |
  | - Work log entry     |
  | - Token stats update |
  | - Session report     |
  +----------+-----------+
             |
             v
  +---------------------+
  | Check queue          |
  | Next task waiting?   |
  +----------+-----------+
        |         |
       YES        NO
        |         |
        v         v
   Execute      Mark
   next task    IDLE
```

### Agent Communication

```
+--------+         +--------+
| Wolf   |         | Crow   |
| Agent  |         | Agent  |
+---+----+         +----+---+
    |                    |
    | agentToAgent()     |
    +------------------->|
    |                    |
    |   (runs task,      |
    |    returns result) |
    |                    |
    |<-------------------+
    |   response         |
    |                    |
```

Tracked in `agent_messages` table with from_agent, to_agent, message, response.

## Memory System

Hybrid search combining keyword matching (SQLite FTS5) with vector similarity (Ollama embeddings).

### Memory Architecture

```
+---------------------------------------------------+
|                  MEMORY STORE                      |
|                                                    |
|  +--------------------+  +--------------------+   |
|  |    SEMANTIC         |  |    EPISODIC        |   |
|  |                     |  |                    |   |
|  | "I prefer dark mode"|  | "Yesterday we      |   |
|  | "Always use Astro"  |  |  deployed the site"|   |
|  | "My name is User"   |  | "Fixed the CSS bug"|   |
|  +--------------------+  +--------------------+   |
|                                                    |
|  Each memory has:                                  |
|  - content (text)                                  |
|  - sector (semantic | episodic)                    |
|  - salience (0.0 - 1.0, decays over time)         |
|  - embedding (vector, BLOB)                        |
|  - created_at, accessed_at                         |
+---------------------------------------------------+
```

### Hybrid Search

```
User message: "How do I deploy?"
                |
        +-------+-------+
        |               |
        v               v
+---------------+ +------------------+
| FTS5 Keyword  | | Vector Similarity|
| Search        | | Search           |
|               | |                  |
| SQL MATCH on  | | Embed query via  |
| memories_fts  | | Ollama           |
|               | | cosine_sim vs    |
| Score: 0-1    | | all memory       |
| (rank-based)  | | embeddings       |
|               | |                  |
| Weight: 0.4   | | Weight: 0.6      |
+-------+-------+ +--------+---------+
        |                   |
        +--------+----------+
                 |
                 v
     +----------------------+
     | Weighted Merge        |
     | score = 0.6*vec +     |
     |         0.4*fts       |
     +----------+-----------+
                |
                v
     +----------------------+
     | MMR Re-ranking        |
     | (diversity filter)    |
     |                       |
     | Lambda: 0.7           |
     | (favor relevance      |
     |  over diversity)      |
     +----------+-----------+
                |
                v
         Top 5 memories
         (+ 3 most recent)
         
         Budget: 8000 chars
         (~2000 tokens)
```

### Salience Decay

```
Salience
  1.0 |*
      | *
  0.8 |  *
      |   *
  0.6 |    **
      |      **
  0.4 |        ***
      |           ****
  0.2 |               *******
      |                      **************
  0.0 +----+----+----+----+----+----+----+---> Days
       0    7   14   21   28   35   42   49

Half-life: 14 days
Each access: +10% salience boost
Decay runs: daily
```

Memories that get accessed regularly maintain high salience. Unused memories fade exponentially. This mimics how human memory works — important things stay sharp, irrelevant things fade.

## Voice Pipeline

```
+------------------+
| Telegram sends   |
| voice message    |
| (.oga file)      |
+--------+---------+
         |
         v
+------------------+
| Download file    |
| Rename .oga→.ogg |
+--------+---------+
         |
         v
+------------------+     +-----------------+
| Groq Whisper API |---->| "Check my disk  |
| (whisper-large-  |     |  space please"  |
|  v3)             |     +-----------------+
+------------------+            |
                                v
                    +---------------------+
                    | Talk Mode batching?  |
                    | (3s silence window)  |
                    +----------+----------+
                         |          |
                      SINGLE    BATCH
                      message   (combine
                         |       multiple)
                         v          |
                    +-----------+   |
                    | Process   |<--+
                    | as text   |
                    | message   |
                    +-----+-----+
                          |
                    (normal message flow)
                          |
                          v
                    +-----------+
                    | Response  |
                    | text      |
                    +-----+-----+
                          |
                    +-----+-----+
                    |           |
                 VOICE       TEXT
                 MODE ON     MODE
                    |           |
                    v           v
            +------------+  (send as
            | TTS Engine |   text)
            +------+-----+
                   |
            +------+------+
            |             |
         VOXTRAL     ELEVENLABS
        (local)      (cloud)
            |             |
            v             v
       +---------+  +---------+
       | WAV     |  | MP3     |
       | audio   |  | audio   |
       +---------+  +---------+
            |             |
            +------+------+
                   |
                   v
           Send voice note
           to Telegram
```

## Scheduler & Heartbeat

### Cron Task Execution

```
Every 60 seconds:
         |
         v
+------------------+
| Query due tasks  |
| WHERE status =   |
| 'active' AND     |
| next_run <= now  |
+--------+---------+
         |
         v
  For each task (concurrent):
         |
    +----+----+
    |         |
  NORMAL   [HEAVY]
    |      tagged
    |         |
    |    Peak hours?
    |    (8am-2pm ET)
    |      |      |
    |    YES     NO
    |      |      |
    |   DEFER     |
    |   (skip)    |
    |             |
    +------+------+
           |
           v
    +-------------+
    | Run agent   |
    | (sonnet,    |
    |  low effort)|
    +------+------+
           |
      +----+----+
      |         |
   QUIET     ALERT
   result    result
      |         |
      v         v
   (skip     Send to
    log)     system log
             topic
           |
           v
    +-------------+
    | Compute     |
    | next_run    |
    | from cron   |
    | expression  |
    +-------------+
```

### Heartbeat

```
+------------------+
| Timer fires      |
| (default: 30min) |
+--------+---------+
         |
    +----+----+
    |         |
 ENABLED?  DISABLED
    |         → stop
    |
 IN ACTIVE
 HOURS?
 (9am-10pm)
    |      |
   YES    NO
    |      → skip
    v
+------------------+
| Read HEARTBEAT.md|
| Build prompt     |
+--------+---------+
         |
         v
+------------------+
| Run agent        |
| (haiku, low)     |
+--------+---------+
         |
    +----+----+
    |         |
 HEARTBEAT  ALERT
   _OK      (issue
    |        found)
    v         |
  (silent)    v
           Send to
           owner
```

## Skills System

```
~/claudeclaw/skills/
├── examples/
│   ├── system-check.md
│   ├── summarize-file.md
│   └── web-research.md
├── agent-comms.md
└── focus-board.md

Each skill file:
+---------------------------+
| ---                       |
| name: system-check        |
| triggers: health, status  |
| description: Run check    |
| ---                       |
|                           |
| Body text that gets       |
| injected as context when  |
| trigger words match the   |
| user's message.           |
+---------------------------+

Message: "run a health check"
              |
              v
     +------------------+
     | Match triggers    |
     | "health" matches  |
     | system-check.md   |
     +--------+---------+
              |
              v
     +------------------+
     | Inject body into  |
     | memory context    |
     | [Skill: system-   |
     |  check]           |
     | {body text}       |
     +------------------+
```

## Security Model

```
+--------------------------------------------------+
|                SECURITY LAYERS                     |
+--------------------------------------------------+

LAYER 1: Telegram Auth
+------------------+
| ALLOWED_CHAT_ID  |  Only your Telegram account
| First message    |  can talk to the bot.
| auto-claims      |  Auto-saves on first contact.
+------------------+

LAYER 2: API Auth
+------------------+
| Bearer token     |  Optional API authentication
| (CLAUDECLAW_     |  for HTTP endpoints.
|  API_TOKEN)      |  Skipped for /api/status.
+------------------+

LAYER 3: Device Pairing
+------------------+
| Short-lived code |  1. Owner runs /pair in Telegram
| (5 min TTL)      |  2. Get 6-char hex code
|        ↓         |  3. Device sends code to API
| Long-lived token |  4. Gets 30-day session token
| (30 day TTL)     |  5. Each device revocable
+------------------+

LAYER 4: Elevated Mode
+------------------+
| OFF (default):   |  Destructive commands require
|   rm -rf → ask   |  user confirmation.
|   DROP TABLE →   |
|   ask            |
| ON:              |  Skip confirmation for
|   execute all    |  dangerous commands.
|                  |
| ALWAYS ASK:      |  Financial actions (buy, sell,
|   buy/sell/trade |  trade) ALWAYS need approval.
+------------------+

LAYER 5: Data Locality
+------------------+
| All data stays   |  SQLite database, memories,
| on your machine  |  conversations — nothing
| in SQLite        |  leaves your Mac.
+------------------+
```

## Database Schema

30+ tables in SQLite with WAL mode for concurrent access.

### Core Tables

```
sessions
├── chat_id (PK)
├── session_id         → Claude Code session
└── updated_at

memories
├── id (PK)
├── chat_id
├── content            → The memory text
├── sector             → semantic | episodic
├── salience           → 0.0-1.0 (decays daily)
├── embedding (BLOB)   → Vector for similarity search
├── created_at
└── accessed_at

memories_fts (FTS5)    → Full-text index, synced via triggers

agents
├── name (PK)
├── description
├── system_prompt
├── session_id         → Persistent Claude session
├── topic_id           → Telegram thread ID
├── total_tokens_in
├── total_tokens_out
├── total_runs
├── last_active
└── created_at

agent_work_log
├── id (PK)
├── agent_name
├── task
├── status             → running | completed | failed | hung | loop
├── result
├── tokens_in/out
├── duration_ms
└── created_at

scheduled_tasks
├── id (PK)
├── chat_id
├── prompt             → What to run
├── schedule           → Cron expression
├── next_run           → Unix timestamp
├── last_run
├── last_result
└── status             → active | paused

conversations
├── id (PK)
├── chat_id
├── role               → user | assistant
├── content
├── source             → telegram | dashboard | agent:name | claude-raw
└── created_at
```

### Supporting Tables

```
packlog_posts          → Agent work journals
agent_sessions         → Agent session summaries with problems/solutions
agent_messages         → Cross-agent communication log
agent_skills           → Skills per agent with confidence scores
pending_agent_tasks    → In-flight tasks (crash recovery)
pairing_codes          → Short-lived device auth codes
device_sessions        → Active device tokens
webhooks               → External webhook definitions
bot_config             → Key-value settings store
skills                 → Skill metadata + FTS index
kg_entities            → Knowledge graph nodes
kg_relations           → Knowledge graph edges
goals                  → High-level goals
initiatives            → Sub-goals with tracking
```

## Key Numbers

| Parameter | Value | Notes |
|-----------|-------|-------|
| Typing refresh | 4s | Prevents Telegram timeout |
| Stall detection | 10 min | Nudge (kill + resume) |
| Hang timeout | 30 min | Hard kill |
| Loop threshold | 8 calls | Same tool+args |
| Scheduler poll | 60s | Check for due tasks |
| Memory half-life | 14 days | Salience decay |
| Access boost | +10% | Per memory touch |
| Memory budget | 8,000 chars | ~2,000 tokens per message |
| Vector weight | 0.6 | vs 0.4 FTS keyword |
| MMR lambda | 0.7 | Relevance vs diversity |
| History window | 30 turns | Session warm-up |
| Pairing code TTL | 5 min | Device auth |
| Session token TTL | 30 days | Device auth |
| Heartbeat interval | 30 min | Default |
| Active hours | 9am-10pm | Heartbeat window |
| Voice batch silence | 3s | Talk mode timeout |
| Max skill body | 4,000 chars | Skill content limit |

## File Structure

```
mammals/
├── src/                     # TypeScript source (30 modules)
│   ├── index.ts             # Entry point, startup orchestration
│   ├── bot.ts               # Telegram bot (Grammy), message handling
│   ├── agent.ts             # Claude CLI subprocess runner
│   ├── agents.ts            # Multi-agent framework + queue + side-replies
│   ├── api.ts               # HTTP REST API (:5062)
│   ├── dashboard.ts         # Dashboard + SSE (:5075)
│   ├── db.ts                # SQLite persistence (30+ tables)
│   ├── memory.ts            # Hybrid search, salience decay, MMR
│   ├── embeddings.ts        # Ollama vector embeddings
│   ├── voice.ts             # STT (Groq) + TTS (Voxtral/ElevenLabs)
│   ├── talk-mode.ts         # Voice message batching
│   ├── scheduler.ts         # Cron job engine
│   ├── heartbeat.ts         # Proactive check-ins
│   ├── skills.ts            # Markdown skill loader + matcher
│   ├── config.ts            # Environment config (owner, ports, keys)
│   ├── format.ts            # Telegram HTML formatting
│   ├── media.ts             # File downloads + message builders
│   ├── devices.ts           # macOS integration (screenshot, notify)
│   ├── pairing.ts           # Device authentication tokens
│   ├── elevated.ts          # Safety mode toggle
│   ├── routing.ts           # Auto-detect Chrome needs, model selection
│   ├── model-config.ts      # Model/effort settings
│   ├── backup.ts            # Database + config backup
│   ├── webhooks.ts          # Webhook management + HMAC verification
│   ├── env.ts               # .env file parser
│   ├── logger.ts            # Pino structured logging
│   ├── display.ts           # Activity visualization callbacks
│   ├── agent-cli.ts         # CLI for agent management
│   └── schedule-cli.ts      # CLI for task management
│
├── scripts/                 # Automation scripts
│   ├── setup.ts             # Interactive setup wizard
│   ├── voxtral_server.py    # Local TTS server (20 voices)
│   ├── daily-note.py        # Daily planning notes
│   ├── nightly-run.py       # Nightly consolidation pipeline
│   ├── heartbeat.py         # Standalone heartbeat check
│   ├── proactive.py         # Trigger-based intelligence
│   ├── knowledge-graph.py   # Knowledge graph management
│   └── ...                  # Dream phases, error review, etc.
│
├── skills/                  # Skill library
│   ├── examples/            # Starter skills for new users
│   └── *.md                 # Custom skill files
│
├── workspace/
│   └── pack-hq/             # Mammals HQ web dashboard
│       ├── app.py           # Flask server (:5067)
│       ├── index.html       # Single-page web UI
│       └── avatars/         # Agent avatar images
│
├── store/                   # Runtime data (gitignored)
│   └── claudeclaw.db        # SQLite database
│
├── .env.example             # Configuration template
├── CLAUDE.md.dist           # System prompt template
├── README.md                # User guide
├── ARCHITECTURE.md          # This document
├── package.json             # Node.js project config
└── tsconfig.json            # TypeScript config
```
