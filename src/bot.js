import 'dotenv/config'
import { Telegraf } from 'telegraf'
import { execFile } from 'child_process'
import { statusCommand } from './commands/status.js'
import { psCommand, logsCommand, restartCommand, stopCommand, startCommand } from './commands/docker.js'
import { newCommand, rebuildCommand, listCommand, urlCommand, deleteProjectCommand, deployNew, deployRebuild, projectUrl } from './commands/projects.js'
import { showMain, showList, showProject, showDeleteConfirm, startNewFlow, pendingNew, startRebuildFlow, startRebuildPatch, startRebuildFull, pendingRebuild, showModelSelect, showGitMenu } from './commands/menu.js'
import { store } from './lib/store.js'
import { getUsageText } from './lib/usage.js'
import { gitPush, gitPull, gitStatus, initGitRepo, gitCommit } from './commands/git.js'
import { getDocker } from './lib/docker-client.js'
import { buildingSet } from './lib/build-state.js'
import { config } from './lib/config.js'
import { getBanner } from './lib/branding.js'
import { getCodeServerUrl, ensureCodeServer } from './lib/code-server.js'
import { startSleepManager, stopSleepManager, reconcileSleepState } from './lib/sleep-manager.js'
import { existsSync, rmSync } from 'fs'
import chalk from 'chalk'

const bot = new Telegraf(process.env.BOT_TOKEN)
const ALLOWED_CHAT_ID = config.chatId
const pendingGitInit = new Map()
const pendingGitCommit = new Map()

// Sends a project menu as a new message (not edit)
async function sendProjectMenu(ctx, name) {
  const { Markup } = await import('telegraf')
  const project = store.get(name)
  if (!project) return
  const containers = await getDocker().listContainers({ all: true, filters: JSON.stringify({ name: [`${name}-app`] }) }).catch(() => [])
  const status = containers[0]?.State ?? 'unknown'
  const icon = status === 'running' ? '🟢' : '🔴'
  const desc = (project.description ?? '').slice(0, 120)
  const toggleBtn = status === 'running'
    ? Markup.button.callback('🛑 Stop', `st:${name}`)
    : Markup.button.callback('▶️ Start', `go:${name}`)
  return ctx.reply(`📦 *${name}*  ${icon}\n\n🔗 ${project.url}\n_${desc}_`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('♻️ Rebuild', `rb:${name}`), Markup.button.callback('📋 Logs', `lg:${name}`)],
      [toggleBtn, Markup.button.callback('🔗 Copy URL', `url:${name}`)],
      [Markup.button.callback('🗑️ Delete', `del:${name}`), Markup.button.callback('⬅️ List', 'list')],
    ]),
  })
}

// ── Auth middleware ────────────────────────────────────────────────────────

bot.use((ctx, next) => {
  if (ctx.chat?.id !== ALLOWED_CHAT_ID) return ctx.reply('⛔ Unauthorized')
  return next()
})

// ── Text commands ──────────────────────────────────────────────────────────

bot.start((ctx) => showMain(ctx))

bot.command('menu', (ctx) => showMain(ctx))
bot.command('status', statusCommand)
bot.command('ps', psCommand)
bot.command('logs', logsCommand)
bot.command('restart', restartCommand)
bot.command('stop', stopCommand)
bot.command('start', startCommand)
bot.command('new', newCommand)
bot.command('rebuild', rebuildCommand)
bot.command('list', (ctx) => listCommand(ctx))
bot.command('url', urlCommand)
bot.command('delete', deleteProjectCommand)

// ── Conversational flow (new project via buttons) ──────────────────────────

