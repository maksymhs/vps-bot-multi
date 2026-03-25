import inquirer from 'inquirer'
import chalk from 'chalk'
import { execSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { config } from '../lib/config.js'
import { getDocker } from '../lib/docker-client.js'
import { store } from '../lib/store.js'
import { buildingSet } from '../lib/build-state.js'
import { log } from '../lib/logger.js'
import { getCodeServerUrl, ensureCodeServer } from '../lib/code-server.js'
import { gitPush, gitPull, gitStatus, initGitRepo, gitCommit } from '../commands/git.js'
import { wakeContainer } from '../lib/sleep-manager.js'
import { printHeader, startSpinner, stopSpinner, cliCtx, updateEnvVar } from './ui.js'

// ── Project list ─────────────────────────────────────────────────────────────

export async function showProjects(nav) {
  printHeader('Projects')
  const projects = store.getAll()
  const names = Object.keys(projects)

  if (!names.length) {
    console.log(chalk.yellow('\nNo projects yet. Use "Create New Project" to get started.\n'))
    await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back to menu'] }])
    return nav.mainMenu()
  }

  const projectChoices = await Promise.all(names.map(async (n) => {
    const p = projects[n]
    let icon = '⚪'
    try {
      const cs = await getDocker().listContainers({ all: true, filters: JSON.stringify({ name: [`${n}-app`] }) })
      const state = cs[0]?.State
      icon = state === 'running' ? '🟢' : (p.sleeping ? '🌙' : '🔴')
    } catch {}
    return { name: `${icon} ${n}`, value: n }
  }))

  const { name } = await inquirer.prompt([{
    type: 'list',
    name: 'name',
    message: 'Select a project:',
    loop: false,
    choices: [...projectChoices, new inquirer.Separator(), 'Back'],
  }])

  if (name === 'Back') return nav.mainMenu()
  return showProjectMenu(nav, name)
}

// ── Project menu ─────────────────────────────────────────────────────────────

async function showProjectMenu(nav, name) {
  printHeader(name)
  const project = store.get(name)
  if (!project) {
    console.log(chalk.red(`\nProject "${name}" not found.\n`))
    return showProjects(nav)
  }

  try {
    const containers = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [`${name}-app`] }),
    })
    const status = containers[0]?.State ?? 'unknown'
    const isSleeping = project.sleeping && status !== 'running'
    const statusStr = isSleeping ? chalk.yellow('sleeping') : status === 'running' ? chalk.green('running') : chalk.red('stopped')

    console.log(`  Status: ${statusStr}\n`)

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: `Project: ${name}`,
      loop: false,
      choices: [
        { name: 'View Logs', value: 'logs' },
        ...(isSleeping
          ? [{ name: '☀️  Wake', value: 'wake' }]
          : status === 'running'
            ? [{ name: 'Stop', value: 'stop' }]
            : [{ name: 'Start', value: 'start' }]),
        { name: 'Rebuild', value: 'rebuild' },
        { name: 'Code-Server (IDE)', value: 'codeserver' },
        { name: 'Git', value: 'git' },
        { name: 'Copy URL', value: 'url' },
        new inquirer.Separator(),
        { name: 'Delete Project', value: 'delete' },
        { name: 'Back', value: 'back' },
      ],
    }])

    if (action === 'back') return showProjects(nav)
    if (action === 'url') {
      printHeader(`URL — ${name}`)
      const url = project.url || (project.port ? `http://${config.ipAddress || 'localhost'}:${project.port}` : '(no URL)')
      console.log(`  ${url}\n`)
      await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
      return showProjectMenu(nav, name)
    }
    if (action === 'logs') {
      await showLogs(name)
      return showProjectMenu(nav, name)
    }
    if (action === 'stop') {
      await stopContainer(name)
      return showProjectMenu(nav, name)
    }
    if (action === 'start') {
      await startContainer(name)
      return showProjectMenu(nav, name)
    }
    if (action === 'wake') {
      startSpinner('Waking up...')
      const ok = await wakeContainer(name)
      stopSpinner(ok ? `${name} is awake` : `Failed to wake ${name}`, ok)
      return showProjectMenu(nav, name)
    }
    if (action === 'rebuild') {
      await rebuildProject(nav, name)
      return showProjectMenu(nav, name)
    }
    if (action === 'codeserver') {
      await openProjectCodeServer(name)
      return showProjectMenu(nav, name)
    }
    if (action === 'git') {
      await showGitMenu(name)
      return showProjectMenu(nav, name)
    }
    if (action === 'delete') {
      await deleteProject(name)
      return showProjects(nav)
    }
  } catch (err) {
    log.error(`[cli] project action failed for ${name}`, err.message)
    console.error(chalk.red(`\nError: ${err.message}\n`))
    return showProjects(nav)
  }
}

