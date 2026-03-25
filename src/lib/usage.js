import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const USAGE_FILE = join(process.cwd(), '.claude-usage.json')

// Estimated rate limits (Claude API)
const LIMITS = {
  perMinute: 100,     // RPM (requests per minute)
  perDay: 1000,       // Calls per day (estimated)
  tokensPerMinute: 80000,
}

function loadUsage() {
  if (!existsSync(USAGE_FILE)) {
    return { calls: [], tokens: 0, lastReset: new Date().toISOString() }
  }
  try {
    return JSON.parse(readFileSync(USAGE_FILE, 'utf8'))
  } catch {
    return { calls: [], tokens: 0, lastReset: new Date().toISOString() }
  }
}

function saveUsage(usage) {
  writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2))
}

function cleanOldCalls(calls) {
  const now = Date.now()
  const oneMinuteAgo = now - 60 * 1000
  const oneDayAgo = now - 24 * 60 * 60 * 1000

  return {
    minute: calls.filter(t => t > oneMinuteAgo),
    day: calls.filter(t => t > oneDayAgo),
  }
}

export function recordClaudeCall(tokens = 0) {
  const usage = loadUsage()
  usage.calls.push(Date.now())
  usage.tokens += tokens
  saveUsage(usage)
}

export function getUsageStats() {
  const usage = loadUsage()
  const cleaned = cleanOldCalls(usage.calls)

  const callsPerMin = cleaned.minute.length
  const callsPerDay = cleaned.day.length
  const percentMin = Math.round((callsPerMin / LIMITS.perMinute) * 100)
  const percentDay = Math.round((callsPerDay / LIMITS.perDay) * 100)

  // Calculate next reset time
  const oldestCall = usage.calls[0] ? new Date(usage.calls[0]) : new Date()
  const resetTime = new Date(oldestCall.getTime() + 24 * 60 * 60 * 1000)
  const hoursUntilReset = Math.max(0, Math.round((resetTime - new Date()) / (60 * 60 * 1000)))

  return {
    callsPerMin,
    callsPerDay,
    percentMin,
    percentDay,
    limitsPerMin: LIMITS.perMinute,
    limitsPerDay: LIMITS.perDay,
    tokens: usage.tokens,
    hoursUntilReset,
    resetTime: resetTime.toLocaleString('en-US'),
  }
}

export function getUsageText() {
  const stats = getUsageStats()

  // Calculate real percentage with decimals
  const percentMinReal = (stats.callsPerMin / stats.limitsPerMin) * 100
  const percentDayReal = (stats.callsPerDay / stats.limitsPerDay) * 100

  // Visual bar: 10 blocks
  const filledMin = Math.round(percentMinReal / 10)
  const filledDay = Math.round(percentDayReal / 10)
  const barMin = '█'.repeat(filledMin) + '░'.repeat(10 - filledMin)
  const barDay = '█'.repeat(filledDay) + '░'.repeat(10 - filledDay)

  return `⚡ *Claude Usage*

⏱️ *Per minute:*
\`${barMin}\` ${stats.callsPerMin}/${stats.limitsPerMin} (${percentMinReal.toFixed(1)}%)

📅 *Per day:*
\`${barDay}\` ${stats.callsPerDay}/${stats.limitsPerDay} (${percentDayReal.toFixed(1)}%)

🔄 Resets in: ${stats.hoursUntilReset}h`
}
