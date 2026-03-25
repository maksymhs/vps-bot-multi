import chalk from 'chalk'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { getBanner } from '../lib/branding.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const envFile = join(__dirname, '..', '..', '.env')

// ── Header ───────────────────────────────────────────────────────────────────

export function printHeader(section) {
  console.clear()
  console.log(chalk.cyan(getBanner()))
  if (section) {
    console.log(chalk.gray(`  ${section}\n`))
  }
}

// ── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let spinnerInterval = null
let spinnerFrame = 0
let spinnerText = ''

export function startSpinner(text) {
  stopSpinner()
  spinnerText = text
  spinnerFrame = 0
  process.stdout.write(`  ${chalk.cyan(SPINNER[0])} ${chalk.gray(text)}`)
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER.length
    process.stdout.write(`\r  ${chalk.cyan(SPINNER[spinnerFrame])} ${chalk.gray(spinnerText)}                    `)
  }, 80)
}

export function updateSpinner(text) {
  spinnerText = text
  if (spinnerInterval) {
    process.stdout.write(`\r  ${chalk.cyan(SPINNER[spinnerFrame])} ${chalk.gray(text)}                    `)
  }
}

export function stopSpinner(finalText, success = true) {
  if (spinnerInterval) {
    clearInterval(spinnerInterval)
    spinnerInterval = null
  }
  if (finalText) {
    const icon = success ? chalk.green('✓') : chalk.red('✗')
    process.stdout.write(`\r  ${icon} ${finalText}                              \n`)
  }
}

// ── Markdown helpers ─────────────────────────────────────────────────────────

export function stripMarkdown(text) {
  return text
    .replace(/\*\*/g, '').replace(/\*/g, '')
    .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`/g, ''))
    .replace(/`/g, '').replace(/_/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
}

// ── CLI context (mimics Telegram bot ctx for reusing deploy functions) ────────

export const cliCtx = {
  reply: (text) => {
    const plain = stripMarkdown(text)
    if (plain.startsWith('✅')) {
      stopSpinner(plain.replace('✅ ', ''), true)
    } else if (plain.startsWith('❌')) {
      stopSpinner(plain.replace('❌ ', ''), false)
    } else {
      const phase = plain.replace(/^⚙️\s*\S+\s*/, '').replace(/\d+[ms]+\s*$/, '').trim()
      if (spinnerInterval) {
        updateSpinner(phase)
      } else {
        startSpinner(phase)
      }
    }
    return Promise.resolve({ message_id: 1 })
  },
  chat: { id: 'cli' },
  telegram: {
    editMessageText: async (_chatId, _msgId, _inlineId, text) => {
      const plain = stripMarkdown(text)
      if (plain.startsWith('✅')) {
        stopSpinner(plain.replace('✅ ', ''), true)
      } else if (plain.startsWith('❌')) {
        stopSpinner(plain.replace('❌ ', ''), false)
      } else {
        const phase = plain.replace(/^⚙️\s*\S+\s*/, '').replace(/\d+[ms]+\s*$/, '').trim()
        updateSpinner(phase)
      }
    },
  },
}

// ── .env helpers ─────────────────────────────────────────────────────────────

export function updateEnvVar(key, value, comment = false) {
  try {
    let content = readFileSync(envFile, 'utf-8')
    const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm')
    const newLine = comment ? `# ${key}=` : `${key}=${value}`
    if (regex.test(content)) {
      content = content.replace(regex, newLine)
    } else {
      content += `\n${newLine}\n`
    }
    writeFileSync(envFile, content)
    if (comment) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  } catch {}
}