// ── Logs ─────────────────────────────────────────────────────────────────────

async function showLogs(name) {
  printHeader(`Logs — ${name}`)
  try {
    const containers = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [`${name}-app`] }),
    })
    if (!containers.length) {
      console.log(chalk.yellow('  No container found.\n'))
    } else {
      const stream = await getDocker().getContainer(containers[0].Id).logs({ stdout: true, stderr: true, tail: 40 })
      const text = (Buffer.isBuffer(stream) ? stream.toString() : String(stream)).trim() || '(no logs)'
      console.log(text)
      console.log()
    }
  } catch (err) {
    console.log(chalk.red(`  Error: ${err.message}\n`))
  }
  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
}

// ── Container start/stop ─────────────────────────────────────────────────────

async function stopContainer(name) {
  try {
    const containers = await getDocker().listContainers({
      filters: JSON.stringify({ name: [`${name}-app`] }),
    })
    if (!containers.length) {
      console.log(chalk.yellow(`\nNo running container for "${name}".\n`))
      return
    }
    await getDocker().getContainer(containers[0].Id).stop()
    console.log(chalk.green(`\n${name} stopped.\n`))
  } catch (err) {
    console.error(chalk.red(`\nError stopping container: ${err.message}\n`))
  }
}

async function startContainer(name) {
  try {
    const containers = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [`${name}-app`] }),
    })
    if (!containers.length) {
      console.log(chalk.yellow(`\nNo container found for "${name}".\n`))
      return
    }
    await getDocker().getContainer(containers[0].Id).start()
    console.log(chalk.green(`\n${name} started.\n`))
  } catch (err) {
    console.error(chalk.red(`\nError starting container: ${err.message}\n`))
  }
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

async function rebuildProject(nav, name) {
  const project = store.get(name)
  if (!project) {
    console.log(chalk.red(`\nProject "${name}" not found.\n`))
    return
  }

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: 'Rebuild mode:',
    choices: [
      { name: 'Patch — add changes to existing code', value: 'patch' },
      { name: 'Full — regenerate from scratch', value: 'full' },
      { name: 'Cancel', value: 'cancel' },
    ],
  }])

  if (mode === 'cancel') return

  const { desc } = await inquirer.prompt([{
    type: 'input',
    name: 'desc',
    message: mode === 'patch' ? 'What changes do you want?' : 'New full description:',
    validate: (input) => input ? true : 'Description is required',
  }])

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Select model:',
    choices: [
      { name: 'Sonnet (recommended)', value: 'claude-sonnet-4-6' },
      { name: 'Opus (more powerful)', value: 'claude-opus-4-6' },
      { name: 'Haiku (fastest)', value: 'claude-haiku-4-5-20251001' },
    ],
  }])

  const description = mode === 'patch'
    ? `${project.description}\n\nRequested changes: ${desc}`
    : desc

  console.log(chalk.cyan(`\n  Rebuilding ${chalk.bold(name)}\n`))

  try {
    const { deployRebuild } = await import('../commands/projects.js')
    const ok = await deployRebuild(cliCtx, name, description, model, mode)
    stopSpinner()
    if (!ok) {
      console.log(chalk.red(`\n  ✗ Rebuild failed.\n`))
    }
  } catch (err) {
    stopSpinner(`Rebuild failed: ${err.message}`, false)
  }

  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Continue'] }])
}

