import { spawn, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'
import { displayActivity, displayState } from './display.js'
import { getModelConfig } from './model-config.js'

function findClaudePath(): string {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH
  // Common locations
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.claude/bin/claude`,
    '/usr/local/bin/claude',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // Fallback: ask the shell
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim()
  } catch {
    return 'claude' // hope it's in PATH
  }
}

const CLAUDE_PATH = findClaudePath()

// Stuck detection settings
const CHECK_INTERVAL_MS = 30_000 // check every 30 seconds
const STALL_TIMEOUT_MS = 10 * 60_000 // stalled = no output for 10 min → nudge (wake up + resume)
const HANG_TIMEOUT_MS = 30 * 60_000 // truly hung = no output at all for 30 min → kill
const LOOP_THRESHOLD = 8 // same tool+args seen this many times = looping
const MAX_TOOL_HISTORY = 30 // track last N tool calls for loop detection

export interface AgentResult {
  text: string | null
  newSessionId?: string
  tokensIn?: number
  tokensOut?: number
  nudged?: boolean // true if process was killed for a nudge interrupt
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  systemPrompt?: string,
  modelOverride?: { model?: string; effort?: string },
  useChrome?: boolean,
  onProgress?: (update: string) => void,
  enableStallNudge?: boolean, // if true, detect silence and return nudged=true so caller can resume
): Promise<AgentResult> {
  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (onTyping) {
    onTyping()
    typingInterval = setInterval(onTyping, 4000)
  }

  try {
    const mc = getModelConfig()
    const model = modelOverride?.model || mc.model
    const effort = modelOverride?.effort || mc.effort
    const args = [
      '-p',
      message,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--effort', effort,
      '--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions',
    ]

    if (useChrome === true) {
      args.push('--chrome')
    }

    if (systemPrompt && !sessionId) {
      args.push('--system-prompt', systemPrompt)
    }

    if (sessionId) {
      args.push('--resume', sessionId)
    }

    const result = await new Promise<AgentResult>((resolve) => {
      const env = { ...process.env }
      delete env.CLAUDECODE

      let stdout = ''
      let stderr = ''
      let settled = false
      let totalTokensIn = 0
      let totalTokensOut = 0

      const safeResolve = (val: AgentResult) => {
        if (settled) return
        settled = true
        resolve(val)
      }

      const proc = spawn(CLAUDE_PATH, args, {
        cwd: PROJECT_ROOT,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let lastActivity = Date.now()
      let lineBuf = ''

      // Stuck detection state
      const toolHistory: string[] = [] // fingerprints of recent tool calls
      let loopDetected = false

      function makeToolFingerprint(name: string, input: unknown): string {
        // Short hash of tool name + first 200 chars of stringified input
        const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '')
        return `${name}::${inputStr.slice(0, 200)}`
      }

      function checkForLoop(fingerprint: string): string | null {
        toolHistory.push(fingerprint)
        if (toolHistory.length > MAX_TOOL_HISTORY) toolHistory.shift()

        // Count consecutive repeats from the end
        let repeats = 0
        for (let i = toolHistory.length - 1; i >= 0; i--) {
          if (toolHistory[i] === fingerprint) repeats++
          else break
        }

        if (repeats >= LOOP_THRESHOLD) {
          const toolName = fingerprint.split('::')[0]
          return `Agent stuck in loop: called ${toolName} ${repeats}x in a row with same args`
        }
        return null
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stdout += text
        lastActivity = Date.now()

        lineBuf += text
        const parts = lineBuf.split('\n')
        lineBuf = parts.pop() ?? ''
        for (const line of parts) {
          if (!line.trim()) continue
          try {
            const evt = JSON.parse(line)
            // Track token usage from usage events
            if (evt.message?.usage) {
              totalTokensIn += evt.message.usage.input_tokens || 0
              totalTokensOut += evt.message.usage.output_tokens || 0
            }
            if (evt.type === 'assistant' && evt.message?.content) {
              for (const block of evt.message.content) {
                if (block.type === 'tool_use') {
                  displayActivity('command', `Tool: ${block.name}`, 'executing')

                  // Track tool calls for loop detection
                  const fp = makeToolFingerprint(block.name, block.input)
                  const loopMsg = checkForLoop(fp)
                  if (loopMsg && !loopDetected) {
                    loopDetected = true
                    logger.warn({ agent: 'claude', tool: block.name }, loopMsg)
                    proc.kill()
                    safeResolve({ text: loopMsg, newSessionId: undefined, tokensIn: totalTokensIn, tokensOut: totalTokensOut })
                  }
                } else if (block.type === 'text' && block.text) {
                  const snippet = block.text.slice(0, 120)
                  displayActivity('info', snippet, 'thinking')
                  onProgress?.(`💬 ${snippet}`)
                }
              }
            }
          } catch {
            // not valid JSON, skip
          }
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        lastActivity = Date.now()
      })

      // Stuck monitor: stall detection + hang kill
      let stallNudged = false
      const stuckChecker = setInterval(() => {
        const silenceMs = Date.now() - lastActivity

        // Stall detection: 10 min silence → nudge (wake up so caller can resume)
        if (enableStallNudge && !stallNudged && silenceMs > STALL_TIMEOUT_MS) {
          stallNudged = true
          const mins = Math.round(silenceMs / 60_000)
          logger.info({ agent: 'claude' }, `Agent stalled: no output for ${mins} minutes — nudging`)
          proc.kill()
          safeResolve({ text: null, newSessionId: undefined, tokensIn: totalTokensIn, tokensOut: totalTokensOut, nudged: true })
          return
        }

        // Hard kill: 30 min silence → truly hung
        if (silenceMs > HANG_TIMEOUT_MS) {
          const mins = Math.round(silenceMs / 60_000)
          logger.warn({ agent: 'claude' }, `Agent hung: no output for ${mins} minutes — killing`)
          proc.kill()
          safeResolve({ text: `Agent appears hung (no output for ${mins} minutes). Session preserved — can resume.`, newSessionId: undefined, tokensIn: totalTokensIn, tokensOut: totalTokensOut })
        }
      }, CHECK_INTERVAL_MS)

      proc.on('close', (code) => {
        clearInterval(stuckChecker)

        if (code !== 0 && !stdout) {
          logger.error({ stderr: stderr.slice(0, 500), code }, 'Claude CLI exited with error')
          safeResolve({
            text: `Error (code ${code}): ${stderr.slice(0, 500) || 'Unknown error'}`,
            newSessionId: undefined,
          })
          return
        }

        // Parse stream-json: find the result line and accumulate usage
        const lines = stdout.trim().split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i])
            // Catch any usage we missed in streaming
            if (parsed.total_input_tokens) totalTokensIn = parsed.total_input_tokens
            if (parsed.total_output_tokens) totalTokensOut = parsed.total_output_tokens
            if (parsed.type === 'result') {
              safeResolve({
                text: parsed.result ?? 'Done!',
                newSessionId: parsed.session_id ?? undefined,
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
              })
              return
            }
          } catch {
            // skip unparseable lines
          }
        }

        // Fallback: no result line found
        safeResolve({
          text: stdout.trim().slice(0, 4000) || 'No response.',
          newSessionId: undefined,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
        })
      })

      proc.on('error', (err) => {
        clearInterval(stuckChecker)
        logger.error({ err }, 'Failed to spawn claude')
        safeResolve({ text: `Failed to start Claude: ${err.message}`, newSessionId: undefined })
      })

      // Close stdin immediately since we pass the prompt via args
      proc.stdin.end()
    })

    return result
  } catch (err) {
    logger.error({ err }, 'Agent error')
    return {
      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      newSessionId: undefined,
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }
}
