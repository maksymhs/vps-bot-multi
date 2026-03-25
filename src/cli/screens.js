import inquirer from 'inquirer'
import si from 'systeminformation'
import chalk from 'chalk'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { config } from '../lib/config.js'
import { getDocker } from '../lib/docker-client.js'
import { getUsageText } from '../lib/usage.js'
import { getCodeServerBaseUrl, ensureCodeServer } from '../lib/code-server.js'
import { log } from '../lib/logger.js'
import { printHeader } from './ui.js'

// ── Server Status ────────────────────────────────────────────────────────────

export async function showStatus(nav) {
  printHeader('Server Status')
  try {
    const [cpu, mem, disk] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()])
    const gb = (b) => (b / 1024 ** 3).toFixed(1)
    const pct = (n) => Math.round(n)
    const d = disk.find((d) => d.mount === '/') || disk[0]

    console.log(`  CPU Usage:   ${pct(cpu.currentLoad)}%`)
    console.log(`  Memory:      ${gb(mem.used)}GB / ${gb(mem.total)}GB (${pct((mem.used / mem.total) * 100)}%)`)
    console.log(`  Disk Space:  ${gb(d.used)}GB / ${gb(d.size)}GB (${pct(d.use)}%)\n`)
  } catch (err) {
    console.log(chalk.red(`  Error: ${err.message}\n`))
  }

  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
  return nav.mainMenu()
}

// ── Docker Containers ────────────────────────────────────────────────────────

export async function showContainers(nav) {
  printHeader('Docker Containers')
  try {
    const containers = await getDocker().listContainers({ all: true })

    if (!containers.length) {
      console.log(chalk.yellow('  No containers found.\n'))
    } else {
      containers.forEach((c) => {
        const name = c.Names[0].replace('/', '')
        const statusStr = c.State === 'running' ? chalk.green('running') : chalk.red('stopped')
        console.log(`  ${name}`)
        console.log(`    Status: ${statusStr}`)
        console.log(`    Image:  ${c.Image}`)
        console.log('')
      })
    }
  } catch (err) {
    console.log(chalk.red(`  Error: ${err.message}\n`))
  }

  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
  return nav.mainMenu()
}

// ── Code-Server ──────────────────────────────────────────────────────────────

export async function showCodeServer(nav) {
  printHeader('Code-Server')
  try {
    const result = await ensureCodeServer()
    if (!result.success) {
      console.log(chalk.red(`  ✗ ${result.message}\n`))
    } else {
      const url = getCodeServerBaseUrl()
      console.log(chalk.green(`  ✓ Running`))
      console.log(`  URL:      ${url}`)
      console.log(`  Password: ${config.codeServerPassword}\n`)
    }
  } catch (err) {
    console.log(chalk.red(`  Error: ${err.message}\n`))
  }

  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
  return nav.mainMenu()
}

// ── Claude Usage ─────────────────────────────────────────────────────────────

export async function showClaudeUsage(nav) {
  printHeader('Claude Usage')
  const text = getUsageText()
    .replace(/\*/g, '')
    .replace(/`/g, '')
    .replace(/_/g, '')
  console.log(`${text}\n`)

  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
  return nav.mainMenu()
}

// ── System Logs ──────────────────────────────────────────────────────────────

export async function showSystemLogs(nav) {
  printHeader('System Logs')
  const { readdirSync } = await import('fs')
  const logsDir = log.dir

  let logFiles = []
  try {
    logFiles = readdirSync(logsDir).filter(f => f.endsWith('.log')).sort()
  } catch {}

  if (!logFiles.length) {
    console.log(chalk.yellow('  No logs yet.\n'))
    await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
    return nav.config()
  }

  const { file } = await inquirer.prompt([{
    type: 'list',
    name: 'file',
    message: 'Select log file:',
    loop: false,
    choices: [
      ...logFiles.map(f => ({ name: f, value: f })),
      new inquirer.Separator(),
      { name: 'Back', value: 'back' },
    ],
  }])

  if (file === 'back') return nav.config()

  // Show log file content
  printHeader(file)
  const filePath = join(logsDir, file)
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf8')
    const lines = content.trim().split('\n')
    const tail = lines.slice(-50).join('\n')
    console.log(tail)
    console.log(chalk.gray(`\n  (last ${Math.min(lines.length, 50)} of ${lines.length} lines)\n`))
  }

  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
  return showSystemLogs(nav)
}