// ── New project ──────────────────────────────────────────────────────────────

export async function showNewProject(nav) {
  printHeader('New Project')

  let claudeInstalled = false
  try {
    execSync("su - vpsbot -c 'claude --version'", { stdio: 'ignore' })
    claudeInstalled = true
  } catch {}

  if (!claudeInstalled) {
    console.log(chalk.red('\n⚠ Claude Code CLI not installed.\n'))
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Claude Code is required to create projects:',
      loop: false,
      choices: [
        { name: 'Install & configure Claude Code', value: 'install' },
        { name: 'Back to menu', value: 'back' },
      ],
    }])
    if (action === 'install') {
      console.log(chalk.yellow('\nInstalling Claude Code CLI...\n'))
      try {
        execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'inherit' })
        try {
          const cliPath = execSync('which claude', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
          updateEnvVar('CLAUDE_CLI', cliPath)
        } catch {}
        claudeInstalled = true
      } catch {
        console.log(chalk.red('\n✗ Installation failed.\n'))
        return nav.mainMenu()
      }
    } else {
      return nav.mainMenu()
    }
  }

  let claudeLoggedIn = false
  try {
    execSync("su - vpsbot -c 'claude auth status'", { stdio: 'ignore' })
    claudeLoggedIn = true
  } catch {}

  if (!claudeLoggedIn) {
    console.log(chalk.yellow('\n⚠ Claude Code not logged in. You need to authenticate first.\n'))
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Login to Claude:',
      loop: false,
      choices: [
        { name: 'Login now (opens auth URL)', value: 'login' },
        { name: 'Back to menu', value: 'back' },
      ],
    }])
    if (action === 'login') {
      try {
        execSync("su - vpsbot -c 'claude login'", { stdio: 'inherit' })
        execSync("su - vpsbot -c 'claude auth status'", { stdio: 'ignore' })
        console.log(chalk.green('\n✓ Claude authenticated!\n'))
      } catch {
        console.log(chalk.red('\n✗ Login failed or cancelled. Cannot create project without authentication.\n'))
        return nav.mainMenu()
      }
    } else {
      return nav.mainMenu()
    }
  }

  const { name: rawName, description } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Project name:',
      validate: (input) => input ? true : 'Name is required',
    },
    {
      type: 'input',
      name: 'description',
      message: 'Describe what the app should do:',
      validate: (input) => input ? true : 'Description is required',
    },
  ])

  const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  if (store.get(name)) {
    console.log(chalk.yellow(`\nProject "${name}" already exists. Use rebuild instead.\n`))
    return nav.mainMenu()
  }

  const { model } = await inquirer.prompt([{
    type: 'list',
    name: 'model',
    message: 'Select model:',
    loop: false,
    choices: [
      { name: 'Sonnet (recommended)', value: 'claude-sonnet-4-6' },
      { name: 'Opus (more powerful)', value: 'claude-opus-4-6' },
      { name: 'Haiku (fastest)', value: 'claude-haiku-4-5-20251001' },
    ],
  }])

  const modelLabel = model.includes('opus') ? 'Opus' : model.includes('haiku') ? 'Haiku' : 'Sonnet'
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: `Create "${name}" with ${modelLabel}?`,
    loop: false,
    choices: [
      { name: '→ Create project', value: 'go' },
      { name: '← Back', value: 'back' },
    ],
  }])

  if (action === 'back') return nav.mainMenu()

  console.log(chalk.cyan(`\n  Creating ${chalk.bold(name)}\n`))

  try {
    const { deployNew } = await import('../commands/projects.js')
    buildingSet.add(name)
    const ok = await deployNew(cliCtx, name, description, model)
    buildingSet.delete(name)
    stopSpinner()
    if (!ok) {
      console.log(chalk.red(`\n  ✗ Project creation failed.\n`))
    }
  } catch (err) {
    buildingSet.delete(name)
    stopSpinner(`Creation failed: ${err.message}`, false)
  }

  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back to menu'] }])
  return nav.mainMenu()
}

