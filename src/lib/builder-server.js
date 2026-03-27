// builder-server.js — runs INSIDE the Docker container
// Flow: serve web console → call DeepSeek → write files → npm install → npm build → spawn app
// Uses only Node.js built-ins + global fetch (Node 18+). No external deps.
import http from 'http'
import fs   from 'fs'
import path from 'path'
import cp   from 'child_process'

const WORKSPACE = process.env.WORKSPACE_DIR || '/app'
const PORT      = 3000
const OR_KEY    = process.env.OPENROUTER_API_KEY || ''
const PROJECT   = process.env.PROJECT_NAME       || 'app'
const MODEL     = process.env.MODEL              || 'deepseek/deepseek-chat-v3-0324'

// Files the AI must not overwrite
const PROTECTED = new Set([
  'builder-server.js', '.build-prompt.txt', '.build-system-prompt.txt',
  'docker-compose.yml', 'Dockerfile',
])

// ── State ──────────────────────────────────────────────────────────────────
let state        = 'building'   // 'building' | 'installing' | 'error'
let buildError   = null
let filesWritten = 0
const sseClients = []

// ── SSE helpers ────────────────────────────────────────────────────────────
function broadcast(obj) {
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n'
  for (const res of sseClients) try { res.write(msg) } catch {}
}

// ── File writer ────────────────────────────────────────────────────────────
let currentFile  = null
let contentLines = []

function writeProjectFile(filename, content) {
  if (!filename || filename.includes('..') || PROTECTED.has(path.basename(filename))) return
  const p = path.join(WORKSPACE, filename)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    filesWritten++
    broadcast({ type: 'file', name: filename, size: content.length })
    console.log('[builder] wrote:', filename, '(' + content.length + 'B)')
  } catch (err) {
    broadcast({ type: 'log', content: 'Write error: ' + err.message + '\n' })
  }
}

function commitFile() {
  if (!currentFile) return
  writeProjectFile(currentFile, contentLines.join('\n'))
  currentFile = null
  contentLines = []
}

function processLine(line) {
  const m = line.match(/^---\s*FILE:\s*(.+?)\s*---$/)
  if (m) { commitFile(); currentFile = m[1].trim(); contentLines = []; return }
  if (/^---\s*END FILE\s*---$/.test(line)) { commitFile(); return }
  if (currentFile !== null) contentLines.push(line)
}

