import { execFile } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from '../lib/config.js'

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout)
    })
    if (child.stdin) child.stdin.end()
  })
}

export async function initGitRepo(name, gitUrl) {
  const dir = join(config.projectsDir, name)

  try {
    // Check if already a git repo
    await run('git', ['status'], { cwd: dir })
    return true // Already a repo
  } catch {
    // Not a repo, initialize
    try {
      await run('git', ['init'], { cwd: dir })
      await run('git', ['config', 'user.email', 'bot@vps.local'], { cwd: dir })
      await run('git', ['config', 'user.name', 'VPS Bot'], { cwd: dir })

      // Set default branch to main
      await run('git', ['config', 'init.defaultBranch', 'main'], { cwd: dir })

      // Create .gitkeep to ensure there's something to commit
      writeFileSync(join(dir, '.gitkeep'), '')

      await run('git', ['add', '.'], { cwd: dir })
      await run('git', ['commit', '-m', 'Initial commit'], { cwd: dir })

      if (gitUrl) {
        await run('git', ['remote', 'add', 'origin', gitUrl], { cwd: dir })
      }

      return true
    } catch (err) {
      throw new Error(`Error initializing repo: ${err.message}`)
    }
  }
}

export async function gitCommit(name, message = null, token = null) {
  const dir = join(config.projectsDir, name)

  try {
    // Commit changes
    await run('git', ['add', '.'], { cwd: dir })

    const commitMsg = message || `Changes ${new Date().toISOString().slice(0, 16)}`
    try {
      await run('git', ['commit', '-m', commitMsg], { cwd: dir })
      return `✅ Commit: "${commitMsg}"`
    } catch (err) {
      if (err.message.includes('nothing to commit')) {
        return `ℹ️ Nothing to commit`
      }
      throw err
    }
  } catch (err) {
    throw new Error(`Commit error: ${err.message}`)
  }
}

export async function gitPush(name, token = null) {
  const dir = join(config.projectsDir, name)

  try {
    // Check if it's a git repo
    try {
      await run('git', ['status'], { cwd: dir })
    } catch (err) {
      if (err.message.includes('not a git repository')) {
        throw new Error('NO_GIT_REPO')
      }
      throw err
    }

    // Check if remote is configured
    let hasRemote = false
    try {
      const remotes = await run('git', ['remote'], { cwd: dir })
      hasRemote = remotes.trim().length > 0
    } catch {
      hasRemote = false
    }

    if (!hasRemote) {
      return `ℹ️ No remote configured\n\nThis is a local Git repository. To push to GitHub:\n1. Create an empty repo on GitHub\n2. Run: \`git remote add origin <url>\`\n3. Then: \`git push -u origin main\``
    }

    // Auto-commit changes
    await run('git', ['add', '.'], { cwd: dir })

    try {
      await run('git', ['commit', '-m', `Changes ${new Date().toISOString().slice(0, 16)}`], { cwd: dir })
    } catch {
      // Nothing to commit, that's fine
    }

    // Get current branch
    let currentBranch = 'main'
    try {
      currentBranch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).trim()
    } catch {
      // Fall back to 'main'
    }

    let pushCmd = ['push', '-u', 'origin', currentBranch]

    // Use token for authentication if provided
    if (token) {
      try {
        const remoteWithAuth = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir })
        const cleanRemote = remoteWithAuth.trim().replace(/https:\/\/.*@github/, 'https://github')

        if (cleanRemote.includes('github')) {
          const authRemote = cleanRemote.replace('https://', `https://${token}@`)
          await run('git', ['remote', 'set-url', 'origin', authRemote], { cwd: dir })
        }
      } catch {
        // Ignore remote URL errors
      }
    }

    const output = await run('git', pushCmd, { cwd: dir })
    return `✅ Push complete\n\`${output.slice(0, 200)}\``
  } catch (err) {
    if (err.message === 'NO_GIT_REPO') {
      throw new Error('INIT_REPO_NEEDED')
    }
    throw new Error(`Push error: ${err.message}`)
  }
}

export async function gitPull(name, token = null) {
  const dir = join(config.projectsDir, name)

  try {
    // Check if it's a git repo
    try {
      await run('git', ['status'], { cwd: dir })
    } catch (err) {
      if (err.message.includes('not a git repository')) {
        throw new Error('INIT_REPO_NEEDED')
      }
      throw err
    }

    // Check if remote is configured
    let hasRemote = false
    try {
      const remotes = await run('git', ['remote'], { cwd: dir })
      hasRemote = remotes.trim().length > 0
    } catch {
      hasRemote = false
    }

    if (!hasRemote) {
      return `ℹ️ No remote configured\n\nThis is a local Git repository. To sync with GitHub:\n1. Create an empty repo on GitHub\n2. Run: \`git remote add origin <url>\`\n3. Then: \`git pull origin main\``
    }

    // Get current branch
    let currentBranch = 'main'
    try {
      currentBranch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).trim()
    } catch {
      // Fall back to 'main'
    }

    // Use token for authentication if provided
    if (token) {
      try {
        const remoteWithAuth = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir })
        const cleanRemote = remoteWithAuth.trim().replace(/https:\/\/.*@github/, 'https://github')

        if (cleanRemote.includes('github')) {
          const authRemote = cleanRemote.replace('https://', `https://${token}@`)
          await run('git', ['remote', 'set-url', 'origin', authRemote], { cwd: dir })
        }
      } catch {
        // Ignore remote URL errors
      }
    }

    const output = await run('git', ['pull', 'origin', currentBranch], { cwd: dir })
    return `✅ Pull complete\n\`${output.slice(0, 200)}\``
  } catch (err) {
    if (err.message === 'INIT_REPO_NEEDED') {
      throw new Error('INIT_REPO_NEEDED')
    }
    throw new Error(`Pull error: ${err.message}`)
  }
}

export async function gitStatus(name) {
  const dir = join(config.projectsDir, name)

  try {
    const status = await run('git', ['status', '--short'], { cwd: dir })
    const log = await run('git', ['log', '--oneline', '-5'], { cwd: dir })

    return `📊 *Status Git*

*Changes:*
\`${status || 'No changes'}\`

*Recent commits:*
\`${log}\``
  } catch (err) {
    if (err.message.includes('not a git repository')) {
      throw new Error('INIT_REPO_NEEDED')
    }
    throw new Error(`Status error: ${err.message}`)
  }
}

export async function getGitRemote(name) {
  const dir = join(config.projectsDir, name)

  try {
    const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir })
    return remote.trim()
  } catch {
    return null
  }
}
