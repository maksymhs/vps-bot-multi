import inquirer from 'inquirer'
import chalk from 'chalk'
import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from '../lib/config.js'
import { store } from '../lib/store.js'
import { writeComposeFile, projectUrl } from '../commands/projects.js'
import { updateEnvVar } from './ui.js'

// ── Configuration dashboard ──────────────────────────────────────────────────

export async function showConfig(nav) {
  console.clear()

  let serverIp = config.ipAddress || ''
  try { serverIp = execSync("hostname -I 2>/dev/null | awk '{print $1}' || echo ''", { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim() } catch {}

  console.log(chalk.cyan('\n  Configuration\n'))
  console.log(`  Server IP:   ${serverIp || chalk.gray('unknown')}`)
  if (config.domain) {
    console.log(`  Domain:      ${chalk.green(config.domain)} (SSL)`)
  }
  const csUrl = config.domain ? `https://code.${config.domain}` : `http://${serverIp || config.ipAddress}:${config.codeServerPort}`
  console.log(`  Code-Server: ${csUrl} (pass: ${config.codeServerPassword})`)

  let claudeStatus = chalk.gray('not installed')
  try {
    execSync('claude --version', { stdio: 'ignore' })
    try {
      execSync("su - vpsbot -c 'claude auth status'", { stdio: 'ignore' })
      claudeStatus = chalk.green('logged in')
    } catch {
      claudeStatus = chalk.yellow('installed (not logged in)')
    }
  } catch {}
  console.log(`  Claude Code: ${claudeStatus}`)

  let botRunning = false
  try { execSync('systemctl is-active --quiet vps-bot-telegram', { stdio: 'ignore' }); botRunning = true } catch {}
  const telegramStatus = !process.env.BOT_TOKEN
    ? chalk.gray('not set')
    : botRunning ? chalk.green('running') : chalk.yellow('configured (stopped)')
  console.log(`  Telegram:    ${telegramStatus}`)
  const idleLabel = config.idleTimeout > 0 ? chalk.green(`${config.idleTimeout}m`) : chalk.gray('off')
  console.log(`  Auto-sleep:  ${idleLabel}`)
  console.log(`  Projects:    ${config.projectsDir}`)
  console.log('')

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Configure:',
    loop: false,
    choices: [
      { name: 'Configure Claude Code', value: 'claude' },
      { name: 'Set Custom Domain', value: 'domain' },
      { name: 'Set Telegram Bot', value: 'telegram' },
      { name: 'Change Code-Server Password', value: 'password' },
      { name: `Auto-sleep (${config.idleTimeout > 0 ? config.idleTimeout + 'm' : 'off'})`, value: 'idle' },
      new inquirer.Separator(),
      { name: 'View System Logs', value: 'logs' },
      { name: 'Back', value: 'back' },
    ],
  }])

  if (action === 'back') return nav.mainMenu()
  if (action === 'claude') return configureClaude(nav)
  if (action === 'domain') return configureDomain(nav)
  if (action === 'telegram') return configureTelegram(nav)
  if (action === 'password') return configurePassword(nav)
  if (action === 'idle') return configureIdleTimeout(nav)
  if (action === 'logs') return nav.systemLogs()
}

// ── Claude Code ──────────────────────────────────────────────────────────────

async function configureClaude(nav) {
  console.clear()
  console.log(chalk.cyan('\n  Claude Code\n'))

  let installed = false
  try {
    const ver = execSync('claude --version 2>/dev/null', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    console.log(chalk.green(`  ✓ CLI: ${ver}\n`))
    installed = true
  } catch {
    console.log(chalk.yellow('  Not installed.\n'))
  }

  if (!installed) {
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Install Claude Code?',
      loop: false,
      choices: [
        { name: 'Install now (npm install -g @anthropic-ai/claude-code)', value: 'install' },
        { name: 'Back', value: 'back' },
      ],
    }])

    if (action === 'back') return showConfig(nav)

    console.log(chalk.yellow('\nInstalling Claude Code CLI...\n'))
    try {
      execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'inherit' })
      installed = true
    } catch (err) {
      console.log(chalk.red(`\n✗ Installation failed: ${err.message}\n`))
      return showConfig(nav)
    }
  }

  try {
    const cliPath = execSync('which claude', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    updateEnvVar('CLAUDE_CLI', cliPath)
    console.log(chalk.green(`✓ Path: ${cliPath}\n`))
  } catch {}

  const { doLogin } = await inquirer.prompt([{
    type: 'list',
    name: 'doLogin',
    message: 'Login to Claude (opens auth URL):',
    loop: false,
    choices: [
      { name: 'Login now', value: true },
      { name: 'Skip (login later)', value: false },
    ],
  }])

  if (doLogin) {
    console.log(chalk.cyan('\nLaunching Claude login... Follow the URL to authenticate.\n'))
    try {
      execSync("su - vpsbot -c 'claude login'", { stdio: 'inherit' })
      console.log(chalk.green('\n✓ Claude authenticated!\n'))
    } catch {
      console.log(chalk.yellow('\nLogin cancelled or failed. You can login later: su - vpsbot -c \'claude login\'\n'))
    }
  }

  return showConfig(nav)
}

