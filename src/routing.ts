/**
 * Shared message routing logic — Chrome detection, model selection.
 * Used by both bot.ts (Telegram) and api.ts (HTTP API).
 */

// Auto-detect if message needs Chrome browser access
const CHROME_PATTERNS = /\b(browse|browser|chrome|click|webpage|website|open.*page|go to|visit|navigate|fill.*form|login.*site|scrape|screenshot)\b/i

export function needsChrome(message: string): boolean {
  return CHROME_PATTERNS.test(message)
}

// Patterns that indicate a complex/code-heavy task
const COMPLEX_PATTERNS = /\b(refactor|implement|build|create|debug|fix|analyze|review|write.*code|deploy|migrate|architect|design|optimize|automate|set up|configure|code|script|function|database|server|api|install|migration)\b/i

/**
 * Auto-detect message complexity to pick the right model.
 * Returns undefined to use the configured default (usually Opus/high).
 */
export function autoModel(message: string): { model?: string; effort?: string } | undefined {
  // Short messages or simple questions → Sonnet
  if (message.length < 100 && !COMPLEX_PATTERNS.test(message)) {
    return { model: 'sonnet', effort: 'medium' }
  }
  // Complex tasks → use configured model (default Opus/high)
  return undefined
}

/**
 * Fuller auto-model for the HTTP API, which needs chrome detection too.
 */
export function autoModelFull(message: string): { model: string; effort: string; chrome: boolean } {
  const len = message.length
  const hasCode = COMPLEX_PATTERNS.test(message)
  const multiLine = message.includes('\n')
  const chrome = needsChrome(message)

  // Long, code-heavy, or multi-line → Opus high
  if ((len > 300 && hasCode) || (multiLine && hasCode)) return { model: 'opus', effort: 'high', chrome }
  // Medium complexity → Sonnet medium
  if (len > 150 || hasCode) return { model: 'sonnet', effort: 'medium', chrome }
  // Short/simple → Sonnet low
  return { model: 'sonnet', effort: 'low', chrome }
}
