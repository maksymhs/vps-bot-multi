import { spawn } from 'child_process'
import { getDocker } from '../lib/docker-client.js'

async function findContainer(name) {
  const containers = await getDocker().listContainers({
    all: true,
    filters: JSON.stringify({ name: [name] }),
  })
  return containers[0] ?? null
}

function demuxLogs(buffer) {
  const chunks = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const frameSize = buffer.readUInt32BE(offset + 4)
    if (frameSize > 0) {
      chunks.push(buffer.slice(offset + 8, offset + 8 + frameSize).toString('utf8'))
    }
    offset += 8 + frameSize
  }
  return chunks.join('')
}

export async function psCommand(ctx) {
  const containers = await getDocker().listContainers({ all: true })
  if (!containers.length) return ctx.reply('No containers found.')

  const lines = containers.map(c => {
    const name = c.Names[0].replace('/', '')
    const icon = c.State === 'running' ? '🟢' : '🔴'
    const ports = c.Ports
      .filter(p => p.PublicPort)
      .map(p => `${p.PublicPort}→${p.PrivatePort}`)
      .join(', ')
    return `${icon} \`${name}\`${ports ? ` [${ports}]` : ''} — ${c.Status}`
  })

  return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

export async function logsCommand(ctx) {
  const name = ctx.message.text.split(' ').slice(1).join(' ').trim()
  if (!name) return ctx.reply('Usage: /logs <name>')

  const info = await findContainer(name)
  if (!info) return ctx.reply(`Container "${name}" not found.`)

  const msg = await ctx.reply(`📋 Fetching logs for \`${name}\`...`, { parse_mode: 'Markdown' })
  await runLiveLogsStream(ctx, msg.message_id, name, 30)
}

async function runLiveLogsStream(ctx, msgId, containerName, timeout = 30) {
  const lines = []
  let lastUpdate = Date.now()
  const UPDATE_INTERVAL = 2000

  return new Promise(async (resolve, reject) => {
    const child = spawn('docker', ['logs', '--follow', '--tail=20', containerName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const scheduleUpdate = () => {
      const now = Date.now()
      if (now - lastUpdate > UPDATE_INTERVAL) {
        updateMessage()
      }
    }

    const updateMessage = async () => {
      lastUpdate = Date.now()
      const content = formatLogs(lines)
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined, content, {
          parse_mode: 'Markdown',
        })
      } catch (err) {
        // Ignore rate limit errors
      }
    }

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        const text = data.toString()
        lines.push(...text.split('\n').filter(l => l.trim()))
        scheduleUpdate()
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        const text = data.toString()
        lines.push(`❌ ${text}`)
        scheduleUpdate()
      })
    }

    const timeoutHandle = setTimeout(() => {
      child.kill()
      resolve()
    }, timeout * 1000)

    child.on('close', async () => {
      clearTimeout(timeoutHandle)
      await updateMessage()
      resolve()
    })

    child.on('error', reject)
    if (child.stdin) child.stdin.end()
  })
}

function formatLogs(lines) {
  if (lines.length === 0) return `📋 \`\`\`\nWaiting for logs...\n\`\`\``

  const recent = lines.slice(-40)
  let content = recent.join('\n')

  if (content.length > 3900) {
    content = `...\n${content.slice(-3890)}`
  }

  return `📋 \`\`\`\n${content}\n\`\`\` ⏸️`
}

export async function restartCommand(ctx) {
  const name = ctx.message.text.split(' ').slice(1).join(' ').trim()
  if (!name) return ctx.reply('Usage: /restart <name>')

  const info = await findContainer(name)
  if (!info) return ctx.reply(`Container "${name}" not found.`)

  await getDocker().getContainer(info.Id).restart()
  return ctx.reply(`♻️ \`${name}\` restarted.`, { parse_mode: 'Markdown' })
}

export async function stopCommand(ctx) {
  const name = ctx.message.text.split(' ').slice(1).join(' ').trim()
  if (!name) return ctx.reply('Usage: /stop <name>')

  const info = await findContainer(name)
  if (!info) return ctx.reply(`Container "${name}" not found.`)

  await getDocker().getContainer(info.Id).stop()
  return ctx.reply(`🛑 \`${name}\` stopped.`, { parse_mode: 'Markdown' })
}

export async function startCommand(ctx) {
  const name = ctx.message.text.split(' ').slice(1).join(' ').trim()
  if (!name) return ctx.reply('Usage: /start <name>')

  const info = await findContainer(name)
  if (!info) return ctx.reply(`Container "${name}" not found.`)

  await getDocker().getContainer(info.Id).start()
  return ctx.reply(`▶️ \`${name}\` started.`, { parse_mode: 'Markdown' })
}