// ── Code-Server (project) ────────────────────────────────────────────────────

async function openProjectCodeServer(name) {
  printHeader(`Code-Server — ${name}`)
  try {
    const result = await ensureCodeServer()
    if (!result.success) {
      console.log(chalk.red(`  ✗ ${result.message}\n`))
    } else {
      const url = getCodeServerUrl(name)
      console.log(chalk.green(`  ✓ Running`))
      console.log(`  URL:      ${url}`)
      console.log(`  Password: ${config.codeServerPassword}\n`)
    }
  } catch (err) {
    console.log(chalk.red(`  Error: ${err.message}\n`))
  }
  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
}

// ── Git menu ─────────────────────────────────────────────────────────────────

async function showGitMenu(name) {
  printHeader(`Git — ${name}`)
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: `Git: ${name}`,
    loop: false,
    choices: [
      { name: 'Status', value: 'status' },
      { name: 'Push', value: 'push' },
      { name: 'Pull', value: 'pull' },
      { name: 'Commit', value: 'commit' },
      { name: 'Init Repository', value: 'init' },
      new inquirer.Separator(),
      { name: 'Back', value: 'back' },
    ],
  }])

  if (action === 'back') return

  async function gitSubsection(title, fn) {
    printHeader(`Git ${title} — ${name}`)
    try {
      await fn()
    } catch (err) {
      if (err.message === 'INIT_REPO_NEEDED') {
        console.log(chalk.yellow('  ⚠ Not a Git repository. Use "Init Repository" first.\n'))
      } else {
        console.log(chalk.red(`  Error: ${err.message}\n`))
      }
    }
    await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
    return showGitMenu(name)
  }

  if (action === 'status') {
    return gitSubsection('Status', async () => {
      const result = await gitStatus(name)
      const plain = result.replace(/\*/g, '').replace(/`/g, '')
      console.log(`${plain}\n`)
    })
  }

  if (action === 'push') {
    return gitSubsection('Push', async () => {
      const result = await gitPush(name)
      const plain = result.replace(/\*/g, '').replace(/`/g, '')
      console.log(chalk.green(`${plain}\n`))
    })
  }

  if (action === 'pull') {
    return gitSubsection('Pull', async () => {
      const result = await gitPull(name)
      const plain = result.replace(/\*/g, '').replace(/`/g, '')
      console.log(chalk.green(`${plain}\n`))
    })
  }

  if (action === 'commit') {
    const { message } = await inquirer.prompt([{
      type: 'input',
      name: 'message',
      message: 'Commit message:',
      validate: (input) => input ? true : 'Message is required',
    }])
    return gitSubsection('Commit', async () => {
      const result = await gitCommit(name, message)
      console.log(chalk.green(`  ${result}\n`))
    })
  }

  if (action === 'init') {
    const { gitUrl } = await inquirer.prompt([{
      type: 'input',
      name: 'gitUrl',
      message: 'Remote URL (leave empty for local only):',
    }])
    return gitSubsection('Init', async () => {
      await initGitRepo(name, gitUrl || null)
      console.log(chalk.green(`  ✓ Repository initialized${gitUrl ? ` (remote: ${gitUrl})` : ''}\n`))
    })
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────

async function deleteProject(name) {
  const { confirm } = await inquirer.prompt([{
    type: 'list',
    name: 'confirm',
    message: `Delete "${name}"? This removes the container, image, and all files.`,
    loop: false,
    choices: [
      { name: 'Yes, delete', value: true },
      { name: 'Cancel', value: false },
    ],
  }])

  if (!confirm) return

  try {
    const dir = join(config.projectsDir, name)
    try {
      execSync(`docker compose down --rmi local`, { cwd: dir, stdio: 'ignore' })
    } catch {}
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
    store.delete(name)
    console.log(chalk.green(`\n✓ "${name}" deleted.\n`))
  } catch (err) {
    console.log(chalk.red(`\nError deleting project: ${err.message}\n`))
  }
}
