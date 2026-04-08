import { initDatabase, createAgentRow, listAgents, getAgent, deleteAgentRow, setAgentSession, setAgentTopicId, getAllAgentStats, getAgentWorkLog, getAgentSkills, addAgentSkill, removeAgentSkill, getNextAnimalName, renameAgent, getAvailableAnimalNames } from './db.js'
import { runAgent } from './agent.js'
import { TELEGRAM_BOT_TOKEN, ALLOWED_GROUP_ID } from './config.js'

initDatabase()

const args = process.argv.slice(2)
const cmd = args[0]

function usage() {
  console.log(`Usage:
  agent-cli create "<description>" "<system_prompt>"         # auto-assigns animal name
  agent-cli create <name> "<description>" "<system_prompt>"  # use specific name
  agent-cli rename <old-name> <new-name>
  agent-cli names                              # list available animal names
  agent-cli list
  agent-cli info <name>
  agent-cli send <name> <message...>           # default 5 min idle timeout
  agent-cli send <name> --timeout 900 <msg>    # custom idle timeout in seconds
  agent-cli delete <name>
  agent-cli reset <name>
  agent-cli stats                              # all agents overview
  agent-cli work <name> [limit]                # agent work history
  agent-cli skills <name>                      # agent skills list
  agent-cli add-skill <name> "<skill>" ["notes"]
  agent-cli rm-skill <name> "<skill>"`)
}

