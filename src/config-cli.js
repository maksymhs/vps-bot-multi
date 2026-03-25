#!/usr/bin/env node

/**
 * Server-side config editor for vps-bot-multi
 * Run: npm run config
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import { execSync } from 'child_process'

const ENV_PATH = join(process.cwd(), '.env')

// ── Helpers ─────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
}

function readEnv() {
  if (!existsSync(ENV_PATH)) return {}
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n')
  const env = {}
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match) env[match[1]] = match[2]
  }
  return env
}

function writeEnvKey(key, value) {
  if (!existsSync(ENV_PATH)) {
    writeFileSync(ENV_PATH, `${key}=${value}\n`)
    return
  }
  let content = readFileSync(ENV_PATH, 'utf8')
  const regex = new RegExp(`^${key}=.*$`, 'm')
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`)
  } else {
    content += `\n${key}=${value}\n`
  }
  writeFileSync(ENV_PATH, content)
}

function ask(rl, question, defaultVal = '') {
  const hint = defaultVal ? ` ${C.dim}[${defaultVal}]${C.reset}` : ''
  return new Promise(resolve => {
    rl.question(`  ${C.yellow}?${C.reset} ${question}${hint}: `, answer => {
      resolve(answer.trim() || defaultVal)
    })
  })
}

function isBotRunning() {
  try {
    const out = execSync('systemctl is-active vps-bot-multi 2>/dev/null', { encoding: 'utf8' }).trim()
    return out === 'active'
  } catch { return false }
}

// ── Menu ────────────────────────────────────────────────────────────────────

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('')
  console.log(`  ${C.cyan}${C.bold}vps-bot-multi${C.reset} ${C.dim}— server config${C.reset}`)
  console.log(`  ${C.dim}──────────────────────────────────────────${C.reset}`)

  const env = readEnv()
  const running = isBotRunning()

  // Show current config
  console.log('')
  console.log(`  ${C.bold}Current config:${C.reset}`)
  const keys = [
    ['BOT_TOKEN', env.BOT_TOKEN ? '✔ set' : '✘ missing'],
    ['OPENROUTER_API_KEY', env.OPENROUTER_API_KEY && env.OPENROUTER_API_KEY !== 'sk-or-v1-your-key-here' ? '✔ set' : '✘ missing'],
    ['DOMAIN', env.DOMAIN && env.DOMAIN !== 'your-domain.com' ? env.DOMAIN : (env.IP_ADDRESS || '✘ not set')],
    ['ADMIN_USER_ID', env.ADMIN_USER_ID && env.ADMIN_USER_ID !== '123456789' ? env.ADMIN_USER_ID : 'auto-detect'],
    ['MAX_APPS_PER_USER', env.MAX_APPS_PER_USER || '3'],
    ['MAX_CONCURRENT_BUILDS', env.MAX_CONCURRENT_BUILDS || '2'],
    ['IDLE_TIMEOUT', env.IDLE_TIMEOUT || '30'],
    ['DEFAULT_MODEL', env.DEFAULT_MODEL || 'deepseek/deepseek-chat-v3-0324'],
  ]

  for (const [key, val] of keys) {
    const icon = val.startsWith('✘') ? C.red : C.green
    console.log(`  ${icon}${val.startsWith('✔') || val.startsWith('✘') ? val : `✔ ${val}`}${C.reset}  ${C.dim}${key}${C.reset}`)
  }

  console.log(`\n  ${C.bold}Bot:${C.reset} ${running ? `${C.green}running${C.reset}` : `${C.red}stopped${C.reset}`}`)

  // Menu
  console.log(`\n  ${C.bold}What to edit?${C.reset}`)
  console.log(`  ${C.dim}1${C.reset} BOT_TOKEN`)
  console.log(`  ${C.dim}2${C.reset} OPENROUTER_API_KEY`)
  console.log(`  ${C.dim}3${C.reset} DOMAIN / IP`)
  console.log(`  ${C.dim}4${C.reset} ADMIN_USER_ID`)
  console.log(`  ${C.dim}5${C.reset} MAX_APPS_PER_USER`)
  console.log(`  ${C.dim}6${C.reset} MAX_CONCURRENT_BUILDS`)
  console.log(`  ${C.dim}7${C.reset} IDLE_TIMEOUT`)
  console.log(`  ${C.dim}8${C.reset} DEFAULT_MODEL`)
  console.log(`  ${C.dim}r${C.reset} Restart bot`)
  console.log(`  ${C.dim}s${C.reset} Stop bot`)
  console.log(`  ${C.dim}q${C.reset} Quit`)
  console.log('')

  const choice = await ask(rl, 'Choice', 'q')

  switch (choice) {
    case '1': {
      const val = await ask(rl, 'BOT_TOKEN', env.BOT_TOKEN || '')
      if (val) { writeEnvKey('BOT_TOKEN', val); console.log(`  ${C.green}✔${C.reset} Saved`) }
      break
    }
    case '2': {
      const val = await ask(rl, 'OPENROUTER_API_KEY', env.OPENROUTER_API_KEY || '')
      if (val) { writeEnvKey('OPENROUTER_API_KEY', val); console.log(`  ${C.green}✔${C.reset} Saved`) }
      break
    }
    case '3': {
      const val = await ask(rl, 'DOMAIN (empty for IP mode)', env.DOMAIN || '')
      if (val) {
        writeEnvKey('DOMAIN', val)
        console.log(`  ${C.green}✔${C.reset} DOMAIN → ${val}`)
      } else {
        const ip = await ask(rl, 'IP_ADDRESS', env.IP_ADDRESS || '')
        if (ip) { writeEnvKey('IP_ADDRESS', ip); console.log(`  ${C.green}✔${C.reset} IP → ${ip}`) }
      }
      break
    }
    case '4': {
      const val = await ask(rl, 'ADMIN_USER_ID', env.ADMIN_USER_ID || '')
      if (val) { writeEnvKey('ADMIN_USER_ID', val); console.log(`  ${C.green}✔${C.reset} Saved`) }
      break
    }
    case '5': {
      const val = await ask(rl, 'MAX_APPS_PER_USER', env.MAX_APPS_PER_USER || '3')
      writeEnvKey('MAX_APPS_PER_USER', val); console.log(`  ${C.green}✔${C.reset} Saved`)
      break
    }
    case '6': {
      const val = await ask(rl, 'MAX_CONCURRENT_BUILDS', env.MAX_CONCURRENT_BUILDS || '2')
      writeEnvKey('MAX_CONCURRENT_BUILDS', val); console.log(`  ${C.green}✔${C.reset} Saved`)
      break
    }
    case '7': {
      const val = await ask(rl, 'IDLE_TIMEOUT (minutes)', env.IDLE_TIMEOUT || '30')
      writeEnvKey('IDLE_TIMEOUT', val); console.log(`  ${C.green}✔${C.reset} Saved`)
      break
    }
    case '8': {
      const val = await ask(rl, 'DEFAULT_MODEL', env.DEFAULT_MODEL || 'deepseek/deepseek-chat-v3-0324')
      writeEnvKey('DEFAULT_MODEL', val); console.log(`  ${C.green}✔${C.reset} Saved`)
      break
    }
    case 'r': {
      console.log(`  ${C.cyan}⟳${C.reset} Restarting bot...`)
      try {
        execSync('systemctl restart vps-bot-multi', { stdio: 'inherit' })
        console.log(`  ${C.green}✔${C.reset} Bot restarted`)
      } catch (e) {
        console.log(`  ${C.red}✘${C.reset} ${e.message}`)
      }
      break
    }
    case 's': {
      console.log(`  ${C.yellow}■${C.reset} Stopping bot...`)
      try {
        execSync('systemctl stop vps-bot-multi', { stdio: 'inherit' })
        console.log(`  ${C.green}✔${C.reset} Bot stopped`)
      } catch (e) {
        console.log(`  ${C.red}✘${C.reset} ${e.message}`)
      }
      break
    }
    case 'q':
    default:
      break
  }

  // Ask to restart if config changed
  if (['1','2','3','4','5','6','7','8'].includes(choice) && running) {
    const restart = await ask(rl, 'Restart bot to apply changes? (y/N)', 'n')
    if (restart.toLowerCase() === 'y') {
      try {
        execSync('systemctl restart vps-bot-multi', { stdio: 'inherit' })
        console.log(`  ${C.green}✔${C.reset} Bot restarted`)
      } catch (e) {
        console.log(`  ${C.red}✘${C.reset} ${e.message}`)
      }
    }
  }

  console.log('')
  rl.close()
}

main().catch(console.error)
