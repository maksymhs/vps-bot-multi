// builder-server.js — runs INSIDE the Docker builder container
// Calls OpenRouter/DeepSeek, streams output to browser via SSE, writes files to /workspace
// Uses only Node.js built-ins (http, fs, path) + global fetch (Node 18+)
'use strict'

const http = require('http')
const fs   = require('fs')
const path = require('path')

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'
const PORT      = 3000
const OR_KEY    = process.env.OPENROUTER_API_KEY || ''
const PROJECT   = process.env.PROJECT_NAME       || 'app'
const MODEL     = process.env.MODEL              || 'deepseek/deepseek-chat-v3-0324'

// ── State ──────────────────────────────────────────────────────────────────
let state        = 'building' // 'building' | 'done' | 'error'
let buildError   = null
let filesWritten = 0
const sseClients = []

// ── SSE broadcast ──────────────────────────────────────────────────────────
function broadcast(obj) {
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n'
  for (const res of sseClients) try { res.write(msg) } catch {}
}

// ── Streaming file parser (same logic as projects.js generateCode) ─────────
let currentFile  = null
let contentLines = []

function writeProjectFile(filename, content) {
  if (!filename || filename.includes('..')) return
  const p = path.join(WORKSPACE, filename)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    filesWritten++
    broadcast({ type: 'file', name: filename, size: content.length })
    console.log('[builder] wrote:', filename, '(' + content.length + 'B)')
  } catch (err) {
    broadcast({ type: 'status', message: 'Write error: ' + err.message })
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

// ── AI generation ──────────────────────────────────────────────────────────
async function runGeneration() {
  broadcast({ type: 'status', message: 'Reading build prompt...' })
  let prompt, systemPrompt
  try {
    prompt       = fs.readFileSync(path.join(WORKSPACE, '.build-prompt.txt'), 'utf8')
    systemPrompt = fs.readFileSync(path.join(WORKSPACE, '.build-system-prompt.txt'), 'utf8')
  } catch (err) {
    state      = 'error'
    buildError = 'Cannot read prompt: ' + err.message
    broadcast({ type: 'error', message: buildError })
    fs.writeFileSync(path.join(WORKSPACE, '.build-error'), buildError)
    return
  }

  broadcast({ type: 'status', message: 'Calling DeepSeek via OpenRouter...' })
  console.log('[builder] calling OpenRouter model:', MODEL)

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OR_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vps-bot-multi.local',
        'X-Title': 'VPS-Bot-Multi',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: prompt },
        ],
        max_tokens: 16384,
        stream: true,
      }),
    })

    if (!res.ok) {
      const txt = await res.text()
      throw new Error('OpenRouter ' + res.status + ': ' + txt.slice(0, 300))
    }

    broadcast({ type: 'status', message: 'Streaming response...' })

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let sseBuffer = ''
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

    state = 'done'
    fs.writeFileSync(path.join(WORKSPACE, '.build-complete'), String(filesWritten))
    broadcast({ type: 'done', filesWritten })
    console.log('[builder] done —', filesWritten, 'files written')

  } catch (err) {
    state      = 'error'
    buildError = err.message
    broadcast({ type: 'error', message: buildError })
    fs.writeFileSync(path.join(WORKSPACE, '.build-error'), buildError)
    console.error('[builder] error:', buildError)
  }
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
.er{color:#f85149}
.cd{color:#c9d1d9}
.partial{color:#c9d1d9}
.cursor{display:inline-block;width:7px;height:13px;background:#58a6ff;animation:bl .85s step-end infinite;vertical-align:middle;margin-left:1px}
@keyframes bl{50%{opacity:0}}
.footbar{background:#1f6feb;padding:7px 18px;font-size:12px;color:#fff;display:flex;justify-content:space-between;flex-shrink:0;transition:background .3s}
.footbar.done{background:#238636}
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
  <span>status: <span class="v" id="st">connecting...</span></span>
</div>
<div id="console"></div>
<div class="footbar" id="fb">
  <span id="fb-left">DeepSeek is generating your app...</span>
  <span>⚡ OpenRouter</span>
</div>
<script>
const con   = document.getElementById('console')
const fcEl  = document.getElementById('fc')
const stEl  = document.getElementById('st')
const fb    = document.getElementById('fb')
const fbL   = document.getElementById('fb-left')
const timer = document.getElementById('timer')

const t0 = Date.now()
setInterval(function() { timer.textContent = Math.round((Date.now()-t0)/1000)+'s' }, 1000)

let buf = ''
let partialEl = null
let fileCount = 0

function appendLine(text, cls) {
  if (partialEl) { partialEl.remove(); partialEl = null }
  const d = document.createElement('div')
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
  const txt = document.createTextNode(buf)
  const cur = document.createElement('span')
  cur.className = 'cursor'
  partialEl.appendChild(txt)
  partialEl.appendChild(cur)
  con.appendChild(partialEl)
  con.scrollTop = con.scrollHeight
}

function onChunk(text) {
  buf += text
  const lines = buf.split('\\n')
  buf = lines.pop()
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var cls = 'cd'
    if (line.indexOf('--- FILE:') === 0)    cls = 'sf'
    else if (line.indexOf('--- END FILE') === 0) cls = 'ef'
    appendLine(line, cls)
  }
  showPartial()
}

const es = new EventSource('/events')
es.onmessage = function(e) {
  var d = JSON.parse(e.data)
  if (d.type === 'status') {
    stEl.textContent = d.message
    appendLine('> ' + d.message, 'st')
  } else if (d.type === 'chunk') {
    onChunk(d.content)
  } else if (d.type === 'file') {
    fileCount++
    fcEl.textContent = fileCount
  } else if (d.type === 'done') {
    if (partialEl) { partialEl.remove(); partialEl = null }
    appendLine('')
    appendLine('✓ ' + d.filesWritten + ' files written — rebuilding container...', 'sf')
    stEl.textContent = 'done'
    fb.className = 'footbar done'
    fbL.textContent = '✓ Done! Container is rebuilding...'
    es.close()
    setTimeout(pollApp, 2000)
  } else if (d.type === 'error') {
    if (partialEl) { partialEl.remove(); partialEl = null }
    appendLine('✗ ERROR: ' + d.message, 'er')
    stEl.textContent = 'error'
    fb.className = 'footbar err'
    fbL.textContent = '✗ Build error — check logs'
    es.close()
  }
}

es.onerror = function() { es.close(); setTimeout(pollApp, 3000) }

function pollApp() {
  fetch('/health').then(function(r) { return r.json() }).then(function(d) {
    if (!d.loading && !d.done) {
      location.reload()
    } else {
      setTimeout(pollApp, 2000)
    }
  }).catch(function() {
    setTimeout(function() { location.reload() }, 3000)
  })
}
</script>
</body>
</html>`

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  const url = req.url ? req.url.split('?')[0] : '/'

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      status:       buildError ? 'error' : 'ok',
      loading:      state === 'building',
      done:         state === 'done',
      filesWritten,
      error:        buildError,
    }))
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    res.write('retry: 3000\n\n')
    res.write('data: ' + JSON.stringify({ type: 'connected', status: state }) + '\n\n')
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

server.listen(PORT, function() {
  console.log('[builder] server on :' + PORT + '  project=' + PROJECT)
  setTimeout(runGeneration, 800)
})