// ── Spawn helper: streams stdout+stderr to SSE as 'log' events ─────────────
function spawnStreaming(cmd, args) {
  return new Promise(function(resolve, reject) {
    const child = cp.spawn(cmd, args, { cwd: WORKSPACE, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', function(d) { broadcast({ type: 'log', content: d.toString() }) })
    child.stderr.on('data', function(d) { broadcast({ type: 'log', content: d.toString() }) })
    child.on('close', function(code) {
      if (code === 0) resolve()
      else reject(new Error(cmd + ' ' + args.join(' ') + ' exited with code ' + code))
    })
    child.on('error', reject)
  })
}

// ── Error handler ──────────────────────────────────────────────────────────
function fail(msg) {
  state      = 'error'
  buildError = msg
  broadcast({ type: 'error', message: msg })
  try { fs.writeFileSync(path.join(WORKSPACE, '.build-error'), msg) } catch {}
  console.error('[builder] error:', msg)
}

const MAX_AUTOFIX = 1   // auto-patch retries on quick startup crash

// ── Main pipeline: generate → install → build → launch ────────────────────
// errorContext: runtime error string from a previous crash (null on first run)
// Returns: error string if app crashed quickly (caller should retry), else undefined
async function runAll(errorContext) {
  // ── 1. Read prompts ───────────────────────────────────────────────────────
  broadcast({ type: 'status', message: errorContext ? 'AI is patching the error...' : 'Reading build prompt...' })
  let prompt, systemPrompt
  try {
    prompt       = fs.readFileSync(path.join(WORKSPACE, '.build-prompt.txt'), 'utf8')
    systemPrompt = fs.readFileSync(path.join(WORKSPACE, '.build-system-prompt.txt'), 'utf8')
  } catch (err) {
    return fail('Cannot read prompt: ' + err.message)
  }

  // Append runtime error context so DeepSeek knows what to fix
  if (errorContext) {
    prompt += '\n\n--- STARTUP ERROR TO FIX ---\n' + errorContext.slice(0, 1500) + '\n--- END ERROR ---'
  }

  // Snapshot package.json before generation — used later to skip npm install if unchanged
  let pkgJsonBefore = ''
  try { pkgJsonBefore = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8') } catch {}

  // ── 2. Call DeepSeek via OpenRouter ──────────────────────────────────────
  broadcast({ type: 'status', message: 'Calling DeepSeek...' })
  console.log('[builder] model:', MODEL)
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OR_KEY,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://vps-bot-multi.local',
        'X-Title':       'VPS-Bot-Multi',
      },
      body: JSON.stringify({
        model:      MODEL,
        messages:   [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: prompt },
        ],
        max_tokens: 16384,
        stream:     true,
      }),
    })

    if (!res.ok) {
      const txt = await res.text()
      return fail('OpenRouter ' + res.status + ': ' + txt.slice(0, 300))
    }

    broadcast({ type: 'status', message: 'Generating files...' })

    const reader   = res.body.getReader()
    const decoder  = new TextDecoder()
    let sseBuffer  = ''
    let textBuffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sseBuffer += decoder.decode(value, { stream: true })
      const lines = sseBuffer.split('\n')
      sseBuffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data).choices?.[0]?.delta?.content
          if (chunk) {
            broadcast({ type: 'chunk', content: chunk })
            textBuffer += chunk
            const parts = textBuffer.split('\n')
            textBuffer = parts.pop()
            for (const part of parts) processLine(part)
          }
        } catch {}
      }
    }
    if (textBuffer) processLine(textBuffer)
    commitFile()
    console.log('[builder] generation done —', filesWritten, 'files')
  } catch (err) {
    return fail(err.message)
  }

  // ── 3. npm install (skip if package.json unchanged — deps already in image) ─
  state = 'installing'
  let pkgJsonAfter = ''
  try { pkgJsonAfter = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8') } catch {}
  const nodeModulesExists = fs.existsSync(path.join(WORKSPACE, 'node_modules'))
  const depsChanged = pkgJsonBefore !== pkgJsonAfter || !nodeModulesExists
  if (depsChanged) {
    broadcast({ type: 'phase', phase: 'install', message: 'Installing dependencies...' })
    try {
      await spawnStreaming('npm', ['install'])
    } catch (err) {
      return fail('npm install failed: ' + err.message)
    }
  } else {
    broadcast({ type: 'phase', phase: 'install', message: 'Dependencies up to date, skipping install...' })
  }

  // ── 4. npm run build (optional) ───────────────────────────────────────────
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'))
    if (pkg.scripts && pkg.scripts.build) {
      broadcast({ type: 'phase', phase: 'build', message: 'Building...' })
      await spawnStreaming('npm', ['run', 'build'])
    }
  } catch {}

  // ── 5. Resolve start command ──────────────────────────────────────────────
  let startBin  = 'node'
  let startArgs = ['src/index.js']
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'))
    const startScript = (pkg.scripts && pkg.scripts.start) || 'node src/index.js'
    const parts = startScript.trim().split(/\s+/)
    startBin  = parts[0]
    startArgs = parts.slice(1)
  } catch {}

  // ── 6. Signal browser, close server, spawn app ────────────────────────────
  broadcast({ type: 'launching', message: 'Launching app...' })
  console.log('[builder] launching:', startBin, startArgs.join(' '))

  // Returns error string if app crashes within CRASH_WINDOW_MS, else process.exit()
  const CRASH_WINDOW_MS = 6000
  const crashError = await new Promise(function(resolve) {
    server.close(function() {
      setTimeout(function() {
        let errorOutput = ''
        const startedAt = Date.now()
        const app = cp.spawn(startBin, startArgs, {
          cwd:      WORKSPACE,
          stdio:    ['ignore', 'pipe', 'pipe'],
          detached: false,
        })
        app.stdout.on('data', function(d) { process.stdout.write(d); errorOutput += d.toString() })
        app.stderr.on('data', function(d) { process.stderr.write(d); errorOutput += d.toString() })
        app.on('error', function(err) { resolve(err.message) })
        app.on('exit',  function(code) {
          const quickCrash = code !== 0 && (Date.now() - startedAt) < CRASH_WINDOW_MS
          if (quickCrash) resolve(errorOutput.slice(-1500))
          else process.exit(code || 0)
        })
      }, 300)
    })
  })

  return crashError   // signals caller to retry with this error as context
}

