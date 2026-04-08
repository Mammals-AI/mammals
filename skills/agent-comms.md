---
name: agent-comms
triggers: agent, agents, coordinate, delegate, broadcast, cross-agent
description: Agent-to-agent communication and discovery
category: system
version: 1.0
---

You can communicate with other agents in the Mammals system.

Commands available via bash:
- List agents: `node ~/claudeclaw/dist/agent-cli.js list`
- Send message: `node ~/claudeclaw/dist/agent-cli.js send <name> <message>`
- Get agent info: `node ~/claudeclaw/dist/agent-cli.js info <name>`

From Telegram:
- `/agents list` — see all agents
- `/agents send <name> <message>` — send a message
- `/agents cross <from> <to> <message>` — cross-agent communication

Agents can message each other to coordinate tasks. Use this when:
- A task spans multiple domains (e.g., solar data + crypto analysis)
- You need to delegate a subtask to a specialist agent
- You want to broadcast information to all agents
