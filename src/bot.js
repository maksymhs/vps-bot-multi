import 'dotenv/config'
import { Telegraf } from 'telegraf'
import { execFile } from 'child_process'
import { newCommand, rebuildCommand, listCommand, urlCommand, deleteProjectCommand, deployNew, deployRebuild, projectUrl, generateProjectName, changeQueue } from './commands/projects.js'
import { showMain, showList, showProject, showDeleteConfirm, startNewFlow, pendingNew, startRebuildFlow, startRebuildPatch, startRebuildFull, pendingRebuild } from './commands/menu.js'
import { userStore } from './lib/user-store.js'
import { getDocker } from './lib/docker-client.js'
import { buildingSet, pollingSet } from './lib/build-state.js'
import { config } from './lib/config.js'
import { enqueueBuild, getQueueStatus } from './lib/build-queue.js'
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

  // Auto-claim admin: first user becomes admin if not configured
  if (config.needsAdmin) {
    config.claimAdmin(userId)
    ctx.reply(`👑 You are now the admin of this bot!\nYour ID (${userId}) has been saved.`).catch(() => {})
  }

  // Maintenance mode: only admin can use bot
  if (userStore.maintenanceMode && !config.isAdmin(userId)) {
    return ctx.reply('🔧 Bot is in maintenance mode. Please try again later.')
  }

  return next()
})

// ── Text commands ──────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId = ctx.from?.id
  const count = userStore.countProjects(userId)

  // Returning user → straight to menu
  if (count > 0) return showMain(ctx)

  // New user → welcome onboarding
  const name = ctx.from?.first_name || 'there'
  const { Markup } = await import('telegraf')
  const text =
    `👋 *Hey ${name}!*\n\n` +
    `I turn your ideas into live web apps.\n\n` +
    `*How it works:*\n` +
    `1. Tap *New Project*\n` +
    `2. Give it a name\n` +
    `3. Describe what you want\n` +
    `4. Pick an AI model\n` +
    `5. I build & deploy it — you get a URL ✨\n\n` +
    `_No code needed. Takes ~60 seconds._`
  return ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Create my first app', 'new')],
      [Markup.button.callback('📋 Main menu', 'main')],
    ]),
  })
})

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

    pendingRebuild.delete(ctx.chat.id)
    userStore.setLastProject(userId, name)

    const slug = userStore.getUserSlug(userId)
    const buildKey = `${slug}-${name}`
    if (buildingSet.has(buildKey)) return ctx.reply('Already building...')
    buildingSet.add(buildKey)

    const qs = getQueueStatus()
    if (qs.waiting > 0) {
      await ctx.reply(`⏳ *${name}* — queued (${qs.waiting} builds ahead)`, { parse_mode: 'Markdown' })
    }

    enqueueBuild(buildKey, () => deployRebuild(ctx, name, description, null, mode, input))
      .catch(err => {
        console.error('Rebuild error:', err)
        ctx.reply(`❌ *${name}* — Rebuild failed: ${(err.message || err).toString().slice(0, 300)}`, { parse_mode: 'Markdown' }).catch(() => {})
      })
      .finally(() => buildingSet.delete(buildKey))
    return
  }

  // New project flow — check BEFORE lastProject so a description typed here
  // is never mistaken for a change to the previously active project.
  const newState = pendingNew.get(ctx.chat.id)
  if (newState?.step === 'desc') {
    const description = ctx.message.text.trim()
    pendingNew.delete(ctx.chat.id)

    if (!userStore.canCreateProject(userId)) {
      return ctx.reply(`⚠️ Limit reached (${config.maxAppsPerUser} apps). Delete one first.`)
    }

    // Generate project name automatically from description
    let name
    const genMsg = await ctx.reply('🔤 Generating project name...', { parse_mode: 'Markdown' })
    try {
      name = await generateProjectName(description, userId)
    } catch {
      name = 'app-' + Date.now().toString(36).slice(-4)
    }
    await ctx.telegram.editMessageText(ctx.chat.id, genMsg.message_id, null, `🔤 Project name: *${name}*`, { parse_mode: 'Markdown' }).catch(() => {})

    const slug = userStore.getUserSlug(userId)
    const buildKey = `${slug}-${name}`
    if (buildingSet.has(buildKey)) return ctx.reply('Already building...')
    buildingSet.add(buildKey)

    const qs = getQueueStatus()
    if (qs.waiting > 0) {
      await ctx.reply(`⏳ *${name}* — queued (${qs.waiting} builds ahead)`, { parse_mode: 'Markdown' })
    }

    userStore.setLastProject(userId, name)
    enqueueBuild(buildKey, () => deployNew(ctx, name, description, null))
      .catch(err => {
        console.error('Deploy error:', err)
        ctx.reply(`❌ *${name}* — Build failed: ${(err.message || err).toString().slice(0, 300)}`, { parse_mode: 'Markdown' }).catch(() => {})
      })
      .finally(() => buildingSet.delete(buildKey))
    return
  }

  // Conversational rebuild: plain text → patch last active project
  // No need for menus — just type what you want changed.
  // Only reached when NOT in a pendingNew or pendingRebuild flow.
  const lastProject = userStore.getLastProject(userId)
  if (lastProject) {
    const project = userStore.getProject(userId, lastProject)
    if (project) {
      const input = ctx.message.text.trim()
      const description = `${project.description}\n\nRequested changes: ${input}`
      const slug = userStore.getUserSlug(userId)
      const buildKey = `${slug}-${lastProject}`
      if (buildingSet.has(buildKey) || pollingSet.has(buildKey)) {
        // Queue the change — will be applied automatically when the current build finishes
        const q = changeQueue.get(String(userId)) || []
        q.push({ description, input, ctx })
        changeQueue.set(String(userId), q)
        return ctx.reply(
          `📝 *${lastProject}* is building — change queued (${q.length} pending).\n_Will apply automatically when done._`,
          { parse_mode: 'Markdown' }
        )
      }
      buildingSet.add(buildKey)
      const qs = getQueueStatus()
      if (qs.waiting > 0) await ctx.reply(`⏳ *${lastProject}* — queued (${qs.waiting} ahead)`, { parse_mode: 'Markdown' })
      enqueueBuild(buildKey, () => deployRebuild(ctx, lastProject, description, null, 'patch', input))
        .finally(() => buildingSet.delete(buildKey))
      return
    }
  }

  // Nothing matched — pass through
  return next()
})