// ── Project migration (domain ↔ IP) ─────────────────────────────────────────

async function migrateProjects(mode) {
  const projects = store.getAll()
  const names = Object.keys(projects)
  if (!names.length) return

  console.log(chalk.yellow(`\n  Migrating ${names.length} project(s) to ${mode} mode...\n`))

  for (const name of names) {
    const dir = join(config.projectsDir, name)
    if (!existsSync(dir)) {
      console.log(chalk.gray(`  ⊘ ${name} — directory missing, skipping`))
      continue
    }

    try {
      // 1. Stop current container
      console.log(chalk.gray(`  [${name}] stopping...`))
      execSync('docker compose down 2>/dev/null || true', { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })

      // 2. Rewrite docker-compose.yml with correct network config
      writeComposeFile(dir, name)

      // 3. Update store URL
      const url = projectUrl(name)
      store.set(name, { url })

      // 4. Rebuild and start container with new config
      console.log(chalk.gray(`  [${name}] starting with ${mode} config...`))
      execSync('docker compose up --build -d', { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 })

      console.log(chalk.green(`  ✓ ${name} → ${url}`))
    } catch (err) {
      console.log(chalk.red(`  ✗ ${name} — ${err.message?.slice(0, 120)}`))
    }
  }
}

// ── Domain setup ─────────────────────────────────────────────────────────────

