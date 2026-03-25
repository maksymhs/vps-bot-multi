import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOGS_DIR = join(__dirname, '..', '..', 'logs')
mkdirSync(LOGS_DIR, { recursive: true })

const SYSTEM_LOG = join(LOGS_DIR, 'system.log')
const INSTALL_LOG = join(LOGS_DIR, 'install.log')

function timestamp() {
  return new Date().toISOString()
}

function write(file, level, msg, extra) {
  try {
    let line = `[${timestamp()}] ${level} ${msg}`
    if (extra) line += `\n  ${String(extra).replace(/\n/g, '\n  ')}`
    appendFileSync(file, line + '\n')
  } catch { /* never fail */ }
}

function buildLogFile(projectName) {
  return join(LOGS_DIR, `build-${projectName}.log`)
}

export const log = {
  info: (msg, extra) => write(SYSTEM_LOG, 'INFO', msg, extra),
  error: (msg, extra) => write(SYSTEM_LOG, 'ERROR', msg, extra),
  build: (projectName, msg, extra) => write(buildLogFile(projectName), 'INFO', msg, extra),
  buildError: (projectName, msg, extra) => write(buildLogFile(projectName), 'ERROR', msg, extra),
  file: SYSTEM_LOG,
  dir: LOGS_DIR,
  installLog: INSTALL_LOG,
  buildLog: buildLogFile,
}