bot.on('text', async (ctx, next) => {
  // Rebuild flow
  const rebuildState = pendingRebuild.get(ctx.chat.id)
  if (rebuildState && rebuildState.step === 'text') {
    const { name, mode } = rebuildState
    const project = store.get(name)
    if (!project) { pendingRebuild.delete(ctx.chat.id); return ctx.reply(`Project "${name}" not found.`) }

    const input = ctx.message.text.trim()
    const description = mode === 'patch'
      ? `${project.description}\n\nRequested changes: ${input}`
      : input

    pendingRebuild.set(ctx.chat.id, { name, mode, description, step: 'model' })
    return showModelSelect(ctx, 'rbm', name)
  }

  // Git init flow
  const gitInitState = pendingGitInit.get(ctx.chat.id)
  if (gitInitState) {
    const { name } = gitInitState
    const gitUrl = ctx.message.text.trim()

    if (gitUrl.toLowerCase() === 'skip') {
      pendingGitInit.delete(ctx.chat.id)
      await ctx.reply(`⏭️ Initializing without remote URL`)
      const finalGitUrl = null
    } else {
      if (!gitUrl.startsWith('http')) {
        return ctx.reply('❌ Invalid URL. Must start with http:// or https://')
      }
      var finalGitUrl = gitUrl
    }

    pendingGitInit.delete(ctx.chat.id)

    try {
      await ctx.reply(`⚙️ Initializing Git repository...`)
      await initGitRepo(name, finalGitUrl)
      await ctx.reply(`✅ Repository initialized${finalGitUrl ? `\n🔗 Remote: \`${finalGitUrl}\`` : ''}`, { parse_mode: 'Markdown' })
      return
    } catch (err) {
      await ctx.reply(`❌ Git init error: ${err.message}`, { parse_mode: 'Markdown' })
      return
    }
  }

  // Git commit flow
  const gitCommitState = pendingGitCommit.get(ctx.chat.id)
  if (gitCommitState && gitCommitState.step === 'message') {
    const { name } = gitCommitState
    const message = ctx.message.text.trim()

    pendingGitCommit.delete(ctx.chat.id)

    try {
      await ctx.reply(`💬 Creating commit...`)
      const result = await gitCommit(name, message)
      await ctx.reply(result, { parse_mode: 'Markdown' })
      return
    } catch (err) {
      await ctx.reply(`❌ Commit error: ${err.message}`, { parse_mode: 'Markdown' })
      return
    }
  }

  const state = pendingNew.get(ctx.chat.id)
  if (!state) return next()

  if (state.step === 'name') {
    const name = ctx.message.text.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
    if (!name) return ctx.reply('Invalid name. Only letters, numbers, and hyphens.')
    if (store.get(name)) {
      return ctx.reply(`"${name}" already exists. Pick another name or /menu to cancel.`)
    }
    pendingNew.set(ctx.chat.id, { step: 'desc', name })
    return ctx.reply(`✅ Name: *${name}*\n\nDescribe what the app should do:`, { parse_mode: 'Markdown' })
  }

  if (state.step === 'desc') {
    const { name } = state
    const description = ctx.message.text.trim()
    pendingNew.set(ctx.chat.id, { step: 'model', name, description })
    return showModelSelect(ctx, 'nbm', name)
  }

})

// ── Inline button actions ──────────────────────────────────────────────────

function answer(ctx) {
  return ctx.answerCbQuery().catch(() => {})
}

// Navigation
bot.action('main', async (ctx) => { await answer(ctx); await showMain(ctx, true) })
bot.action('list', async (ctx) => { await answer(ctx); await showList(ctx) })
bot.action('usage', async (ctx) => {
  await answer(ctx)
  const { Markup } = await import('telegraf')
  const text = getUsageText()
  await ctx.editMessageText(text + '\n\n⬅️ _Back to menu_', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'main')]]),
  })
})

// Git operations
bot.action(/^gp:(.+)$/, async (ctx) => {
  await answer(ctx)
  const { Markup } = await import('telegraf')
  const name = ctx.match[1]
  await ctx.editMessageText(`📤 *Pushing...*`, { parse_mode: 'Markdown' })
  try {
    const result = await gitPush(name)
    await ctx.editMessageText(`${result}\n\n⬅️ _Back to project_`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `p:${name}`)]])
    })
  } catch (err) {
    if (err.message === 'INIT_REPO_NEEDED') {
      await ctx.editMessageText(`⚠️ *Repository not initialized*\n\nInitialize Git?`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ Initialize', `git_init:${name}`)]])
      })
    } else {
      await ctx.editMessageText(`❌ Error: ${err.message.slice(0, 200)}`, { parse_mode: 'Markdown' })
    }
  }
})

bot.action(/^gpl:(.+)$/, async (ctx) => {
  await answer(ctx)
  const { Markup } = await import('telegraf')
  const name = ctx.match[1]
  await ctx.editMessageText(`📥 *Pulling...*`, { parse_mode: 'Markdown' })
  try {
    const result = await gitPull(name)
    await ctx.editMessageText(`${result}\n\n⬅️ _Back to project_`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `p:${name}`)]])
    })
  } catch (err) {
    if (err.message === 'INIT_REPO_NEEDED') {
      await ctx.editMessageText(`⚠️ *Repository not initialized*\n\nInitialize Git?`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ Initialize', `git_init:${name}`)]])
      })
    } else {
      await ctx.editMessageText(`❌ Error: ${err.message.slice(0, 200)}`, { parse_mode: 'Markdown' })
    }
  }
})

bot.action(/^gs:(.+)$/, async (ctx) => {
  await answer(ctx)
  const { Markup } = await import('telegraf')
  const name = ctx.match[1]
  try {
    const result = await gitStatus(name)
    await ctx.editMessageText(`${result}\n\n⬅️ _Back to project_`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `p:${name}`)]])
    })
  } catch (err) {
    if (err.message === 'INIT_REPO_NEEDED') {
      await ctx.editMessageText(`⚠️ *Repository not initialized*\n\nInitialize Git?`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ Initialize', `git_init:${name}`)]])
      })
    } else {
      await ctx.editMessageText(`❌ Error: ${err.message.slice(0, 200)}`, { parse_mode: 'Markdown' })
    }
  }
})

// Git menu
bot.action(/^git_menu:(.+)$/, async (ctx) => {
  await answer(ctx)
  await showGitMenu(ctx, ctx.match[1])
})

// Initialize repository
bot.action(/^git_init:(.+)$/, async (ctx) => {
  await answer(ctx)
  const name = ctx.match[1]
  const { Markup } = await import('telegraf')
  await ctx.editMessageText(`🔧 *Init Git Repo*\n\nPublic or Private?`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🌍 Public', `git_pub:${name}`), Markup.button.callback('🔒 Private', `git_priv:${name}`)],
      [Markup.button.callback('⬅️ Back', `git_menu:${name}`)],
    ]),
  })
})

bot.action(/^git_pub:(.+)$/, async (ctx) => {
  await answer(ctx)
  const name = ctx.match[1]
  pendingGitInit.set(ctx.chat.id, { name, private: false })
  await ctx.editMessageText(`📝 *Enter public repo URL*\n\n_Or type "skip" to skip_\n\nExample: https://github.com/user/repo.git`, {
    parse_mode: 'Markdown'
  })
})

