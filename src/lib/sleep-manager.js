import { getDocker } from './docker-client.js'
import { config } from './config.js'
import { store } from './store.js'
import { log } from './logger.js'
import http from 'http'
import { execSync } from 'child_process'
import { join } from 'path'

// Track last activity per container (container name → timestamp)
const lastActivity = new Map()
// Track last network rx_bytes per container
const lastRxBytes = new Map()
// Containers currently waking up
const waking = new Set()

let checkInterval = null
let wakeServer = null

/**
 * Reconcile store sleeping flags with actual Docker state.
 * After a VPS reboot, Docker may restart containers that were stopped by
 * the sleep manager (restart: unless-stopped). This clears stale sleeping flags.
 */
export async function reconcileSleepState() {
  try {
    const running = await getDocker().listContainers({
      filters: JSON.stringify({ status: ['running'] }),
    })
    const runningNames = new Set(
      running.map(c => c.Names[0].replace('/', '').replace(/-app$/, ''))
    )

    const projects = store.getAll()
    for (const [name, project] of Object.entries(projects)) {
      if (project.sleeping && runningNames.has(name)) {
        store.set(name, { sleeping: false })
        log.info(`[sleep] Reconciled: ${name} is running, cleared sleeping flag`)
      }
    }
  } catch (err) {
    log.error('[sleep] Reconcile failed', err.message)
  }
}

/**
 * Start the sleep manager: periodic idle check + wake proxy
 */
export function startSleepManager() {
  const timeout = config.idleTimeout
  if (!timeout || timeout <= 0) {
    log.info('[sleep] Auto-sleep disabled (IDLE_TIMEOUT=0)')
    return
  }

  log.info(`[sleep] Auto-sleep enabled: ${timeout}m idle timeout`)

  // Initialize all running containers as "just active"
  initActivity()

  // Check every 60 seconds
  checkInterval = setInterval(() => checkIdleContainers(), 60_000)

  // Start wake proxy (handles requests to sleeping apps)
  startWakeProxy()
}

/**
 * Stop the sleep manager
 */
export function stopSleepManager() {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  if (wakeServer) {
    wakeServer.close()
    wakeServer = null
  }
}

/**
 * Record activity for a project (called externally when we know there's traffic)
 */
export function recordActivity(name) {
  lastActivity.set(`${name}-app`, Date.now())
}

/**
 * Initialize activity timestamps for all running containers
 */
async function initActivity() {
  try {
    const containers = await getDocker().listContainers({
      filters: JSON.stringify({ status: ['running'] }),
    })
    for (const c of containers) {
      const name = c.Names[0].replace('/', '')
      if (name.endsWith('-app')) {
        lastActivity.set(name, Date.now())
      }
    }
  } catch (err) {
    log.error('[sleep] init failed', err.message)
  }
}

/**
 * Check network stats to detect activity, stop idle containers
 */
async function checkIdleContainers() {
  const timeout = config.idleTimeout
  if (!timeout || timeout <= 0) return

  const timeoutMs = timeout * 60_000
  const now = Date.now()

  try {
    const containers = await getDocker().listContainers({
      filters: JSON.stringify({ status: ['running'] }),
    })

    for (const c of containers) {
      const name = c.Names[0].replace('/', '')
      if (!name.endsWith('-app')) continue

      // Skip system containers
      if (name === 'caddy-proxy' || name === 'code-server') continue

      // Check network stats for activity
      try {
        const container = getDocker().getContainer(c.Id)
        const stats = await new Promise((resolve, reject) => {
          container.stats({ stream: false }, (err, data) => {
            if (err) reject(err)
            else resolve(data)
          })
        })

        // Sum rx_bytes across all networks
        let totalRx = 0
        if (stats.networks) {
          for (const net of Object.values(stats.networks)) {
            totalRx += net.rx_bytes || 0
          }
        }

        const prevRx = lastRxBytes.get(name) || 0
        lastRxBytes.set(name, totalRx)

        // If rx_bytes increased, there was traffic → update activity
        if (totalRx > prevRx && prevRx > 0) {
          lastActivity.set(name, now)
        }
      } catch {
        // stats failed, skip
        continue
      }

      // Check if idle
      const lastActive = lastActivity.get(name) || now
      const idleTime = now - lastActive

      if (idleTime >= timeoutMs) {
        const projectName = name.replace(/-app$/, '')
        log.info(`[sleep] Stopping idle container: ${name} (idle ${Math.round(idleTime / 60000)}m)`)

        try {
          const container = getDocker().getContainer(c.Id)
          await container.stop()
          store.set(projectName, { sleeping: true })
          log.info(`[sleep] ${name} stopped`)
        } catch (err) {
          log.error(`[sleep] Failed to stop ${name}`, err.message)
        }
      }
    }
  } catch (err) {
    log.error('[sleep] check failed', err.message)
  }
}