// ── Inline button actions ──────────────────────────────────────────────────

function answer(ctx) {
  return ctx.answerCbQuery().catch(() => {})
}

// Navigation — clear conversational context so typing after going to menu
// doesn't accidentally patch the previously active project.
bot.action('main', async (ctx) => {
  await answer(ctx)
  userStore.clearLastProject(ctx.from?.id)
  await showMain(ctx, true)
})
bot.action('list', async (ctx) => {
  await answer(ctx)
  userStore.clearLastProject(ctx.from?.id)
  await showList(ctx)
})

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

  // Count running containers
  let runningContainers = 0
  try {
    const docker = getDocker()
    const containers = await docker.listContainers({ filters: { status: ['running'] } })
    runningContainers = containers.filter(c => c.Names?.[0]?.includes('-app')).length
  } catch {}

  const qs = getQueueStatus()
  const maint = userStore.maintenanceMode ? '🔴 ON' : '🟢 OFF'

  const text =
    `🖥 *Server Status*\n\n` +
    `*CPU:* ${pct(cpu.currentLoad)}%\n` +
    `*RAM:* ${gb(mem.used)}GB / ${gb(mem.total)}GB (${pct(mem.used / mem.total * 100)}%)\n` +
    `*Disk:* ${gb(d.used)}GB / ${gb(d.size)}GB (${pct(d.use)}%)\n\n` +
    `👥 *Users:* ${userCount}\n` +
    `📦 *Total Apps:* ${projectCount}\n` +
    `🐳 *Running:* ${runningContainers} containers\n` +
    `🔨 *Build queue:* ${qs.running}/${qs.max} active, ${qs.waiting} waiting\n` +
    `⏱ *Auto-sleep:* ${config.idleTimeout}m\n` +
    `🔧 *Maintenance:* ${maint}`
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🛑 Stop All', 'admin_stopall'),
        Markup.button.callback(userStore.maintenanceMode ? '▶️ Resume' : '⏸ Pause', 'admin_maint'),
      ],
      [
        Markup.button.callback('👥 Users', 'admin_users'),
        Markup.button.callback('🔄 Refresh', 'status'),
      ],
      [Markup.button.callback('⬅️ Menu', 'main')],
    ]),
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