bot.action(/^git_priv:(.+)$/, async (ctx) => {
  await answer(ctx)
  const name = ctx.match[1]
  pendingGitInit.set(ctx.chat.id, { name, private: true })
  await ctx.editMessageText(`📝 *Enter private repo URL*\n\n_Or type "skip" to skip_\n\nExample: https://github.com/user/repo.git`, {
    parse_mode: 'Markdown'
  })
})

// Custom commit
bot.action(/^git_commit:(.+)$/, async (ctx) => {
  await answer(ctx)
  const name = ctx.match[1]
  pendingGitCommit.set(ctx.chat.id, { name, step: 'message' })
  await ctx.editMessageText(`💬 *Enter commit message*\n\nExample: "Add form validation"`, {
    parse_mode: 'Markdown'
  })
})

bot.action('status', async (ctx) => {
  await answer(ctx)
  // Run status and show result + back button inline
  const { Markup } = await import('telegraf')
  const si = await import('systeminformation')
  const [cpu, mem, disk] = await Promise.all([si.default.currentLoad(), si.default.mem(), si.default.fsSize()])
  const gb = b => (b / 1024 ** 3).toFixed(1)
  const pct = n => Math.round(n)
  const d = disk.find(d => d.mount === '/') || disk[0]
  const text =
    `🖥 *Server Status*\n\n` +
    `*CPU:* ${pct(cpu.currentLoad)}%\n` +
    `*RAM:* ${gb(mem.used)}GB / ${gb(mem.total)}GB (${pct(mem.used / mem.total * 100)}%)\n` +
    `*Disk:* ${gb(d.used)}GB / ${gb(d.size)}GB (${pct(d.use)}%)`
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'main')]]),
  })
})
bot.action('codeserver', async (ctx) => {
  await answer(ctx)
  const { Markup } = await import('telegraf')
  try {
    const result = await ensureCodeServer()
    if (!result.success) {
      await ctx.editMessageText(`❌ ${result.message}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'main')]]),
      })
      return
    }
    const url = getCodeServerUrl('')
    const baseUrl = result.url
    const pass = config.codeServerPassword
    await ctx.editMessageText(
      `💻 *Code-Server*\n\n🔗 \`${baseUrl}\`\n🔑 Pass: \`${pass}\`\n\n_Click to open VS Code in the browser_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🌐 Open Code-Server', baseUrl)],
          [Markup.button.callback('⬅️ Menu', 'main')],
        ]),
      }
    )
  } catch (err) {
    await ctx.editMessageText(`❌ Error: ${err.message}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'main')]]),
    })
  }
})
bot.action('ps', async (ctx) => {
  await answer(ctx)
  const { Markup } = await import('telegraf')
  const containers = await getDocker().listContainers({ all: true })
  const lines = containers.length
    ? containers.map(c => {
        const n = c.Names[0].replace('/', '')
        const icon = c.State === 'running' ? '🟢' : '🔴'
        return `${icon} \`${n}\` — ${c.Status}`
      }).join('\n')
    : 'No containers found.'
  await ctx.editMessageText(lines, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'main')]]),
  })
})