async function configureDomain(nav) {
  console.clear()
  console.log(chalk.cyan('\n  Domain Setup\n'))

  let serverIp = config.ipAddress || 'localhost'
  try {
    serverIp = execSync("hostname -I 2>/dev/null | awk '{print $1}' || curl -sf ifconfig.me 2>/dev/null || echo ''", { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch {}

  console.log(chalk.white('  Before entering your domain, add this DNS record:\n'))
  console.log(`    ${chalk.bold('Type')}   ${chalk.bold('Name')}              ${chalk.bold('Value')}`)
  console.log(`    A      *.yourdomain.com    ${serverIp}`)
  console.log()
  console.log(chalk.gray('  This wildcard record routes all subdomains (apps, code-server)'))
  console.log(chalk.gray('  to this server. DNS propagation may take a few minutes.\n'))

  const { domain } = await inquirer.prompt([{
    type: 'input',
    name: 'domain',
    message: 'Enter domain (e.g. maksym.site) or leave empty to use IP:',
    default: config.domain || '',
  }])

  if (domain) {
    console.log(chalk.cyan('\n  Verifying DNS...\n'))
    const dns = await import('dns')
    const { promisify } = await import('util')
    const resolve4 = promisify(dns.resolve4)

    let dnsOk = true
    const checks = [`code.${domain}`]
    for (const host of checks) {
      try {
        console.log(chalk.gray(`  Resolving ${host}...`))
        const ips = await resolve4(host)
        if (ips.includes(serverIp)) {
          console.log(chalk.green(`  ✓ ${host} → ${ips.join(', ')}`))
        } else {
          console.log(chalk.red(`  ✗ ${host} → ${ips.join(', ')} (expected ${serverIp})`))
          dnsOk = false
        }
      } catch (err) {
        console.log(chalk.red(`  ✗ ${host} → DNS resolution failed (${err.code || err.message})`))
        dnsOk = false
      }
    }

    if (!dnsOk) {
      console.log(chalk.red(`\n  ✗ DNS does not point to this server (${serverIp}).`))
      console.log(chalk.yellow(`\n  Required DNS record:`))
      console.log(`\n    ${chalk.bold('A')}  *.${domain}  →  ${serverIp}\n`)
      console.log(chalk.gray('  DNS propagation can take a few minutes.'))
      console.log(chalk.gray('  Verify your DNS provider settings and try again.\n'))

      const { retry } = await inquirer.prompt([{
        type: 'list',
        name: 'retry',
        message: 'What to do?',
        loop: false,
        choices: [
          { name: 'Retry DNS check', value: 'retry' },
          { name: 'Back to config', value: 'back' },
        ],
      }])
      if (retry === 'retry') return configureDomain(nav)
      return showConfig(nav)
    }

    console.log(chalk.green(`\n✓ DNS verified — *.${domain} → ${serverIp}\n`))

    updateEnvVar('DOMAIN', domain)
    updateEnvVar('IP_ADDRESS', '', true)

    console.log(chalk.yellow(`Setting up Caddy SSL for *.${domain}...\n`))

    const csPort = config.codeServerPort || 8080
    try { execSync('pkill -f code-server', { stdio: 'ignore' }) } catch {}

    const steps = [
      { name: 'Stop system Caddy', cmd: 'sudo systemctl stop caddy 2>/dev/null || true && sudo systemctl disable caddy 2>/dev/null || true' },
      { name: 'Free ports 80/443', cmd: 'sudo fuser -k 80/tcp 2>/dev/null || true && sudo fuser -k 443/tcp 2>/dev/null || true' },
      { name: 'Create Docker network', cmd: 'docker network create caddy 2>/dev/null || true' },
      { name: 'Remove old caddy-proxy', cmd: 'docker rm -f caddy-proxy 2>/dev/null || true' },
      { name: 'Pull caddy-docker-proxy', cmd: 'docker pull lucaslorentz/caddy-docker-proxy:ci-alpine' },
      { name: 'Start caddy-proxy', cmd: `docker run -d --name caddy-proxy --restart unless-stopped --network caddy -p 80:80 -p 443:443 -p 2019:2019 -v /var/run/docker.sock:/var/run/docker.sock -v caddy_data:/data -l "caddy.admin=0.0.0.0:2019" -l "caddy_0=code.${domain}" -l "caddy_0.reverse_proxy=host.docker.internal:${csPort}" --add-host host.docker.internal:host-gateway lucaslorentz/caddy-docker-proxy:ci-alpine` },
    ]

    let failed = false
    for (const step of steps) {
      try {
        console.log(chalk.gray(`  [${step.name}]...`))
        execSync(step.cmd, { stdio: 'inherit' })
        console.log(chalk.green(`  ✓ ${step.name}`))
      } catch (err) {
        console.log(chalk.red(`  ✗ ${step.name} FAILED`))
        console.log(chalk.red(`    ${err.stderr ? err.stderr.toString().trim() : err.message}`))
        failed = true
        break
      }
    }

    if (!failed) {
      const csConfigDir = `${process.env.HOME}/.config/code-server`
      mkdirSync(csConfigDir, { recursive: true })
      writeFileSync(join(csConfigDir, 'config.yaml'),
        `bind-addr: 0.0.0.0:${csPort}\nauth: password\npassword: ${config.codeServerPassword}\ncert: false\n`)
      spawn('code-server', ['--disable-telemetry', config.projectsDir], {
        detached: true, stdio: 'ignore',
      }).unref()

      console.log(chalk.green(`\n✓ Caddy running with auto-SSL`))
      console.log(chalk.green(`✓ https://code.${domain} → Code-Server`))
      console.log(chalk.green(`✓ https://{app}.${domain} → Project apps`))

      // Migrate existing projects to domain mode
      await migrateProjects('domain')
    }
  } else {
    updateEnvVar('DOMAIN', '', true)
    const ip = config.ipAddress || 'localhost'
    updateEnvVar('IP_ADDRESS', ip)

    execSync('docker rm -f caddy-proxy 2>/dev/null || true')
    execSync('systemctl stop caddy 2>/dev/null; systemctl disable caddy 2>/dev/null || true')
    execSync('pkill -f code-server 2>/dev/null || true')
    const csPort = config.codeServerPort || 8080
    const csConfigDir = `${process.env.HOME}/.config/code-server`
    execSync(`mkdir -p ${csConfigDir}`)
    writeFileSync(join(csConfigDir, 'config.yaml'),
      `bind-addr: 0.0.0.0:${csPort}\nauth: password\npassword: ${config.codeServerPassword}\ncert: false\n`)
    spawn('code-server', ['--disable-telemetry', config.projectsDir], {
      detached: true, stdio: 'ignore',
    }).unref()

    console.log(chalk.green(`\n✓ Switched to IP mode`))
    console.log(chalk.green(`✓ Code-Server: http://${ip}:${csPort}\n`))

    // Migrate existing projects to IP mode
    await migrateProjects('ip')
  }

  console.log()
  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
  return showConfig(nav)
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function configureTelegram(nav) {
  console.clear()
  console.log(chalk.cyan('\n  Telegram Bot\n'))

  // Show current bot status if configured
  if (process.env.BOT_TOKEN) {
    let botRunning = false
    try { execSync('systemctl is-active --quiet vps-bot-telegram', { stdio: 'ignore' }); botRunning = true } catch {}
    const statusIcon = botRunning ? '🟢' : '🔴'
    const statusText = botRunning ? chalk.green('running') : chalk.red('stopped')
    console.log(`  Status: ${statusIcon} ${statusText}`)
    console.log(`  Token:  ${chalk.gray(process.env.BOT_TOKEN.slice(0, 10) + '...')}`)
    if (process.env.CHAT_ID) console.log(`  Chat:   ${chalk.gray(process.env.CHAT_ID)}`)
    console.log()
  }

  console.log(chalk.gray('  1. Open Telegram and talk to @BotFather'))
  console.log(chalk.gray('  2. Send /newbot and follow the steps'))
  console.log(chalk.gray('  3. Copy the Bot Token\n'))

  const choices = [
    { name: 'Set Bot Token', value: 'token' },
  ]
  if (process.env.BOT_TOKEN) {
    let botRunning = false
    try { execSync('systemctl is-active --quiet vps-bot-telegram', { stdio: 'ignore' }); botRunning = true } catch {}
    choices.push(
      new inquirer.Separator(),
      ...(botRunning
        ? [
            { name: 'Stop bot', value: 'stop' },
            { name: 'Restart bot', value: 'restart' },
          ]
        : [{ name: 'Start bot', value: 'start_bot' }]
      ),
    )
  }
  choices.push(new inquirer.Separator(), { name: 'Back', value: 'back' })

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Telegram:',
    loop: false,
    choices,
  }])

  if (action === 'back') return showConfig(nav)
  if (action === 'start_bot') { startBotBackground(); return configureTelegram(nav) }
  if (action === 'stop') { stopBot(); return configureTelegram(nav) }
  if (action === 'restart') { stopBot(); startBotBackground(); return configureTelegram(nav) }

  // action === 'token'
  const { token } = await inquirer.prompt([{
    type: 'input',
    name: 'token',
    message: 'Bot Token (leave empty to disable):',
    default: config.botToken || '',
  }])

  if (!token) {
    updateEnvVar('BOT_TOKEN', '', true)
    updateEnvVar('CHAT_ID', '', true)
    console.log(chalk.gray('\nTelegram disabled.\n'))
    return showConfig(nav)
  }

  updateEnvVar('BOT_TOKEN', token)

  console.log(chalk.cyan('\n  Chat ID\n'))
  console.log(chalk.gray('  Send any message to your bot in Telegram, then:'))
  console.log()

  const { method } = await inquirer.prompt([{
    type: 'list',
    name: 'method',
    message: 'How to get your Chat ID:',
    loop: false,
    choices: [
      { name: 'Auto-detect (send a message to your bot first, then select this)', value: 'auto' },
      { name: 'Enter manually (use @userinfobot to find it)', value: 'manual' },
      { name: 'Skip for now', value: 'skip' },
    ],
  }])

  if (method === 'auto') {
    return autoDetectChatId(token, nav)
  }

  if (method === 'manual') {
    console.log(chalk.gray('\n  Tip: Send /start to @userinfobot in Telegram to get your Chat ID\n'))
    const { chatId } = await inquirer.prompt([{
      type: 'input',
      name: 'chatId',
      message: 'Your Chat ID:',
      default: config.chatId?.toString() || '',
      validate: (input) => /^-?\d+$/.test(input) ? true : 'Must be a number',
    }])
    updateEnvVar('CHAT_ID', chatId)
    console.log(chalk.green('\n✓ Telegram configured!\n'))
    return offerStartBot(nav)
  }

  return showConfig(nav)
}

async function autoDetectChatId(token, nav) {
  console.clear()
  console.log(chalk.cyan('\n  Auto-detect Chat ID\n'))
  console.log(chalk.gray('  Make sure you have sent a message to your bot in Telegram.\n'))
  console.log(chalk.yellow('  Fetching latest messages...\n'))

  let detected = false
  try {
    const result = execSync(`curl -sf "https://api.telegram.org/bot${token}/getUpdates" 2>/dev/null`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString()
    const data = JSON.parse(result)
    if (data.ok && data.result && data.result.length > 0) {
      const lastMsg = data.result[data.result.length - 1]
      const chatId = lastMsg.message?.chat?.id || lastMsg.my_chat_member?.chat?.id
      if (chatId) {
        const chatName = lastMsg.message?.chat?.first_name || lastMsg.my_chat_member?.chat?.first_name || ''
        console.log(chalk.green(`  ✓ Found Chat ID: ${chatId} ${chatName ? `(${chatName})` : ''}\n`))
        updateEnvVar('CHAT_ID', chatId.toString())
        console.log(chalk.green('  ✓ Telegram configured!\n'))
        detected = true
      }
    }
    if (!detected) {
      console.log(chalk.yellow('  ✗ No messages found. Send a message to your bot first.\n'))
    }
  } catch {
    console.log(chalk.red('  ✗ Could not reach Telegram API. Check your token.\n'))
  }

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: detected ? 'Next:' : 'What to do?',
    loop: false,
    choices: [
      ...(detected
        ? [{ name: 'Start bot now', value: 'start' }]
        : [{ name: 'Retry detection', value: 'retry' }]
      ),
      { name: 'Back to config', value: 'back' },
    ],
  }])

  if (action === 'retry') return autoDetectChatId(token, nav)
  if (action === 'start') startBotBackground()
  return showConfig(nav)
}

