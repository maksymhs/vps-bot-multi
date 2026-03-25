import { Markup } from 'telegraf'
import { getDocker } from '../lib/docker-client.js'
import { store } from '../lib/store.js'
import { getUsageText } from '../lib/usage.js'

// Conversation state for /new project flow
// Map<chatId, { step: 'name'|'desc', msgId: number, name?: string }>
export const pendingNew = new Map()

// Conversation state for rebuild flow
// Map<chatId, { name: string }>
export const pendingRebuild = new Map()

async function containerStatus(projectName) {
  try {
    const list = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [`${projectName}-app`] }),
    })
    return list[0]?.State ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// ── Main menu ──────────────────────────────────────────────────────────────

export async function showMain(ctx, edit = false) {
  const text = '⚡ *vps-bot*\n_Describe it. Deploy it._'
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Status', 'status'),
      Markup.button.callback('📦 Containers', 'ps'),
    ],
    [Markup.button.callback('🚀 My Projects', 'list')],
    [Markup.button.callback('➕ New Project', 'new')],
    [
      Markup.button.callback('💻 Code-Server', 'codeserver'),
      Markup.button.callback('⚡ Claude Usage', 'usage'),
    ],
  ])
  return edit
    ? ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb })
    : ctx.reply(text, { parse_mode: 'Markdown', ...kb })
}

// ── Project list ───────────────────────────────────────────────────────────

export async function showList(ctx) {
  const projects = store.getAll()
  const names = Object.keys(projects)
  const back = Markup.button.callback('⬅️ Menu', 'main')

  if (!names.length) {
    return ctx.editMessageText('📁 *Projects*\n\nNo projects yet.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Create Project', 'new')],
        [back],
      ]),
    })
  }

  const rows = names.map(n => [Markup.button.callback(`📦 ${n}`, `p:${n}`)])
  rows.push([Markup.button.callback('➕ New', 'new'), back])

  return ctx.editMessageText('📁 *Projects*\n\nSelect one:', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  })
}

// ── Project detail menu ────────────────────────────────────────────────────

export async function showProject(ctx, name) {
  const project = store.get(name)
  if (!project) {
    return ctx.editMessageText(`Project *${name}* not found.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ List', 'list')]]),
    })
  }

  const status = await containerStatus(name)
  const icon = status === 'running' ? '🟢' : '🔴'
  const desc = (project.description ?? '').slice(0, 120)

  const toggleBtn = status === 'running'
    ? Markup.button.callback('🛑 Stop', `st:${name}`)
    : Markup.button.callback('▶️ Start', `go:${name}`)

  return ctx.editMessageText(
    `📦 *${name}*  ${icon}\n\n🔗 ${project.url}\n_${desc}_`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('♻️ Rebuild', `rb:${name}`), Markup.button.callback('📋 Logs', `lg:${name}`)],
        [Markup.button.callback('💻 Code-Server', `cs:${name}`), Markup.button.callback('🔗 Copy URL', `url:${name}`)],
        [Markup.button.callback('⚙️ Git', `git_menu:${name}`), Markup.button.callback('🗑️ Delete', `del:${name}`)],
        [toggleBtn, Markup.button.callback('⬅️ List', 'list')],
      ]),
    }
  )
}

// ── Git Menu ───────────────────────────────────────────────────────────

export async function showGitMenu(ctx, name) {
  return ctx.editMessageText(
    `🔧 *Git - ${name}*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📤 Push', `gp:${name}`), Markup.button.callback('📥 Pull', `gpl:${name}`)],
        [Markup.button.callback('📊 Status', `gs:${name}`)],
        [Markup.button.callback('⚙️ Init Repo', `git_init:${name}`)],
        [Markup.button.callback('💬 Custom Commit', `git_commit:${name}`)],
        [Markup.button.callback('⬅️ Back', `p:${name}`)],
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
  const project = store.get(name)
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
  const text = `🤖 *Select model*\n\n🚀 *Sonnet* — fast and efficient _(recommended)_\n🧠 *Opus* — more powerful, slower\n⚡ *Haiku* — ultra-fast, great for simple tasks`

  const kb = [
    [
      Markup.button.callback('🚀 Sonnet', `${prefix}:sonnet:${name}`),
      Markup.button.callback('🧠 Opus', `${prefix}:opus:${name}`),
    ],
    [
      Markup.button.callback('⚡ Haiku', `${prefix}:haiku:${name}`),
    ],
    [Markup.button.callback('❌ Cancel', `p:${name}`)],
  ]

  return edit
    ? ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) })
    : ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) })
}

// ── New project conversation ───────────────────────────────────────────────

export async function startNewFlow(ctx) {
  pendingNew.set(ctx.chat.id, { step: 'name' })
  return ctx.editMessageText(
    '➕ *New project*\n\nProject name? (letters, numbers, and hyphens only)',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'list')]]),
    }
  )
}