// New project
bot.action('new', async (ctx) => { await answer(ctx); await startNewFlow(ctx) })

// Project menu
bot.action(/^p:(.+)$/, async (ctx) => {
  await answer(ctx)
  await showProject(ctx, ctx.match[1])
})

// Rebuild — ask for changes first
bot.action(/^rb:(.+)$/, async (ctx) => {
  await answer(ctx)
  const name = ctx.match[1]
  if (!store.get(name)) return ctx.editMessageText(`Project "${name}" not found.`)
  if (buildingSet.has(name)) return ctx.answerCbQuery('Already building...', { show_alert: true })
  await startRebuildFlow(ctx, name)
})

// Rebuild — pick mode
bot.action(/^rb_patch:(.+)$/, async (ctx) => {
  await answer(ctx)
  await startRebuildPatch(ctx, ctx.match[1])
})

bot.action(/^rb_full:(.+)$/, async (ctx) => {
  await answer(ctx)
  await startRebuildFull(ctx, ctx.match[1])
})

// Logs
bot.action(/^lg:(.+)$/, async (ctx) => {
  await answer(ctx)
  const { Markup } = await import('telegraf')
  const name = ctx.match[1]
  try {
    const containers = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [`${name}-app`] }),
    })
    if (!containers.length) return ctx.editMessageText(`Container "${name}" not found.`)
    const stream = await getDocker().getContainer(containers[0].Id).logs({ stdout: true, stderr: true, tail: 40 })
    const text = (Buffer.isBuffer(stream) ? stream.toString() : String(stream)).slice(-3500).trim() || '(no logs)'
    await ctx.editMessageText(`\`\`\`\n${text}\n\`\`\``, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', `lg:${name}`), Markup.button.callback('⬅️ Project', `p:${name}`)],
      ]),
    })
  } catch (err) {
    await ctx.editMessageText(`Error: ${err.message}`)
  }
})

// Stop
bot.action(/^st:(.+)$/, async (ctx) => {
  await answer(ctx)
  const name = ctx.match[1]
  try {
    const containers = await getDocker().listContainers({ filters: JSON.stringify({ name: [`${name}-app`] }) })
    if (containers.length) await getDocker().getContainer(containers[0].Id).stop()
    await showProject(ctx, name)
  } catch (err) {
    await ctx.answerCbQuery(`Error: ${err.message}`, { show_alert: true })
    await showProject(ctx, name)
  }
})

// Start
bot.action(/^go:(.+)$/, async (ctx) => {
  await answer(ctx)
  const name = ctx.match[1]
  try {
    const containers = await getDocker().listContainers({ all: true, filters: JSON.stringify({ name: [`${name}-app`] }) })
    if (containers.length) await getDocker().getContainer(containers[0].Id).start()
    await showProject(ctx, name)
  } catch (err) {
    await ctx.answerCbQuery(`Error: ${err.message}`, { show_alert: true })
    await showProject(ctx, name)
  }
})

// URL
bot.action(/^url:(.+)$/, async (ctx) => {
  const name = ctx.match[1]
  const project = store.get(name)
  await ctx.answerCbQuery(project ? project.url : 'Not found', { show_alert: true }).catch(() => {})
})