async function offerStartBot(nav) {
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Start Telegram bot now?',
    loop: false,
    choices: [
      { name: 'Start bot (background)', value: 'start' },
      { name: 'Back to menu', value: 'back' },
    ],
  }])

  if (action === 'start') startBotBackground()
  return showConfig(nav)
}

function startBotBackground() {
  try {
    execSync('systemctl enable vps-bot-telegram && systemctl restart vps-bot-telegram', { stdio: 'inherit' })
    console.log(chalk.green('\n✓ Telegram bot started (systemd service)\n'))
  } catch {
    console.log(chalk.red('\n✗ Failed to start bot service. Run install.sh first.\n'))
  }
}

function stopBot() {
  try {
    execSync('systemctl stop vps-bot-telegram', { stdio: 'inherit' })
    console.log(chalk.green('\n✓ Telegram bot stopped\n'))
  } catch {
    console.log(chalk.gray('\nBot was not running.\n'))
  }
}

// ── Password ─────────────────────────────────────────────────────────────────

async function configurePassword(nav) {
  console.clear()
  console.log(chalk.cyan('\n  Code-Server Password\n'))
  const { password } = await inquirer.prompt([{
    type: 'input',
    name: 'password',
    message: 'New Code-Server password:',
    validate: (input) => input && input.length >= 4 ? true : 'Min 4 characters',
  }])

  updateEnvVar('CODE_SERVER_PASSWORD', password)

  const csConfigPath = join(process.env.HOME || '/root', '.config/code-server/config.yaml')
  try {
    let csConfig = readFileSync(csConfigPath, 'utf-8')
    csConfig = csConfig.replace(/^password:.*$/m, `password: ${password}`)
    writeFileSync(csConfigPath, csConfig)
  } catch (err) {
    console.log(chalk.yellow(`⚠ Could not update ${csConfigPath}: ${err.message}`))
  }

  try {
    execSync('systemctl restart code-server', { stdio: 'ignore' })
    console.log(chalk.green(`\n✓ Password updated and code-server restarted. New password: ${password}\n`))
  } catch {
    console.log(chalk.green(`\n✓ Password updated. New password: ${password}`))
    console.log(chalk.yellow('⚠ Could not restart code-server. Run: systemctl restart code-server\n'))
  }
  await inquirer.prompt([{ type: 'list', name: 'back', message: '', loop: false, choices: ['← Back'] }])
  return showConfig(nav)
}

// ── Auto-sleep ───────────────────────────────────────────────────────────────

async function configureIdleTimeout(nav) {
  console.clear()
  console.log(chalk.cyan('\n  Auto-sleep\n'))
  const current = config.idleTimeout
  console.log(chalk.gray(`  Current: ${current > 0 ? `${current} minutes` : 'disabled'}`))
  console.log(chalk.gray('  Idle containers are stopped to save resources.'))
  console.log(chalk.gray('  They wake automatically on the next request.\n'))

  const { timeout } = await inquirer.prompt([{
    type: 'list',
    name: 'timeout',
    message: 'Stop idle containers after:',
    loop: false,
    choices: [
      { name: 'Disabled', value: '0' },
      { name: '5 minutes', value: '5' },
      { name: '10 minutes', value: '10' },
      { name: '30 minutes', value: '30' },
      { name: '60 minutes', value: '60' },
    ],
  }])

  updateEnvVar('IDLE_TIMEOUT', timeout)

  if (timeout === '0') {
    console.log(chalk.green('\n✓ Auto-sleep disabled\n'))
  } else {
    console.log(chalk.green(`\n✓ Containers will sleep after ${timeout}m of inactivity\n`))
  }

  return showConfig(nav)
}
