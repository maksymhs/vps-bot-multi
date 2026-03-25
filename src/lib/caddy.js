import { config } from './config.js'

/**
 * Caddy Admin API wrapper for dynamic routing configuration
 * Currently a skeleton for future integration.
 * Deployments use docker-compose labels for Caddy instead.
 */

export const caddy = {
  /**
   * Get current Caddy configuration
   */
  async getConfig() {
    try {
      const res = await fetch(`${config.caddyAdminUrl}/config/`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      throw new Error(`Caddy Admin API error: ${err.message}`)
    }
  },

  /**
   * Add or update a route for a project
   * @param {string} name - Project name
   * @param {string} upstreamHost - Container IP or hostname
   * @param {number} upstreamPort - Container port (default 3000)
   */
  async addRoute(name, upstreamHost, upstreamPort = 3000) {
    try {
      const domain = `${name}.${config.domain}`
      const route = {
        '@id': `route-${name}`,
        match: [
          {
            host: [domain],
          },
        ],
        handle: [
          {
            handler: 'reverse_proxy',
            upstreams: [
              {
                dial: `${upstreamHost}:${upstreamPort}`,
              },
            ],
          },
        ],
      }

      const res = await fetch(
        `${config.caddyAdminUrl}/config/apps/http/servers/srv0/routes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(route),
        }
      )

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      }

      return route
    } catch (err) {
      throw new Error(`Failed to add route: ${err.message}`)
    }
  },

  /**
   * Remove a route for a project
   * @param {string} name - Project name
   */
  async removeRoute(name) {
    try {
      const res = await fetch(
        `${config.caddyAdminUrl}/config/apps/http/servers/srv0/routes/route-${name}`,
        { method: 'DELETE' }
      )

      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`)
      }
    } catch (err) {
      throw new Error(`Failed to remove route: ${err.message}`)
    }
  },

  /**
   * Check if Caddy Admin API is healthy
   */
  async isHealthy() {
    try {
      const res = await fetch(`${config.caddyAdminUrl}/config/`)
      return res.ok
    } catch {
      return false
    }
  },
}
