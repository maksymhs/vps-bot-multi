import 'dotenv/config'
import { Telegraf } from 'telegraf'
import { execFile } from 'child_process'
import { newCommand, rebuildCommand, listCommand, urlCommand, deleteProjectCommand, deployNew, deployRebuild, projectUrl } from './commands/projects.js'
import { showMain, showList, showProject, showDeleteConfirm, startNewFlow, pendingNew, startRebuildFlow, startRebuildPatch, startRebuildFull, pendingRebuild, showModelSelect } from './commands/menu.js'
import { userStore } from './lib/user-store.js'
import { getDocker } from './lib/docker-client.js'
import { buildingSet } from './lib/build-state.js'
import { config } from './lib/config.js'
import { getBanner } from './lib/branding.js'
import { startSleepManager, stopSleepManager, reconcileSleepState } from './lib/sleep-manager.js'
import { existsSync, rmSync } from 'fs'
import chalk from 'chalk'

const bot = new Telegraf(process.env.BOT_TOKEN)

// ── Auto-register middleware ─────────────────────────────────────────────
// Every user who interacts with the bot is automatically registered.
// Banned users are blocked.

bot.use((ctx, next) => {
  const userId = ctx.from?.id
  if (!userId) return

  // Check if banned
  if (userStore.isUserBanned(userId)) {
    return ctx.reply('⛔ Your account has been suspended.')
  }

  // Auto-register user
  userStore.ensureUser(userId, {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    lastName: ctx.from.last_name,
  })

  return next()
})

// ── Text commands ──────────────────────────────────────────────────────────

bot.start((ctx) => showMain(ctx))

bot.command('menu', (ctx) => showMain(ctx))
bot.command('new', newCommand)
bot.command('rebuild', rebuildCommand)
bot.command('list', (ctx) => listCommand(ctx))
bot.command('url', urlCommand)
bot.command('delete', deleteProjectCommand)

// ── Conversational flow (new project via buttons) ──────────────────────────

bot.on('text', async (ctx, next) => {
  const userId = ctx.from?.id

  // Rebuild flow
  const rebuildState = pendingRebuild.get(ctx.chat.id)
  if (rebuildState && rebuildState.step === 'text') {
    const { name, mode } = rebuildState
    const project = userStore.getProject(userId, name)
    if (!project) { pendingRebuild.delete(ctx.chat.id); return ctx.reply(`Project "${name}" not found.`) }

    const input = ctx.message.text.trim()
    const description = mode === 'patch'
      ? `${project.description}\n\nRequested changes: ${input}`
      : input

    pendingRebuild.set(ctx.chat.id, { name, mode, description, step: 'model' })
    return showModelSelect(ctx, 'rbm', name)
  }

  // New project flow
  const state = pendingNew.get(ctx.chat.id)
  if (!state) return next()

  if (state.step === 'name') {
    const name = ctx.message.text.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
    if (!name) return ctx.reply('Invalid name. Only letters, numbers, and hyphens.')
    if (userStore.getProject(userId, name)) {
      return ctx.reply(`"${name}" already exists. Pick another name or /menu to cancel.`)
    }
    if (!userStore.canCreateProject(userId)) {
      pendingNew.delete(ctx.chat.id)
      return ctx.reply(`⚠️ Limit reached (${config.maxAppsPerUser} apps). Delete one first.`)
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

// Admin: server status (admin only)
bot.action('status', async (ctx) => {
  await answer(ctx)
  const userId = ctx.from?.id
  if (!config.isAdmin(userId)) return

  const { Markup } = await import('telegraf')
  const si = await import('systeminformation')
  const [cpu, mem, disk] = await Promise.all([si.default.currentLoad(), si.default.mem(), si.default.fsSize()])
  const gb = b => (b / 1024 ** 3).toFixed(1)
  const pct = n => Math.round(n)
  const d = disk.find(d => d.mount === '/') || disk[0]

  const allUsers = userStore.getAllUsers()
  const userCount = Object.keys(allUsers).length
  const allProjects = userStore.getAllProjectsGlobal()
  const projectCount = Object.keys(allProjects).length

  const text =
    `🖥 *Server Status*\n\n` +
    `*CPU:* ${pct(cpu.currentLoad)}%\n` +
    `*RAM:* ${gb(mem.used)}GB / ${gb(mem.total)}GB (${pct(mem.used / mem.total * 100)}%)\n` +
    `*Disk:* ${gb(d.used)}GB / ${gb(d.size)}GB (${pct(d.use)}%)\n\n` +
    `👥 *Users:* ${userCount}\n` +
    `📦 *Total Apps:* ${projectCount}\n` +
    `⏱ *Auto-sleep:* ${config.idleTimeout}m`
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'main')]]),
  })
})

