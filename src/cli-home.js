#!/usr/bin/env node

import 'dotenv/config'
import { config } from './lib/config.js'
import chalk from 'chalk'
import { execSync } from 'child_process'

// If not configured, run setup first
if (!config.isSetupComplete()) {
  console.clear()
  console.log(chalk.yellow('\nNot configured. Running setup...\n'))
  try {
    execSync('node src/setup.js', { stdio: 'inherit' })
  } catch {}
  // Reload env after setup
  const { config: dotenv } = await import('dotenv')
  dotenv()
}

// Launch CLI directly (same process, keeps menu loop alive)
await import('./cli.js')
