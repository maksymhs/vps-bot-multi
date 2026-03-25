import { log } from './logger.js'
import { config } from './config.js'

const queue = []
let running = 0

/**
 * Enqueue a build job. Returns a promise that resolves when the job completes.
 * Jobs run with limited concurrency (MAX_CONCURRENT_BUILDS).
 */
export function enqueueBuild(jobId, fn) {
  return new Promise((resolve, reject) => {
    queue.push({ jobId, fn, resolve, reject })
    log.info(`[queue] enqueued ${jobId} (queue=${queue.length}, running=${running})`)
    processQueue()
  })
}

function processQueue() {
  while (running < config.maxConcurrentBuilds && queue.length > 0) {
    const job = queue.shift()
    running++
    log.info(`[queue] starting ${job.jobId} (running=${running}, waiting=${queue.length})`)

    job.fn()
      .then(result => job.resolve(result))
      .catch(err => job.reject(err))
      .finally(() => {
        running--
        log.info(`[queue] finished ${job.jobId} (running=${running}, waiting=${queue.length})`)
        processQueue()
      })
  }
}

/**
 * Get current queue status
 */
export function getQueueStatus() {
  return { running, waiting: queue.length, max: config.maxConcurrentBuilds }
}

/**
 * Get position of a job in the queue (0 = running, 1+ = waiting)
 */
export function getQueuePosition(jobId) {
  const idx = queue.findIndex(j => j.jobId === jobId)
  if (idx === -1) return 0 // already running or not found
  return idx + 1
}
