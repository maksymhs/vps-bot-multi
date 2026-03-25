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

// ── Per-user project store ───────────────────────────────────────────────
// Each user gets: {PROJECTS_DIR}/u_{userId}/projects.json

function userDir(userId) {
  return join(config.projectsDir, `u_${userId}`)
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
    if (users[id]) return users[id]

    const user = {
      userId: id,
      username: info.username || null,
      firstName: info.firstName || null,
      lastName: info.lastName || null,
      createdAt: new Date().toISOString(),
      banned: false,
    }
    users[id] = user
    writeUsers(users)

    // Create user directory
    mkdirSync(userDir(id), { recursive: true })

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

  // Container name includes userId to avoid collisions between users
  containerName(userId, projectName) {
    return `u${userId}-${projectName}-app`
  },

  // Project directory for a specific user's project
  projectDir(userId, projectName) {
    return join(userDir(String(userId)), projectName)
  },

  // ── Global queries (for sleep manager, admin, etc.) ──
  getAllProjectsGlobal() {
    const users = readUsers()
    const result = {}
    for (const userId of Object.keys(users)) {
      const projects = readUserProjects(userId)
      for (const [name, project] of Object.entries(projects)) {
        result[`u${userId}-${name}`] = { ...project, userId, projectName: name }
      }
    }
    return result
  },
}
