#!/usr/bin/env node

import 'dotenv/config'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { config } from './lib/config.js'
import { PROJECT } from './lib/branding.js'
import { log } from './lib/logger.js'
import { printHeader } from './cli/ui.js'
import { showStatus, showContainers, showCodeServer, showClaudeUsage, showSystemLogs } from './cli/screens.js'
import { showConfig } from './cli/config-screens.js'
import { showProjects, showNewProject } from './cli/project-screens.js'
import { reconcileSleepState } from './lib/sleep-manager.js'

// Navigation object passed to all screens to avoid circular imports
const nav = {
  mainMenu: () => showMainMenu(),
  config: () => showConfig(nav),
  systemLogs: () => showSystemLogs(nav),
}

async function showMainMenu() {
  printHeader(`${PROJECT.tagline}  ·  v${PROJECT.version}`)

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Navigation',
    loop: false,
    choices: [
      { name: 'View Projects', value: 'list' },
      { name: 'Create New Project', value: 'new' },
      { name: 'Server Status', value: 'status' },
      { name: 'Docker Containers', value: 'containers' },
      { name: 'Code-Server (IDE)', value: 'codeserver' },
      { name: 'Claude Usage', value: 'usage' },
      new inquirer.Separator(chalk.gray('─────────────────')),
      { name: 'Configuration', value: 'config' },
      { name: 'Exit', value: 'exit' },
    ],
  }])

  switch (action) {
    case 'list':       return showProjects(nav)
    case 'new':        return showNewProject(nav)
    case 'status':     return showStatus(nav)
    case 'containers': return showContainers(nav)
    case 'codeserver': return showCodeServer(nav)
    case 'usage':      return showClaudeUsage(nav)
    case 'config':     return showConfig(nav)
    case 'exit':
      console.log(chalk.gray('\nGoodbye.\n'))
      process.exit(0)
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  if (!config.isSetupComplete()) {
    console.log(chalk.red('\nSystem not configured.\nRun: npm run setup\n'))
    process.exit(1)
  }
  reconcileSleepState().catch(() => {})
  await showMainMenu()
}

process.on('uncaughtException', (err) => {
  log.error('[CRASH] uncaughtException', err.stack || err.message)
  console.error(chalk.red(`\nCrash: ${err.message}`))
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  log.error('[CRASH] unhandledRejection', String(reason))
  console.error(chalk.red(`\nUnhandled rejection: ${reason}`))
})

main().catch((err) => {
  log.error('[CRASH] main()', err.stack || err.message)
  console.error(chalk.red('Error:'), err.message)
  process.exit(1)
})
