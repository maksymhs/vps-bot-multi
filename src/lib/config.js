import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const config = {
  // Paths
  projectsDir: process.env.PROJECTS_DIR ?? '/home/vpsbot/projects',
  get usageFile() {
    return join(process.cwd(), '.claude-usage.json')
  },

  // Network configuration
  // Can be either DOMAIN or IP_ADDRESS + PORT
  get domain() { return process.env.DOMAIN || undefined },
  get ipAddress() { return process.env.IP_ADDRESS || undefined },
  get port() { return parseInt(process.env.PORT ?? '80') },

  // Generate project URL based on network config
  // Multi-user: uses user slug for pretty URLs (e.g. john-myapp.domain.com)
  projectUrl: (slug, name) => {
    const subdomain = `${slug}-${name}`
    if (process.env.DOMAIN) {
      return `https://${subdomain}.${process.env.DOMAIN}`
    } else if (process.env.IP_ADDRESS) {
      const portStr = process.env.PORT && process.env.PORT !== '80' ? `:${process.env.PORT}` : ''
      return `http://${process.env.IP_ADDRESS}${portStr}`
    }
    return `http://localhost:3000`
  },

  // Telegram Bot (REQUIRED for multi-user)
  get botToken() { return process.env.BOT_TOKEN || undefined },

  // Admin Telegram user ID (auto-claimed by first /start if not set)
  _adminUserId: null,
  get adminUserId() {
    if (this._adminUserId) return this._adminUserId
    return process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID) : null
  },

  // Claim admin: set userId as admin and persist to .env
  claimAdmin(userId) {
    this._adminUserId = parseInt(userId)
    process.env.ADMIN_USER_ID = String(userId)
    // Persist to .env file
    try {
      const envPath = join(process.cwd(), '.env')
      if (existsSync(envPath)) {
        let content = readFileSync(envPath, 'utf8')
        if (content.includes('ADMIN_USER_ID=')) {
          content = content.replace(/^ADMIN_USER_ID=.*$/m, `ADMIN_USER_ID=${userId}`)
        } else {
          content += `\nADMIN_USER_ID=${userId}\n`
        }
        writeFileSync(envPath, content)
      }
    } catch {}
  },

  // Multi-user limits
  get maxAppsPerUser() { return parseInt(process.env.MAX_APPS_PER_USER ?? '3') },

  // OpenRouter API — fallback when Claude CLI is rate-limited or unavailable
  get openrouterKey() { return process.env.OPENROUTER_API_KEY || undefined },

  // Build concurrency
  get maxConcurrentBuilds() { return parseInt(process.env.MAX_CONCURRENT_BUILDS ?? '2') },

  // Templates
  get templatesRepo() { return process.env.TEMPLATES_REPO ?? 'https://github.com/maksymhs/vps-bot-templates.git' },
  get templatesDir() { return process.env.TEMPLATES_DIR ?? '/root/vps-bot-templates' },

  // Auto-sleep: forced 30 minutes for multi-user
  get idleTimeout() { return parseInt(process.env.IDLE_TIMEOUT ?? '30') },

  // Caddy Admin API
  caddyAdminUrl: process.env.CADDY_ADMIN_URL ?? 'http://localhost:2019',

  // Docker socket
  dockerSocketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',

  // Verify setup is complete
  isSetupComplete() {
    return !!(this.botToken && (this.domain || this.ipAddress))
  },

  // Get network type
  getNetworkType() {
    if (this.domain) return 'domain'
    if (this.ipAddress) return 'ipport'
    return null
  },

  // Check if a user is admin
  isAdmin(userId) {
    return this.adminUserId && parseInt(userId) === this.adminUserId
  },

  // Check if admin is not yet claimed
  get needsAdmin() {
    return !this.adminUserId || this.adminUserId === 123456789
  },
}