// ── Web console HTML ───────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Building ${PROJECT}...</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#0d1117;color:#c9d1d9;font-family:'SF Mono','Fira Mono',Consolas,monospace;display:flex;flex-direction:column;overflow:hidden}
.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:10px 18px;display:flex;align-items:center;gap:8px;flex-shrink:0}
.traffic{display:flex;gap:6px}
.dot{width:12px;height:12px;border-radius:50%}
.dot-r{background:#ff5f57}.dot-y{background:#ffbd2e}.dot-g{background:#28ca41}
.title{margin-left:10px;color:#8b949e;font-size:13px}
.title b{color:#e6edf3}
#timer{margin-left:auto;color:#484f58;font-size:12px}
.statbar{background:#0d1117;border-bottom:1px solid #21262d;padding:6px 18px;display:flex;gap:24px;font-size:12px;color:#484f58;flex-shrink:0}
.v{color:#79c0ff}
#console{flex:1;overflow-y:auto;padding:14px 18px;font-size:12.5px;line-height:1.55}
#console::-webkit-scrollbar{width:5px}
#console::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
.sf{color:#3fb950;font-weight:600}
.ef{color:#21262d}
.st{color:#58a6ff}
.lg{color:#8b949e}
.er{color:#f85149}
.cd{color:#c9d1d9}
.partial{color:#c9d1d9}
.cursor{display:inline-block;width:7px;height:13px;background:#58a6ff;animation:bl .85s step-end infinite;vertical-align:middle;margin-left:1px}
@keyframes bl{50%{opacity:0}}
.footbar{background:#1f6feb;padding:7px 18px;font-size:12px;color:#fff;display:flex;justify-content:space-between;flex-shrink:0;transition:background .3s}
.footbar.install{background:#9e6a03}
.footbar.launch{background:#238636}
.footbar.err{background:#da3633}
</style>
</head>
<body>
<div class="topbar">
  <div class="traffic">
    <div class="dot dot-r"></div>
    <div class="dot dot-y"></div>
    <div class="dot dot-g"></div>
  </div>
  <div class="title">Building <b>${PROJECT}</b></div>
  <div id="timer">0s</div>
</div>
<div class="statbar">
  <span>files: <span class="v" id="fc">0</span></span>
  <span>phase: <span class="v" id="ph">generating</span></span>
</div>
<div id="console"></div>
<div class="footbar" id="fb">
  <span id="fb-left">DeepSeek is generating your app...</span>
  <span>⚡ OpenRouter</span>
</div>
<script>
var con   = document.getElementById('console')
var fcEl  = document.getElementById('fc')
var phEl  = document.getElementById('ph')
var fb    = document.getElementById('fb')
var fbL   = document.getElementById('fb-left')
var timer = document.getElementById('timer')

var t0 = Date.now()
setInterval(function() { timer.textContent = Math.round((Date.now()-t0)/1000)+'s' }, 1000)

var buf = ''
var partialEl = null
var fileCount = 0

function appendLine(text, cls) {
  if (partialEl) { partialEl.remove(); partialEl = null }
  var d = document.createElement('div')
  d.className = cls || 'cd'
  d.textContent = text
  con.appendChild(d)
  con.scrollTop = con.scrollHeight
}

function showPartial() {
  if (!buf) return
  if (partialEl) partialEl.remove()
  partialEl = document.createElement('div')
  partialEl.className = 'partial'
  var txt = document.createTextNode(buf)
  var cur = document.createElement('span')
  cur.className = 'cursor'
  partialEl.appendChild(txt)
  partialEl.appendChild(cur)
  con.appendChild(partialEl)
  con.scrollTop = con.scrollHeight
}

function onChunk(text) {
  buf += text
  var lines = buf.split('\\n')
  buf = lines.pop()
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var cls = 'cd'
    if (line.indexOf('--- FILE:') === 0)     cls = 'sf'
    else if (line.indexOf('--- END FILE') === 0) cls = 'ef'
    appendLine(line, cls)
  }
  showPartial()
}

function pollAndReload() {
  fetch('/health').then(function(r) { return r.json() }).then(function(d) {
    if (!d.loading) setTimeout(function() { location.reload() }, 1000)
    else setTimeout(pollAndReload, 2000)
  }).catch(function() {
    // server closed — app is starting up
    setTimeout(function() { location.reload() }, 2000)
  })
}

var es = new EventSource('/events')
es.onmessage = function(e) {
  var d = JSON.parse(e.data)

  if (d.type === 'status') {
    appendLine('> ' + d.message, 'st')

  } else if (d.type === 'chunk') {
    onChunk(d.content)

  } else if (d.type === 'file') {
    fileCount++
    fcEl.textContent = fileCount

  } else if (d.type === 'phase') {
    if (partialEl) { partialEl.remove(); partialEl = null }
    appendLine('')
    appendLine('── ' + d.message, 'st')
    phEl.textContent = d.phase
    if (d.phase === 'install') {
      fb.className = 'footbar install'
      fbL.textContent = 'Installing dependencies...'
    } else if (d.phase === 'build') {
      fbL.textContent = 'Building...'
    }

  } else if (d.type === 'log') {
    // npm install / build output — split by newline
    var lines = d.content.split('\\n')
    for (var i = 0; i < lines.length; i++) {
      if (lines[i]) appendLine(lines[i], 'lg')
    }

  } else if (d.type === 'launching') {
    appendLine('')
    appendLine('── ' + d.message, 'sf')
    phEl.textContent = 'launching'
    fb.className = 'footbar launch'
    fbL.textContent = 'App is starting...'
    es.close()
    setTimeout(pollAndReload, 1500)

  } else if (d.type === 'error') {
    if (partialEl) { partialEl.remove(); partialEl = null }
    appendLine('')
    appendLine('✗ ' + d.message, 'er')
    phEl.textContent = 'error'
    fb.className = 'footbar err'
    fbL.textContent = '✗ Build failed'
    es.close()
  }
}

es.onerror = function() { es.close(); setTimeout(pollAndReload, 3000) }
</script>
</body>
</html>`

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  const url = req.url ? req.url.split('?')[0] : '/'

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      status:  buildError ? 'error' : 'ok',
      loading: state !== 'error',
      error:   buildError,
    }))
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    res.write('retry: 3000\n\n')
    res.write('data: ' + JSON.stringify({ type: 'connected', state }) + '\n\n')
    sseClients.push(res)
    req.on('close', function() {
      const i = sseClients.indexOf(res)
      if (i >= 0) sseClients.splice(i, 1)
    })
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
})

async function runWithAutofix() {
  let errorContext = null
  for (let attempt = 1; attempt <= 1 + MAX_AUTOFIX; attempt++) {
    if (attempt > 1) {
      console.log('[builder] auto-fix attempt', attempt)
      await new Promise(r => setTimeout(r, 600))        // wait for port to free
      await new Promise(r => server.listen(PORT, r))    // reopen builder console
      state = 'building'; buildError = null; filesWritten = 0
      broadcast({ type: 'phase', phase: 'fixing', message: 'App crashed — AI is patching...' })
    }
    errorContext = await runAll(errorContext)
    if (!errorContext) break                             // stable exit handled inside runAll
  }
  if (errorContext) {
    fail('App failed to start after auto-fix:\n' + errorContext.slice(-600))
  }
}

server.listen(PORT, function() {
  console.log('[builder] server on :' + PORT + '  project=' + PROJECT)
  setTimeout(runWithAutofix, 800)
})
