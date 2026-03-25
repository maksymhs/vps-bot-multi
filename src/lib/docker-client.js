import Docker from 'dockerode'
import { config } from './config.js'

let _instance = null

/**
 * Get the singleton Docker client instance
 */
export function getDocker() {
  if (!_instance) {
    _instance = new Docker({ socketPath: config.dockerSocketPath })
  }
  return _instance
}

/**
 * Reset the Docker client (for testing or manual reset)
 */
export function resetDockerClient() {
  _instance = null
}