// Code-Server
bot.action(/^cs:(.+)$/, async (ctx) => {
  const { Markup } = await import('telegraf')
  const name = ctx.match[1]
  const project = store.get(name)

  if (!project) {
    await ctx.answerCbQuery('Project not found', { show_alert: true })
    return
  }

  try {
    // Ensure global code-server is running
    await ctx.editMessageText(`🚀 Starting Code-Server...`, { parse_mode: 'Markdown' })
    const result = await ensureCodeServer()
    if (!result.success) {
      await ctx.editMessageText(`❌ Error: ${result.message}`, { parse_mode: 'Markdown' })
      await showProject(ctx, name)
      return
    }

    // Get project-specific URL (opens folder)
    const url = getCodeServerUrl(name)

    const msg = `💻 *Code-Server - ${name}*\n\n🔗 \`${url}\`\n\n_Click to open the project in VS Code_`
    await ctx.editMessageText(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('🌐 Open Code-Server', url)],
        [Markup.button.callback('⬅️ Back', `p:${name}`)],
      ]),
    })
  } catch (err) {
    console.error('Code-Server error:', err)
    await ctx.editMessageText(`❌ Code-Server error: ${err.message}`, { parse_mode: 'Markdown' })
    await showProject(ctx, name)
  }
})

// Delete confirm
bot.action(/^del:(.+)$/, async (ctx) => {
  await answer(ctx)
  await showDeleteConfirm(ctx, ctx.match[1])
})

// Delete confirmed
bot.action(/^del_ok:(.+)$/, async (ctx) => {
  await answer(ctx)
  const { Markup } = await import('telegraf')
  const name = ctx.match[1]
  const project = store.get(name)
  if (!project) return ctx.editMessageText('Project not found.')

  await ctx.editMessageText(`🗑️ Deleting *${name}*...`, { parse_mode: 'Markdown' })

  try {
    const dir = `${config.projectsDir}/${name}`
    await new Promise((res) => {
      execFile('docker', ['compose', 'down', '--rmi', 'local'], { cwd: dir }, () => res())
    })

    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    store.delete(name)
    await showList(ctx)
  } catch (err) {
    await ctx.editMessageText(`❌ Error: ${err.message.slice(0, 300)}`)
  }
})

// Model selection — new project
bot.action(/^nbm:(sonnet|opus|haiku):(.+)$/, async (ctx) => {
  await answer(ctx)
  const modelMap = {
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  }
  const model = modelMap[ctx.match[1]] || 'claude-sonnet-4-6'
  const name = ctx.match[2]
  const state = pendingNew.get(ctx.chat.id)
  if (!state || state.step !== 'model' || state.name !== name) return ctx.editMessageText('Session expired. Use /menu.')
  pendingNew.delete(ctx.chat.id)

  if (buildingSet.has(name)) return ctx.answerCbQuery('Already building...', { show_alert: true })
  buildingSet.add(name)

  // Start deploy in background to avoid timeout
  deployNew(ctx, name, state.description, model)
    .then(ok => {
      if (ok) {
        const url = projectUrl(name)
        ctx.reply(`✅ *${name}* is ready!\n\n🔗 ${url}`, { parse_mode: 'Markdown' }).catch(() => {})
        sendProjectMenu(ctx, name).catch(() => {})
      }
    })
    .catch(err => console.error('Deploy error:', err))
    .finally(() => buildingSet.delete(name))
})

// Model selection — rebuild
bot.action(/^rbm:(sonnet|opus|haiku):(.+)$/, async (ctx) => {
  await answer(ctx)
  const modelMap = {
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  }
  const model = modelMap[ctx.match[1]] || 'claude-sonnet-4-6'
  const name = ctx.match[2]
  const state = pendingRebuild.get(ctx.chat.id)
  if (!state || state.step !== 'model' || state.name !== name) {
    pendingRebuild.delete(ctx.chat.id)
    return ctx.editMessageText('Session expired. Use /menu.')
  }
  pendingRebuild.delete(ctx.chat.id)

  const project = store.get(name)
  if (!project) return ctx.editMessageText(`Project "${name}" not found.`)
  if (buildingSet.has(name)) return ctx.answerCbQuery('Already building...', { show_alert: true })

  buildingSet.add(name)

  // Start deploy in background to avoid timeout
  deployRebuild(ctx, name, state.description, model, state.mode)
    .then(ok => {
      if (ok) showProject(ctx, name).catch(() => {})
    })
    .catch(err => console.error('Rebuild error:', err))
    .finally(() => buildingSet.delete(name))
})

// ── Launch ─────────────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`Error in update ${ctx?.updateType}:`, err.message)
  if (err.message.includes('path')) {
    console.error('Full error:', err)
  }
})

bot.launch()
reconcileSleepState().catch(err => console.error('Reconcile error:', err.message))
startSleepManager()
console.log(getBanner())
console.log(chalk.green('Bot started successfully.\n'))

process.once('SIGINT', () => { stopSleepManager(); bot.stop('SIGINT') })
process.once('SIGTERM', () => { stopSleepManager(); bot.stop('SIGTERM') })