switch (cmd) {
  case 'create': {
    // Support both: create "<desc>" "<prompt>" (auto-name) and create <name> "<desc>" "<prompt>"
    let name: string
    let description: string
    let systemPrompt: string
    if (args.length === 4) {
      // Explicit name: create <name> "<desc>" "<prompt>"
      name = args[1]; description = args[2]; systemPrompt = args[3]
    } else if (args.length === 3) {
      // Auto-assign animal name: create "<desc>" "<prompt>"
      name = getNextAnimalName(); description = args[1]; systemPrompt = args[2]
    } else {
      usage(); process.exit(1); break
    }
    try {
      createAgentRow(name, description, systemPrompt)
      console.log(`Agent "${name}" created.`)

      // Auto-create forum topic in Telegram group
      if (TELEGRAM_BOT_TOKEN && ALLOWED_GROUP_ID) {
        try {
          const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: Number(ALLOWED_GROUP_ID), name }),
          })
          const data = await res.json() as { ok: boolean; result?: { message_thread_id: number } }
          if (data.ok && data.result) {
            setAgentTopicId(name, data.result.message_thread_id)
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: Number(ALLOWED_GROUP_ID),
                message_thread_id: data.result.message_thread_id,
                text: `Agent "${name}" ready.\n${description}`,
              }),
            })
            console.log(`Forum topic created.`)
          }
        } catch (topicErr) {
          console.error(`Agent created but forum topic failed: ${topicErr instanceof Error ? topicErr.message : String(topicErr)}`)
        }
      }
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    break
  }
  case 'rename': {
    const [, oldName, newName] = args
    if (!oldName || !newName) { console.log('Usage: agent-cli rename <old-name> <new-name>'); process.exit(1) }
    try {
      if (renameAgent(oldName, newName)) {
        console.log(`Agent "${oldName}" → "${newName}"`)
      } else {
        console.log(`Agent "${oldName}" not found.`)
      }
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    break
  }
  case 'names': {
    const available = getAvailableAnimalNames()
    console.log(`Available animal names (${available.length}):`)
    console.log(available.join(', '))
    break
  }
  case 'list': {
    const agents = listAgents()
    if (agents.length === 0) {
      console.log('No agents configured.')
    } else {
      for (const a of agents) {
        const session = a.session_id ? 'active session' : 'no session'
        console.log(`[${a.name}] ${a.description} (${session})`)
      }
    }
    break
  }
  case 'info': {
    if (!args[1]) { usage(); process.exit(1) }
    const agent = getAgent(args[1])
    if (!agent) {
      console.log(`Agent "${args[1]}" not found.`)
    } else {
      console.log(`Name: ${agent.name}`)
      console.log(`Description: ${agent.description}`)
      console.log(`System prompt: ${agent.system_prompt}`)
      console.log(`Session: ${agent.session_id ?? 'none'}`)
    }
    break
  }
  case 'send': {
    const name = args[1]
    // Parse optional --timeout <seconds> flag from remaining args
    let idleTimeoutMs: number | undefined
    const rest = args.slice(2)
    const timeoutFlagIdx = rest.indexOf('--timeout')
    if (timeoutFlagIdx !== -1 && rest[timeoutFlagIdx + 1]) {
      idleTimeoutMs = parseInt(rest[timeoutFlagIdx + 1]) * 1000
      rest.splice(timeoutFlagIdx, 2)
    }
    const message = rest.join(' ')
    if (!name || !message) { usage(); process.exit(1) }
    const agent = getAgent(name)
    if (!agent) {
      console.error(`Agent "${name}" not found.`)
      process.exit(1)
    }

    const sessionId = agent.session_id ?? undefined
    const fullMessage = `[Agent: ${agent.name}]\n\n${message}`

    const enableStallNudge = idleTimeoutMs !== undefined ? true : undefined
    const { text, newSessionId } = await runAgent(fullMessage, sessionId, undefined, agent.system_prompt, undefined, undefined, undefined, enableStallNudge)
    if (newSessionId) {
      setAgentSession(name, newSessionId)
    }
    console.log(text ?? 'No response.')
    break
  }
  case 'delete': {
    if (!args[1]) { usage(); process.exit(1) }
    if (deleteAgentRow(args[1])) {
      console.log(`Agent "${args[1]}" deleted.`)
    } else {
      console.log(`Agent "${args[1]}" not found.`)
    }
    break
  }
  case 'reset': {
    if (!args[1]) { usage(); process.exit(1) }
    const agent = getAgent(args[1])
    if (!agent) {
      console.log(`Agent "${args[1]}" not found.`)
    } else {
      const { getDb } = await import('./db.js')
      getDb().prepare('UPDATE agents SET session_id = NULL WHERE name = ?').run(args[1])
      console.log(`Agent "${args[1]}" session cleared.`)
    }
    break
  }
  case 'stats': {
    const stats = getAllAgentStats()
    if (stats.length === 0) { console.log('No agents.'); break }
    for (const a of stats) {
      const totalTokens = a.total_tokens_in + a.total_tokens_out
      const last = a.last_active ? new Date(a.last_active).toLocaleString() : 'never'
      console.log(`[${a.name}] ${a.description}`)
      console.log(`  Runs: ${a.total_runs} | Tokens: ${totalTokens} | Last: ${last}`)
    }
    break
  }
  case 'work': {
    const name = args[1]
    const limit = parseInt(args[2]) || 10
    if (!name) { usage(); process.exit(1) }
    const log = getAgentWorkLog(name, limit)
    if (log.length === 0) { console.log(`No work history for "${name}".`); break }
    for (const e of log) {
      const dur = e.duration_ms ? `${Math.round(e.duration_ms / 1000)}s` : '?'
      const ts = new Date(e.created_at).toLocaleString()
      const icon = e.status === 'completed' ? '✓' : e.status === 'running' ? '⟳' : '✗'
      console.log(`${icon} [${ts}] ${e.task.slice(0, 80)} (${dur}, ${e.tokens_in + e.tokens_out} tokens) [${e.status}]`)
    }
    break
  }
  case 'skills': {
    const name = args[1]
    if (!name) { usage(); process.exit(1) }
    const skills = getAgentSkills(name)
    if (skills.length === 0) { console.log(`No skills for "${name}".`); break }
    for (const s of skills) {
      const last = s.last_used ? new Date(s.last_used).toLocaleString() : 'never'
      console.log(`• ${s.skill} (${s.times_used}x, last: ${last})${s.notes ? ` — ${s.notes}` : ''}`)
    }
    break
  }
  case 'add-skill': {
    const [, name, skill, notes] = args
    if (!name || !skill) { usage(); process.exit(1) }
    addAgentSkill(name, skill, notes || '')
    console.log(`Skill "${skill}" added to "${name}".`)
    break
  }
  case 'rm-skill': {
    const [, name, skill] = args
    if (!name || !skill) { usage(); process.exit(1) }
    if (removeAgentSkill(name, skill)) {
      console.log(`Skill "${skill}" removed from "${name}".`)
    } else {
      console.log(`Skill not found.`)
    }
    break
  }
  default:
    usage()
}