// Admin: stop all containers
bot.action('admin_stopall', async (ctx) => {
  await answer(ctx)
  const userId = ctx.from?.id
  if (!config.isAdmin(userId)) return

  const { Markup } = await import('telegraf')
  await ctx.editMessageText('🛑 *Stopping all app containers...*', { parse_mode: 'Markdown' })

  let stopped = 0
  try {
    const docker = getDocker()
    const containers = await docker.listContainers({ filters: { status: ['running'] } })
    const appContainers = containers.filter(c => c.Names?.[0]?.includes('-app'))
    for (const c of appContainers) {
      try {
        const container = docker.getContainer(c.Id)
        await container.stop({ t: 5 })
        stopped++
      } catch {}
    }
  } catch {}

  await ctx.editMessageText(`🛑 *Stopped ${stopped} containers*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📊 Status', 'status'), Markup.button.callback('⬅️ Menu', 'main')],
    ]),
  })
})

// Admin: toggle maintenance mode (pause/resume builds)
bot.action('admin_maint', async (ctx) => {
  await answer(ctx)
  const userId = ctx.from?.id
  if (!config.isAdmin(userId)) return

  const newState = !userStore.maintenanceMode
  userStore.setMaintenance(newState)

  const { Markup } = await import('telegraf')
  const label = newState ? '⏸ *Maintenance mode ON*\nOnly admin can use the bot.' : '▶️ *Maintenance mode OFF*\nAll users can use the bot again.'
  await ctx.editMessageText(label, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📊 Status', 'status'), Markup.button.callback('⬅️ Menu', 'main')],
    ]),
  })
})

// New project
bot.action('new', async (ctx) => { await answer(ctx); await startNewFlow(ctx) })

// Project menu — opens project and sets it as active context
bot.action(/^p:(.+)$/, async (ctx) => {
  await answer(ctx)
  const name = ctx.match[1]
  userStore.setLastProject(ctx.from.id, name)
  await showProject(ctx, name)
})

// Rebuild — ask for changes first
bot.action(/^rb:(.+)$/, async (ctx) => {
  await answer(ctx)
  const userId = ctx.from?.id
  const name = ctx.match[1]
  if (!userStore.getProject(userId, name)) return ctx.editMessageText(`Project "${name}" not found.`)
  const slug = userStore.getUserSlug(userId)
  const buildKey = `${slug}-${name}`
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
    if (userStore.getLastProject(userId) === name) userStore.clearLastProject(userId)
    await showList(ctx)
  } catch (err) {
    await ctx.editMessageText(`❌ Error: ${err.message.slice(0, 300)}`)
  }
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

// Check OpenRouter API key at startup
if (config.openrouterKey) {
  console.log(chalk.green('✔ OPENROUTER_API_KEY set — code generation ready (DeepSeek)'))
} else {
  console.log(chalk.red('✘ OPENROUTER_API_KEY not set — code generation unavailable!'))
  console.log(chalk.dim('  Set OPENROUTER_API_KEY in .env'))
}

console.log(chalk.green('Bot started successfully.\n'))

process.once('SIGINT', () => { stopSleepManager(); bot.stop('SIGINT') })
process.once('SIGTERM', () => { stopSleepManager(); bot.stop('SIGTERM') })