// Admin: user list
bot.action('admin_users', async (ctx) => {
  await answer(ctx)
  const userId = ctx.from?.id
  if (!config.isAdmin(userId)) return

  const { Markup } = await import('telegraf')
  const allUsers = userStore.getAllUsers()
  const entries = Object.entries(allUsers)

  if (!entries.length) {
    return ctx.editMessageText('👥 *Users*\n\nNo users yet.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'main')]]),
    })
  }

  const lines = entries.slice(0, 20).map(([id, u]) => {
    const name = u.username ? `@${u.username}` : u.firstName || id
    const projects = userStore.countProjects(id)
    const banned = u.banned ? ' 🚫' : ''
    return `• *${name}* (${projects} apps)${banned}`
  })

  const text = `👥 *Users* (${entries.length})\n\n${lines.join('\n')}`
  await ctx.editMessageText(text, {
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
  const userId = ctx.from?.id
  const name = ctx.match[1]
  if (!userStore.getProject(userId, name)) return ctx.editMessageText(`Project "${name}" not found.`)
  const buildKey = `u${userId}-${name}`
  if (buildingSet.has(buildKey)) return ctx.answerCbQuery('Already building...', { show_alert: true })
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
  const userId = ctx.from?.id
  const name = ctx.match[1]
  const containerName = userStore.containerName(userId, name)
  try {
    const containers = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [containerName] }),
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
  const userId = ctx.from?.id
  const name = ctx.match[1]
  const containerName = userStore.containerName(userId, name)
  try {
    const containers = await getDocker().listContainers({ filters: JSON.stringify({ name: [containerName] }) })
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
  const userId = ctx.from?.id
  const name = ctx.match[1]
  const containerName = userStore.containerName(userId, name)
  try {
    const containers = await getDocker().listContainers({ all: true, filters: JSON.stringify({ name: [containerName] }) })
    if (containers.length) await getDocker().getContainer(containers[0].Id).start()
    await showProject(ctx, name)
  } catch (err) {
    await ctx.answerCbQuery(`Error: ${err.message}`, { show_alert: true })
    await showProject(ctx, name)
  }
})

// URL
bot.action(/^url:(.+)$/, async (ctx) => {
  const userId = ctx.from?.id
  const name = ctx.match[1]
  const project = userStore.getProject(userId, name)
  await ctx.answerCbQuery(project ? project.url : 'Not found', { show_alert: true }).catch(() => {})
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
  const userId = ctx.from?.id
  const name = ctx.match[1]
  const project = userStore.getProject(userId, name)
  if (!project) return ctx.editMessageText('Project not found.')

  await ctx.editMessageText(`🗑️ Deleting *${name}*...`, { parse_mode: 'Markdown' })

  try {
    const dir = userStore.projectDir(userId, name)
    await new Promise((res) => {
      execFile('docker', ['compose', 'down', '--rmi', 'local'], { cwd: dir }, () => res())
    })

    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    userStore.deleteProject(userId, name)
    await showList(ctx)
  } catch (err) {
    await ctx.editMessageText(`❌ Error: ${err.message.slice(0, 300)}`)
  }
})

// Model selection — new project
bot.action(/^nbm:(sonnet|opus|haiku):(.+)$/, async (ctx) => {
  await answer(ctx)
  const userId = ctx.from?.id
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

  const buildKey = `u${userId}-${name}`
  if (buildingSet.has(buildKey)) return ctx.answerCbQuery('Already building...', { show_alert: true })
  buildingSet.add(buildKey)

  // Start deploy in background to avoid timeout
  deployNew(ctx, name, state.description, model)
    .catch(err => console.error('Deploy error:', err))
    .finally(() => buildingSet.delete(buildKey))
})

// Model selection — rebuild
bot.action(/^rbm:(sonnet|opus|haiku):(.+)$/, async (ctx) => {
  await answer(ctx)
  const userId = ctx.from?.id
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

  const project = userStore.getProject(userId, name)
  if (!project) return ctx.editMessageText(`Project "${name}" not found.`)

  const buildKey = `u${userId}-${name}`
  if (buildingSet.has(buildKey)) return ctx.answerCbQuery('Already building...', { show_alert: true })
  buildingSet.add(buildKey)

  // Start deploy in background to avoid timeout
  deployRebuild(ctx, name, state.description, model, state.mode)
    .then(ok => {
      if (ok) showProject(ctx, name).catch(() => {})
    })
    .catch(err => console.error('Rebuild error:', err))
    .finally(() => buildingSet.delete(buildKey))
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