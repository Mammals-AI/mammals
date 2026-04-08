/**
 * Pushes activity events to the Mammals Display server.
 * All calls are fire-and-forget — never blocks or crashes the bot.
 */

const DISPLAY_URL = process.env.DISPLAY_URL || 'http://localhost:5055'
const DASHBOARD_URL = 'http://localhost:5075'

async function post(path: string, body: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(body)
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(3000),
  }
  // Fire to both display and dashboard — silent fail on either
  await Promise.allSettled([
    fetch(`${DISPLAY_URL}${path}`, opts),
    fetch(`${DASHBOARD_URL}${path}`, { ...opts, signal: AbortSignal.timeout(3000) }),
  ])
}

export function displayState(state: 'idle' | 'thinking' | 'talking' | 'executing') {
  post('/api/state', { state })
}

export function displayActivity(type: string, message: string, state?: string, speech?: string) {
  post('/api/activity', { type, message, ...(state && { state }), ...(speech && { speech }) })
}
