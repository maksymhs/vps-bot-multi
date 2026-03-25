import { Markup } from 'telegraf'
import { getDocker } from '../lib/docker-client.js'
import { userStore } from '../lib/user-store.js'
import { config } from '../lib/config.js'

// Conversation state for /new project flow
// Map<chatId, { step: 'name'|'desc', msgId: number, name?: string }>
export const pendingNew = new Map()

// Conversation state for rebuild flow
// Map<chatId, { name: string }>
export const pendingRebuild = new Map()

function getUserId(ctx) {
  return ctx.from?.id
}

async function containerStatus(userId, projectName) {
  const cName = userStore.containerName(userId, projectName)
  try {
    const list = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [cName] }),
    })
    return list[0]?.State ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// ── Main menu ──────────────────────────────────────────────────────────────

export async function showMain(ctx, edit = false) {
  const userId = getUserId(ctx)
  const count = userStore.countProjects(userId)
  const max = config.maxAppsPerUser
  const text = `⚡ *vps-bot multi*\n_Describe it. Deploy it._\n\n📊 Apps: ${count}/${max}`
  const rows = [
    [Markup.button.callback('🚀 My Projects', 'list')],
    [Markup.button.callback('➕ New Project', 'new')],
  ]
  if (config.isAdmin(userId)) {
    rows.push([
      Markup.button.callback('� Users', 'admin_users'),
      Markup.button.callback('📊 Server Status', 'status'),
    ])
  }
  const kb = Markup.inlineKeyboard(rows)
  return edit
    ? ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb })
    : ctx.reply(text, { parse_mode: 'Markdown', ...kb })
}

// ── Project list ───────────────────────────────────────────────────────────

export async function showList(ctx) {
  const userId = getUserId(ctx)
  const projects = userStore.getAllProjects(userId)
  const names = Object.keys(projects)
  const back = Markup.button.callback('⬅️ Menu', 'main')

  if (!names.length) {
    return ctx.editMessageText('📁 *My Projects*\n\nNo projects yet.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Create Project', 'new')],
        [back],
      ]),
    })
  }

  const rows = names.map(n => [Markup.button.callback(`📦 ${n}`, `p:${n}`)])
  rows.push([Markup.button.callback('➕ New', 'new'), back])

  return ctx.editMessageText('📁 *My Projects*\n\nSelect one:', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  })
}

// ── Project detail menu ────────────────────────────────────────────────────

export async function showProject(ctx, name) {
  const userId = getUserId(ctx)
  const project = userStore.getProject(userId, name)
  if (!project) {
    return ctx.editMessageText(`Project *${name}* not found.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ List', 'list')]]),
    })
  }

  const status = await containerStatus(userId, name)
  const icon = status === 'running' ? '🟢' : '🔴'
  const sleeping = project.sleeping ? ' 💤' : ''
  const desc = (project.description ?? '').slice(0, 120)

  const toggleBtn = status === 'running'
    ? Markup.button.callback('🛑 Stop', `st:${name}`)
    : Markup.button.callback('▶️ Start', `go:${name}`)

  return ctx.editMessageText(
    `📦 *${name}*  ${icon}${sleeping}\n\n🔗 ${project.url}\n_${desc}_`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('♻️ Rebuild', `rb:${name}`), Markup.button.callback('📋 Logs', `lg:${name}`)],
        [Markup.button.callback('🔗 Copy URL', `url:${name}`), Markup.button.callback('🗑️ Delete', `del:${name}`)],
        [toggleBtn, Markup.button.callback('⬅️ List', 'list')],
      ]),
    }
  )
}

// ── Delete confirmation ────────────────────────────────────────────────────

export async function showDeleteConfirm(ctx, name) {
  return ctx.editMessageText(
    `⚠️ Delete *${name}*?\n\nThis will remove the container, image, and all files.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('✅ Yes, delete', `del_ok:${name}`),
        Markup.button.callback('❌ Cancel', `p:${name}`),
      ]]),
    }
  )
}

// ── Rebuild conversation ───────────────────────────────────────────────────

export async function startRebuildFlow(ctx, name) {
  const userId = getUserId(ctx)
  const project = userStore.getProject(userId, name)
  const desc = (project?.description ?? '').slice(0, 200)
  return ctx.editMessageText(
    `♻️ *Rebuild: ${name}*\n\n📝 Current description:\n_${desc}_`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Patch (add changes)', `rb_patch:${name}`)],
        [Markup.button.callback('🔁 Full rebuild', `rb_full:${name}`)],
        [Markup.button.callback('❌ Cancel', `p:${name}`)],
      ]),
    }
  )
}

export async function startRebuildPatch(ctx, name) {
  pendingRebuild.set(ctx.chat.id, { name, mode: 'patch', step: 'text' })
  return ctx.editMessageText(
    `✏️ *Changes for ${name}*\n\nDescribe what you want to change:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `p:${name}`)]]),
    }
  )
}

export async function startRebuildFull(ctx, name) {
  pendingRebuild.set(ctx.chat.id, { name, mode: 'full', step: 'text' })
  return ctx.editMessageText(
    `🔁 *Full rebuild: ${name}*\n\nDescribe the new project from scratch:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `p:${name}`)]]),
    }
  )
}

export function showModelSelect(ctx, prefix, name, edit = false) {
  const text = `🤖 *Select model*\n\n🧠 *DeepSeek* — smart & cheap _(recommended)_\n⚡ *Llama* — ultra-fast, great for simple apps\n🔥 *Qwen* — strong coding model`

  const kb = [
    [
      Markup.button.callback('🧠 DeepSeek', `${prefix}:deepseek:${name}`),
      Markup.button.callback('⚡ Llama', `${prefix}:llama:${name}`),
    ],
    [
      Markup.button.callback('🔥 Qwen', `${prefix}:qwen:${name}`),
    ],
    [Markup.button.callback('❌ Cancel', `p:${name}`)],
  ]

  return edit
    ? ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) })
    : ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) })
}

// ── New project conversation ───────────────────────────────────────────────

export async function startNewFlow(ctx) {
  const userId = getUserId(ctx)
  if (!userStore.canCreateProject(userId)) {
    const max = config.maxAppsPerUser
    return ctx.editMessageText(
      `⚠️ *Limit reached*\n\nYou have ${max}/${max} projects.\nDelete one to create a new one.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ My Projects', 'list')]]),
      }
    )
  }

  pendingNew.set(ctx.chat.id, { step: 'name' })
  return ctx.editMessageText(
    '➕ *New project*\n\nProject name? (letters, numbers, and hyphens only)',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'list')]]),
    }
  )
}