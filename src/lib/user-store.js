import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'

// ── Users DB ─────────────────────────────────────────────────────────────
// Global file: {PROJECTS_DIR}/users.json
// Structure: { [telegramUserId]: { username, firstName, createdAt, banned } }

function usersFile() {
  return join(config.projectsDir, 'users.json')
}

function readUsers() {
  if (!existsSync(usersFile())) return {}
  try {
    return JSON.parse(readFileSync(usersFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeUsers(data) {
  mkdirSync(config.projectsDir, { recursive: true })
  writeFileSync(usersFile(), JSON.stringify(data, null, 2))
}

// ── Slug generation ──────────────────────────────────────────────────────
// Slug = Telegram username (lowercase, sanitized) or fallback u{userId}
function makeSlug(info) {
  if (info?.username) {
    return info.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
  }
  if (info?.firstName) {
    const s = info.firstName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15)
    if (s.length >= 2) return s
  }
  return null // will use u{userId} fallback
}

// ── Maintenance mode ────────────────────────────────────────────────────
let _maintenanceMode = false

// ── Last active project per user (conversational context) ───────────────
const _lastProject = new Map()  // userId → projectName

// ── Per-user project store ───────────────────────────────────────────────
// Each user gets: {PROJECTS_DIR}/{slug}/projects.json

function userDir(userId) {
  const users = readUsers()
  const slug = users[String(userId)]?.slug || `u${userId}`
  return join(config.projectsDir, slug)
}

function userProjectsFile(userId) {
  return join(userDir(userId), 'projects.json')
}

function readUserProjects(userId) {
  const file = userProjectsFile(userId)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeUserProjects(userId, data) {
  const dir = userDir(userId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(userProjectsFile(userId), JSON.stringify(data, null, 2))
}

// ── Public API ───────────────────────────────────────────────────────────

export const userStore = {
  // ── User management ──
  getUser(userId) {
    return readUsers()[String(userId)] ?? null
  },

  ensureUser(userId, info = {}) {
    const users = readUsers()
    const id = String(userId)
    if (users[id]) {
      // Update username/slug if user got a new username
      if (info.username && !users[id].slug) {
        const slug = makeSlug(info)
        if (slug) {
          users[id].slug = slug
          users[id].username = info.username
          writeUsers(users)
        }
      }
      return users[id]
    }

    const slug = makeSlug(info) || `u${id}`
    // Check slug uniqueness
    const existingSlugs = Object.values(users).map(u => u.slug)
    const finalSlug = existingSlugs.includes(slug) ? `${slug}${id.slice(-4)}` : slug

    const user = {
      userId: id,
      slug: finalSlug,
      username: info.username || null,
      firstName: info.firstName || null,
      lastName: info.lastName || null,
      createdAt: new Date().toISOString(),
      banned: false,
    }
    users[id] = user
    writeUsers(users)

    // Create user directory using slug
    mkdirSync(join(config.projectsDir, finalSlug), { recursive: true })

    return user
  },

  isUserBanned(userId) {
    const user = this.getUser(userId)
    return user?.banned === true
  },

  banUser(userId) {
    const users = readUsers()
    const id = String(userId)
    if (users[id]) {
      users[id].banned = true
      writeUsers(users)
    }
  },

  unbanUser(userId) {
    const users = readUsers()
    const id = String(userId)
    if (users[id]) {
      users[id].banned = false
      writeUsers(users)
    }
  },

  getAllUsers() {
    return readUsers()
  },

  // ── Per-user project store ──
  getUserDir(userId) {
    return userDir(String(userId))
  },

  getProject(userId, name) {
    return readUserProjects(String(userId))[name] ?? null
  },

  getAllProjects(userId) {
    return readUserProjects(String(userId))
  },

  setProject(userId, name, project) {
    const id = String(userId)
    const data = readUserProjects(id)
    data[name] = { ...data[name], ...project, name, updatedAt: new Date().toISOString() }
    if (!data[name].createdAt) data[name].createdAt = data[name].updatedAt
    writeUserProjects(id, data)
    return data[name]
  },

  deleteProject(userId, name) {
    const id = String(userId)
    const data = readUserProjects(id)
    delete data[name]
    writeUserProjects(id, data)
  },

  countProjects(userId) {
    return Object.keys(readUserProjects(String(userId))).length
  },

  canCreateProject(userId) {
    return this.countProjects(userId) < config.maxAppsPerUser
  },

  // Get user slug for URLs/containers
  getUserSlug(userId) {
    const user = this.getUser(userId)
    return user?.slug || `u${userId}`
  },

  // Container name uses slug for pretty URLs
  containerName(userId, projectName) {
    const slug = this.getUserSlug(userId)
    return `${slug}-${projectName}-app`
  },

  // Project directory for a specific user's project
  projectDir(userId, projectName) {
    return join(userDir(String(userId)), projectName)
  },

  // ── Active project context (in-memory, for conversational flow) ──
  // Remembers the last project a user interacted with so plain text → rebuild
  setLastProject(userId, name) { _lastProject.set(String(userId), name) },
  getLastProject(userId) { return _lastProject.get(String(userId)) ?? null },
  clearLastProject(userId) { _lastProject.delete(String(userId)) },

  // ── Maintenance mode ──
  get maintenanceMode() { return _maintenanceMode },
  setMaintenance(on) { _maintenanceMode = !!on },

  // Check if a project name is already taken by ANY user (for unique URLs)
  isNameTakenGlobally(name) {
    const users = readUsers()
    for (const userId of Object.keys(users)) {
      const projects = readUserProjects(userId)
      if (projects[name]) return true
    }
    return false
  },

  // ── Global queries (for sleep manager, admin, etc.) ──
  getAllProjectsGlobal() {
    const users = readUsers()
    const result = {}
    for (const userId of Object.keys(users)) {
      const slug = users[userId]?.slug || `u${userId}`
      const projects = readUserProjects(userId)
      for (const [name, project] of Object.entries(projects)) {
        result[`${slug}-${name}`] = { ...project, userId, slug, projectName: name }
      }
    }
    return result
  },
}