/**
 * Wake a sleeping container by project name. Returns true if successfully started.
 */
export async function wakeContainer(name) {
  const containerName = `${name}-app`
  if (waking.has(containerName)) {
    // Already waking, wait for it
    return waitForContainer(containerName, 30_000)
  }

  waking.add(containerName)
  try {
    const containers = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [containerName] }),
    })

    if (!containers.length) return false

    const c = containers[0]
    if (c.State === 'running') {
      lastActivity.set(containerName, Date.now())
      return true
    }

    log.info(`[sleep] Waking ${containerName}...`)
    const container = getDocker().getContainer(c.Id)
    await container.start()
    lastActivity.set(containerName, Date.now())
    store.set(name, { sleeping: false })

    // Wait for container to be healthy
    const ok = await waitForContainer(containerName, 30_000)
    log.info(`[sleep] ${containerName} woke up: ${ok ? 'ok' : 'timeout'}`)
    return ok
  } catch (err) {
    log.error(`[sleep] Failed to wake ${containerName}`, err.message)
    return false
  } finally {
    waking.delete(containerName)
  }
}

/**
 * Wait for a container to respond on port 3000
 */
async function waitForContainer(containerName, timeoutMs) {
  const start = Date.now()
  const projectName = containerName.replace(/-app$/, '')
  const project = store.get(projectName)

  let host, port
  if (!config.domain && project?.port) {
    host = '127.0.0.1'
    port = project.port
  } else {
    // Get container IP
    try {
      const containers = await getDocker().listContainers({
        filters: JSON.stringify({ name: [containerName] }),
      })
      if (!containers.length) return false
      const info = await getDocker().getContainer(containers[0].Id).inspect()
      const networks = info.NetworkSettings?.Networks || {}
      host = Object.values(networks)[0]?.IPAddress
      port = 3000
    } catch {
      return false
    }
  }

  if (!host) return false

  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://${host}:${port}/health`, { timeout: 2000 }, (res) => {
          resolve(res.statusCode < 500)
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      })
      return true
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  return false
}

const WAKE_PORT = 9111

/**
 * Wake proxy: a small HTTP server that wakes sleeping containers.
 * - Domain mode: Caddy fallback label points here, so requests to sleeping apps arrive here.
 *   We read the Host header, extract the project name, wake it, then redirect.
 * - IP mode: When we sleep a container we start a temp proxy on its port.
 *   On request, we wake the container, wait, then proxy the request.
 */
function startWakeProxy() {
  if (wakeServer) return

  wakeServer = http.createServer(async (req, res) => {
    // Extract project name from Host header (e.g. "chat.domain.com" → "chat")
    const host = req.headers.host || ''
    const projectName = host.split('.')[0]

    if (!projectName || !store.get(projectName)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    log.info(`[sleep] Wake request for ${projectName} from ${req.socket.remoteAddress}`)

    // Send a "waking up" page
    res.writeHead(200, { 'Content-Type': 'text/html', 'Refresh': '5' })
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${projectName}</title>
<style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;background:#0a0a0a;color:#fff}
.c{text-align:center}.s{animation:spin 1s linear infinite;display:inline-block;font-size:2rem}
@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body><div class="c"><div class="s">⚡</div><p>Waking up <strong>${projectName}</strong>...</p>
<p style="color:#666;font-size:.875rem">Refreshing in 5 seconds</p></div></body></html>`)

    // Wake the container in background
    wakeContainer(projectName)
  })

  wakeServer.listen(WAKE_PORT, '0.0.0.0', () => {
    log.info(`[sleep] Wake proxy listening on :${WAKE_PORT}`)
  })

  wakeServer.on('error', (err) => {
    log.error(`[sleep] Wake proxy error`, err.message)
  })
}

/**
 * Get the wake proxy port (for Caddy fallback config)
 */
export function getWakePort() {
  return WAKE_PORT
}

/**
 * Get sleep status for all projects
 */
export function getSleepStatus() {
  const projects = store.getAll()
  const result = {}
  for (const [name, project] of Object.entries(projects)) {
    result[name] = {
      sleeping: project.sleeping || false,
      lastActivity: lastActivity.get(`${name}-app`) || null,
    }
  }
  return result
}
