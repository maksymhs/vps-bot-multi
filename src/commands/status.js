import si from 'systeminformation'

export async function statusCommand(ctx) {
  const [cpu, mem, disk] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
  ])

  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1)
  const pct = (n) => Math.round(n)

  const mainDisk = disk.find(d => d.mount === '/') || disk[0]

  const msg =
    `🖥 *Estado del servidor*\n\n` +
    `*CPU:* ${pct(cpu.currentLoad)}% usado\n` +
    `*RAM:* ${gb(mem.used)}GB / ${gb(mem.total)}GB (${pct(mem.used / mem.total * 100)}%)\n` +
    `*Disco:* ${gb(mainDisk.used)}GB / ${gb(mainDisk.size)}GB (${pct(mainDisk.use)}%)`

  return ctx.reply(msg, { parse_mode: 'Markdown' })
}
