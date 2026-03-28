// builder-server.js — runs INSIDE the Docker container (permanent proxy + AI builder)
// Architecture:
//   Port 3000 (public) — builder-server.js always alive: serves console, handles /rebuild, proxies to app
//   Port 3001 (internal) — real app spawned here after build
//
// Flow: serve console → DeepSeek → write files → npm install → npm build → spawn app on 3001
//       On /rebuild: kill app → DeepSeek patch → npm install → respawn on 3001
// Uses only Node.js built-ins + global fetch (Node 18+). No external deps.
import http from 'http'
import net  from 'net'
import fs   from 'fs'
import path from 'path'
import cp   from 'child_process'

const WORKSPACE      = process.env.WORKSPACE_DIR    || '/app'
const PORT           = 3000          // builder always listens here (public)
const APP_PORT       = 3001          // real app runs here (internal)
const OR_KEY         = process.env.OPENROUTER_API_KEY || ''
const PROJECT        = process.env.PROJECT_NAME       || 'app'
const MODEL          = process.env.MODEL              || 'deepseek/deepseek-chat-v3-0324'
const REBUILD_SECRET = process.env.REBUILD_SECRET     || ''

// Files the AI must not overwrite
const PROTECTED = new Set([
  'builder-server.js', '.build-prompt.txt', '.build-system-prompt.txt', '.build-config.json',
  'docker-compose.yml', 'Dockerfile',
])

// ── State ───────────────────────────────────────────────────────────────────
let state        = 'building'  // 'building' | 'installing' | 'running' | 'error'
let buildError   = null
let filesWritten = 0
let currentApp   = null        // child process for the running app
let currentPhase = 'starting'  // fine-grained phase exposed via /health for Telegram progress bar
const sseClients = []
const sseBuffer  = []       // replay buffer — late-joining clients get full history
const SSE_BUF_MAX = 300

// ── SSE helpers ─────────────────────────────────────────────────────────────
function broadcast(obj) {
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n'
  sseBuffer.push(msg)
  if (sseBuffer.length > SSE_BUF_MAX) sseBuffer.shift()
  for (const res of sseClients) try { res.write(msg) } catch {}
}

// ── File writer ─────────────────────────────────────────────────────────────
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

// ── Spawn helper: streams stdout+stderr to SSE as 'log' events ──────────────
// capture=true: attaches full output to the rejected Error as .output (for error feedback)
function spawnStreaming(cmd, args, capture) {
  return new Promise(function(resolve, reject) {
    let out = ''
    const child = cp.spawn(cmd, args, { cwd: WORKSPACE, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', function(d) { const s = d.toString(); broadcast({ type: 'log', content: s }); if (capture) out += s })
    child.stderr.on('data', function(d) { const s = d.toString(); broadcast({ type: 'log', content: s }); if (capture) out += s })
    child.on('close', function(code) {
      if (code === 0) resolve(out)
      else { const e = new Error(cmd + ' ' + args.join(' ') + ' exited ' + code); e.output = out; reject(e) }
    })
    child.on('error', reject)
  })
}

// ── Error handler ────────────────────────────────────────────────────────────
function fail(msg) {
  state      = 'error'
  buildError = msg
  broadcast({ type: 'error', message: msg })
  try { fs.writeFileSync(path.join(WORKSPACE, '.build-error'), msg) } catch {}
  console.error('[builder] error:', msg)
}

// ── App spawn: runs on APP_PORT, detects quick startup crashes ───────────────
// Returns: error string if app crashed quickly, undefined if stable
const CRASH_WINDOW_MS = 6000

// Kill the app AND its entire process group (npm → sh → next dev).
// Without this, killing npm leaves sh+next orphaned and port 3001 still in use.
function killCurrentApp() {
  if (!currentApp) return
  const pid = currentApp.pid
  currentApp = null
  if (pid) {
    try { process.kill(-pid, 'SIGKILL') } catch {}  // kill process group
  }
}

// Poll APP_PORT until it accepts a TCP connection, then resolve.
function waitForPort(port, timeoutMs) {
  return new Promise(function(resolve) {
    const deadline = Date.now() + (timeoutMs || 30000)
    function attempt() {
      const sock = net.createConnection(port, '127.0.0.1')
      sock.once('connect', function() { sock.destroy(); resolve(true) })
      sock.once('error', function() {
        sock.destroy()
        if (Date.now() >= deadline) { resolve(false); return }
        setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

function spawnApp(bin, args) {
  return new Promise(function(resolve) {
    let errorOutput = ''
    const startedAt = Date.now()

    currentApp = cp.spawn(bin, args, {
      cwd:      WORKSPACE,
      env:      Object.assign({}, process.env, { PORT: String(APP_PORT), NEXT_TELEMETRY_DISABLED: '1' }),
      stdio:    ['ignore', 'pipe', 'pipe'],
      detached: true,   // create own process group so killCurrentApp(-pid) only kills the app tree
    })

    currentApp.stdout.on('data', function(d) { process.stdout.write(d); errorOutput += d.toString() })
    currentApp.stderr.on('data', function(d) { process.stderr.write(d); errorOutput += d.toString() })

    let settled = false
    function settle(errMsg) {
      if (settled) return; settled = true
      resolve(errMsg)
    }

    currentApp.on('error', function(err) {
      currentApp = null
      state = 'building'
      settle(err.message)
    })

    currentApp.on('exit', function(code, signal) {
      currentApp = null
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        settle(undefined)
        return
      }
      const quickCrash = code !== 0 && (Date.now() - startedAt) < CRASH_WINDOW_MS
      if (quickCrash) {
        state = 'building'
        settle(errorOutput.slice(-1500))
      } else {
        process.exit(code || 0)
      }
    })

    // Wait until the app is actually accepting connections, then warm up the first page
    // so the browser doesn't get a blank compile-wait when it reloads.
    waitForPort(APP_PORT, 30000).then(async function(ok) {
      if (settled) return
      if (!ok) { settle('Timed out waiting for app to listen on port ' + APP_PORT); return }
      // Pre-compile the root route so the first browser request is instant
      try {
        const ctrl = new AbortController()
        setTimeout(() => ctrl.abort(), 15000)
        await fetch('http://127.0.0.1:' + APP_PORT + '/', { signal: ctrl.signal })
      } catch {}
      if (settled) return
      state = 'running'
      currentPhase = 'running'
      broadcast({ type: 'ready', state: 'running' })  // tells loading page / watcher to reload
    })
  })
}

// ── Enumerate workspace files for patch context ──────────────────────────────
function getWorkspaceFiles() {
  const result = []
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite'])
  function walk(dir, rel) {
    let entries
    try { entries = fs.readdirSync(dir) } catch { return }
    for (const e of entries) {
      if (e.startsWith('.') && e !== '.env') continue
      if (SKIP_DIRS.has(e)) continue
      const full = path.join(dir, e)
      const relPath = rel ? rel + '/' + e : e
      try {
        if (fs.statSync(full).isDirectory()) walk(full, relPath)
        else result.push(relPath)
      } catch {}
    }
  }
  walk(WORKSPACE, '')
  return result
}

// ── Main pipeline: generate → install → build → launch ──────────────────────
// errorContext: runtime error from previous crash (null on first run)
// Returns: error string if app crashed quickly, undefined if stable (process.exit handled internally)
async function runAll(errorContext) {
  // Reset per-run state
  filesWritten = 0
  currentFile  = null
  contentLines = []
  currentPhase = 'starting'
  sseBuffer.length = 0   // clear replay buffer so new clients don't see previous build

  // ── 1. Read prompts ─────────────────────────────────────────────────────────
  broadcast({ type: 'status', message: errorContext ? 'AI is patching the error...' : 'Reading build prompt...' })
  let prompt, systemPrompt
  try {
    prompt       = fs.readFileSync(path.join(WORKSPACE, '.build-prompt.txt'), 'utf8')
    systemPrompt = fs.readFileSync(path.join(WORKSPACE, '.build-system-prompt.txt'), 'utf8')
  } catch (err) {
    fail('Cannot read prompt: ' + err.message)
    return
  }

  // Append runtime error context so DeepSeek knows what to fix
  if (errorContext) {
    prompt += '\n\n--- STARTUP ERROR TO FIX ---\n' + errorContext.slice(0, 1500) + '\n--- END ERROR ---'
  }

  // Snapshot package.json before generation — used later to skip npm install if unchanged
  let pkgJsonBefore = ''
  try { pkgJsonBefore = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8') } catch {}

  // ── 2. Call DeepSeek via OpenRouter ─────────────────────────────────────────
  let maxTokens = 14000
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, '.build-config.json'), 'utf8'))
    if (cfg.maxTokens) maxTokens = cfg.maxTokens
  } catch {}

  currentPhase = 'thinking'
  broadcast({ type: 'status', message: 'Calling DeepSeek...' })
  console.log('[builder] model:', MODEL, 'max_tokens:', maxTokens)
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
        max_tokens: maxTokens,
        stream:     true,
      }),
    })

    if (!res.ok) {
      const txt = await res.text()
      fail('OpenRouter ' + res.status + ': ' + txt.slice(0, 300))
      return
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
    fail(err.message)
    return
  }

  // ── 3. npm install (skip if package.json unchanged — deps already in image) ──
  state = 'installing'
  currentPhase = 'installing'
  let pkgJsonAfter = ''
  try { pkgJsonAfter = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8') } catch {}
  const nodeModulesExists = fs.existsSync(path.join(WORKSPACE, 'node_modules'))
  const depsChanged = depsKey(pkgJsonBefore) !== depsKey(pkgJsonAfter) || !nodeModulesExists
  if (depsChanged) {
    broadcast({ type: 'phase', phase: 'install', message: 'Installing dependencies...' })
    try {
      await spawnStreaming('npm', ['install'])
    } catch (err) {
      fail('npm install failed: ' + err.message)
      return
    }
  } else {
    broadcast({ type: 'phase', phase: 'install', message: 'Dependencies up to date, skipping install...' })
  }

  // ── 4. npm run build (optional) ─────────────────────────────────────────────
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'))
    if (pkg.scripts && pkg.scripts.build) {
      currentPhase = 'building'
      broadcast({ type: 'phase', phase: 'build', message: 'Building...' })
      await spawnStreaming('npm', ['run', 'build'])
    }
  } catch {}

  // ── 5. Resolve start command ─────────────────────────────────────────────────
  // Always use `npm start` so npm injects node_modules/.bin into PATH automatically.
  let startBin  = 'node'
  let startArgs = ['src/index.js']
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'))
    if (pkg.scripts && pkg.scripts.start) { startBin = 'npm'; startArgs = ['start'] }
  } catch {}

  // ── 6. Launch app on APP_PORT (builder stays alive as proxy on PORT) ─────────
  currentPhase = 'launching'
  broadcast({ type: 'launching', message: 'Launching app...' })
  console.log('[builder] launching:', startBin, startArgs.join(' '), 'on port', APP_PORT)

  return await spawnApp(startBin, startArgs)
}

const MAX_AUTOFIX = 1

async function runWithAutofix() {
  // Check build mode: 'patch' = agentic tool loop, 'generate' = streaming text
  let mode = 'generate'
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, '.build-config.json'), 'utf8'))
    mode = cfg.mode || 'generate'
  } catch {}

  if (mode === 'patch') {
    // Template builds and HTTP rebuilds both use the agentic agent
    let description = ''
    try { description = fs.readFileSync(path.join(WORKSPACE, '.build-prompt.txt'), 'utf8') } catch {}

    // Pre-launch boilerplate immediately for templates that need no build step
    // so there is something visible at the URL while the agent customises in background
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'))
      const hasModules = fs.existsSync(path.join(WORKSPACE, 'node_modules'))
      const noBuildStep = !(pkg.scripts && pkg.scripts.build)
      if (noBuildStep && hasModules && pkg.scripts && pkg.scripts.start) {
        broadcast({ type: 'log', content: '▸ Boilerplate is live — agent customising in background...\n' })
        spawnApp('npm', ['start'])  // fire-and-forget: npm resolves node_modules/.bin
      }
    } catch {}

    await runAgenticPatch(description)
    return
  }

  // mode === 'generate': no template matched, full file generation
  let errorContext = null
  for (let attempt = 1; attempt <= 1 + MAX_AUTOFIX; attempt++) {
    if (attempt > 1) {
      console.log('[builder] auto-fix attempt', attempt)
      state = 'building'
      buildError = null
      broadcast({ type: 'phase', phase: 'fixing', message: 'App crashed — AI is patching...' })
    }
    errorContext = await runAll(errorContext)
    if (!errorContext) break
  }
  if (errorContext) {
    fail('App failed to start after auto-fix:\n' + errorContext.slice(-600))
  }
}

// ── Agentic patch: tool-calling loop for surgical file edits ─────────────────
// The agent reads files, makes targeted replacements, never rewrites entire files.
// Mirrors Claude Code's approach: Read → Edit (old→new) → done.

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all project files (excludes node_modules, dist)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Always read before editing.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to /app' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file. old_string must match exactly (whitespace included). Use read_file first to get the exact text.',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to find — must exist verbatim in the file' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a complete file. Use ONLY for new files that do not exist yet. For existing files use edit_file.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
]

const AGENT_SYSTEM = `You are a surgical code editor working on a live web app at /app.
Apply ONLY the minimal change needed for the user's request.

Workflow:
1. Call list_files to see the project structure
2. Call read_file on the relevant file(s)
3. Call edit_file to make targeted replacements (never rewrite entire files)
4. Use write_file only for brand-new files
5. When done, stop calling tools — return a short summary of what you changed

Error-fixing workflow (when given BUILD or RUNTIME errors):
1. Read the error message carefully to identify the exact file and line
2. Call read_file on that file to see the current content
3. Call edit_file to fix only the broken part — do not rewrite the file
4. Fix one error at a time; re-read if needed

Rules:
- Read before editing — old_string must match exactly
- Change only what is required. Preserve everything else.
- Never touch unrelated files
- Keep GET /health → { status: "ok" } working
- App must use process.env.PORT for its listen port`

const AGENT_MAX_ITERS  = 14
const MAX_FIX_ATTEMPTS = 2   // max retry rounds on build/crash error

// ── Plan+Execute: one-shot strategy — all files in context → JSON plan → apply ─
// Replaces the iterative tool loop on first attempt. Falls back to tool loop if
// plan parsing fails or all edits fail (old_string not found).
const PLAN_SYSTEM = `You are a code editor. You receive a task and ALL current project files.
Return ONLY a valid JSON object — no markdown fences, no text outside JSON.

{
  "summary": "one-line description of what you changed",
  "edits": [
    { "file": "relative/path", "old": "exact verbatim snippet to replace", "new": "replacement" }
  ],
  "creates": [
    { "file": "relative/path", "content": "full new file content" }
  ]
}

Rules:
- "old" must be an exact verbatim substring of the current file (no paraphrasing, exact whitespace)
- Use the shortest unique "old" snippet — just enough chars to be unambiguous in that file
- Only change what the task requires — nothing else
- Never edit: builder-server.js, Dockerfile, docker-compose.yml, .build-prompt.txt
- App keeps GET /health returning {status:"ok"} and uses process.env.PORT`

async function tryPlanExecute(description, errorContext) {
  // Load all workspace files into one context string (capped at ~20k tokens)
  const files = getWorkspaceFiles()
  let ctxStr = '', chars = 0
  const BUDGET = 80000

  broadcast({ type: 'tool_start', tool: 'list_files', label: files.length + ' files' })
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(WORKSPACE, f), 'utf8')
      const block   = '=== ' + f + ' ===\n' + content + '\n'
      if (chars + block.length > BUDGET) continue
      ctxStr += block; chars += block.length
    } catch {}
  }
  broadcast({ type: 'tool_done', icon: '📂', text: 'list_files → ' + files.length + ' files loaded', ok: true })

  const userMsg = (errorContext
    ? 'Fix these errors:\n' + errorContext.slice(0, 1500) + '\n\nTask: '
    : 'Task: ')
    + description + '\n\n=== PROJECT FILES ===\n' + ctxStr

  currentPhase = 'thinking'
  broadcast({ type: 'thinking' })

  // Heartbeat: keep broadcasting 'thinking' every 4s so browsers that connect mid-call
  // immediately see the spinner rather than a blank console
  const planHb = setInterval(function() { broadcast({ type: 'thinking' }) }, 4000)

  let plan
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + OR_KEY, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'https://vps-bot-multi.local', 'X-Title': 'VPS-Bot-Multi' },
      body: JSON.stringify({
        model:           MODEL,
        messages:        [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: userMsg }],
        max_tokens:      6000,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) { clearInterval(planHb); console.log('[plan] API error', res.status); return false }
    const data = await res.json()
    const raw  = data.choices?.[0]?.message?.content || ''
    // Handle both raw JSON and markdown-fenced JSON from the model
    const jsonStr = raw.match(/```(?:json)?\s*([\s\S]+?)```/)?.[1] ?? raw
    plan = JSON.parse(jsonStr.trim())
  } catch (err) {
    clearInterval(planHb)
    console.log('[plan] parse failed:', err.message); return false
  }
  clearInterval(planHb)

  const edits   = plan.edits   || []
  const creates = plan.creates || []
  if (edits.length === 0 && creates.length === 0) { console.log('[plan] no changes'); return false }

  currentPhase = 'editing'
  let allOk = true

  for (const edit of edits) {
    if (!edit.file || PROTECTED.has(path.basename(edit.file))) continue
    broadcast({ type: 'tool_start', tool: 'edit_file', label: edit.file })
    try {
      const fp = path.join(WORKSPACE, edit.file)
      const content = fs.readFileSync(fp, 'utf8')
      if (!content.includes(edit.old)) {
        broadcast({ type: 'tool_done', icon: '❌', text: 'edit  ' + edit.file + ': not found', ok: false })
        allOk = false
      } else {
        fs.writeFileSync(fp, content.replace(edit.old, edit.new))
        filesWritten++
        broadcast({ type: 'file', name: edit.file })
        broadcast({ type: 'tool_done', icon: '✏️', text: 'edit  ' + edit.file, ok: true })
      }
    } catch (err) {
      broadcast({ type: 'tool_done', icon: '❌', text: 'edit  ' + edit.file + ': ' + err.message, ok: false })
      allOk = false
    }
  }

  for (const create of creates) {
    if (!create.file || PROTECTED.has(path.basename(create.file))) continue
    broadcast({ type: 'tool_start', tool: 'write_file', label: create.file })
    try {
      const fp = path.join(WORKSPACE, create.file)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.writeFileSync(fp, create.content)
      filesWritten++
      broadcast({ type: 'file', name: create.file })
      broadcast({ type: 'tool_done', icon: '📝', text: 'write ' + create.file, ok: true })
    } catch (err) {
      broadcast({ type: 'tool_done', icon: '❌', text: 'write ' + create.file + ': ' + err.message, ok: false })
      allOk = false
    }
  }

  if (plan.summary) broadcast({ type: 'log', content: '✅ ' + plan.summary + '\n' })
  return allOk
}

// Compare only dep sections so a name/version bump doesn't trigger a full reinstall
function depsKey(pkgJson) {
  try {
    const p = JSON.parse(pkgJson)
    return JSON.stringify({ d: p.dependencies || {}, dd: p.devDependencies || {} })
  } catch { return pkgJson }
}

async function runAgenticPatch(description, errorContext, attempt) {
  if (attempt === undefined) attempt = 0
  const isRetry = attempt > 0

  // Reset to 'building' so pollUntilReady doesn't mistake the pre-launched boilerplate
  // (state='running') for the finished customised app.
  // Also clear the replay buffer so late-joining browsers don't see the old state:'running'
  // event and reload-loop before the agent finishes.
  state = 'building'
  currentPhase = 'thinking'
  if (!isRetry) sseBuffer.length = 0

  const statusMsg = isRetry
    ? 'Agent fixing errors (attempt ' + (attempt + 1) + ')...'
    : 'Agent is analyzing the codebase...'
  broadcast({ type: 'status', message: statusMsg })
  if (isRetry) broadcast({ type: 'log', content: '\n⚠️  Error detected — agent will fix it...\n' })
  console.log('[agent] patch attempt', attempt, description.slice(0, 80))

  let pkgJsonBefore = ''
  try { pkgJsonBefore = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8') } catch {}

  // If retrying, prepend error context so the agent knows exactly what to fix
  const userContent = errorContext
    ? 'Fix these errors in the app, then make sure it runs:\n\n' + errorContext.slice(0, 2500) + '\n\n---\nOriginal task: ' + description
    : 'Apply this change to the web app: ' + description

  const messages = [
    { role: 'system',  content: AGENT_SYSTEM },
    { role: 'user',    content: userContent },
  ]

  // Fast path: one API call with all files in context → JSON plan → apply instantly
  // Falls back to the iterative tool loop if plan fails or edits don't apply cleanly
  let skipToolLoop = false
  if (!isRetry) {
    skipToolLoop = await tryPlanExecute(description, errorContext)
    if (!skipToolLoop) broadcast({ type: 'log', content: '⚠️  Plan pass failed — switching to tool loop\n' })
  }

  for (let iter = 0; !skipToolLoop && iter < AGENT_MAX_ITERS; iter++) {
    currentPhase = 'thinking'
    broadcast({ type: 'thinking' })
    let response
    const iterHb = setInterval(function() { broadcast({ type: 'thinking' }) }, 4000)
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + OR_KEY,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://vps-bot-multi.local',
          'X-Title':       'VPS-Bot-Multi',
        },
        body: JSON.stringify({
          model:       MODEL,
          messages,
          tools:       AGENT_TOOLS,
          tool_choice: 'auto',
          max_tokens:  2000,
        }),
      })
      if (!res.ok) {
        clearInterval(iterHb)
        const txt = await res.text()
        return fail('OpenRouter ' + res.status + ': ' + txt.slice(0, 200))
      }
      const data = await res.json()
      response = data.choices[0]?.message
      if (!response) { clearInterval(iterHb); return fail('Empty response from model') }
    } catch (err) {
      clearInterval(iterHb)
      return fail('Agent error: ' + err.message)
    }
    clearInterval(iterHb)

    messages.push(response)

    // No tool calls → agent finished
    if (!response.tool_calls || response.tool_calls.length === 0) {
      if (response.content) broadcast({ type: 'log', content: '✅ ' + response.content + '\n' })
      break
    }

    // Execute tool calls
    currentPhase = 'editing'
    for (const call of response.tool_calls) {
      let args = {}
      try { args = JSON.parse(call.function.arguments) } catch {}
      let result = ''

      if (call.function.name === 'list_files') {
        broadcast({ type: 'tool_start', tool: 'list_files', label: '' })
        const files = getWorkspaceFiles()
        result = files.join('\n')
        broadcast({ type: 'tool_done', icon: '📂', text: 'list_files → ' + files.length + ' files', ok: true })

      } else if (call.function.name === 'read_file') {
        broadcast({ type: 'tool_start', tool: 'read_file', label: args.path })
        try {
          const raw = fs.readFileSync(path.join(WORKSPACE, args.path), 'utf8')
          result = raw.slice(0, 8000)
          broadcast({ type: 'tool_done', icon: '📖', text: 'read  ' + args.path, ok: true })
        } catch (err) {
          result = 'Error: ' + err.message
          broadcast({ type: 'tool_done', icon: '❌', text: 'read  ' + args.path + ': ' + err.message, ok: false })
        }

      } else if (call.function.name === 'edit_file') {
        broadcast({ type: 'tool_start', tool: 'edit_file', label: args.path })
        const fname = path.basename(args.path || '')
        if (PROTECTED.has(fname)) {
          result = 'Error: file is protected, cannot edit'
          broadcast({ type: 'tool_done', icon: '🚫', text: 'edit  ' + args.path + ' (protected)', ok: false })
        } else {
          try {
            const filePath = path.join(WORKSPACE, args.path)
            const content  = fs.readFileSync(filePath, 'utf8')
            if (!content.includes(args.old_string)) {
              result = 'Error: old_string not found verbatim. Call read_file again to get the exact current content.'
              broadcast({ type: 'tool_done', icon: '❌', text: 'edit  ' + args.path + ': string not found', ok: false })
            } else {
              fs.writeFileSync(filePath, content.replace(args.old_string, args.new_string))
              filesWritten++
              broadcast({ type: 'file', name: args.path })
              broadcast({ type: 'tool_done', icon: '✏️', text: 'edit  ' + args.path, ok: true })
              result = 'OK'
            }
          } catch (err) {
            result = 'Error: ' + err.message
            broadcast({ type: 'tool_done', icon: '❌', text: 'edit  ' + args.path + ': ' + err.message, ok: false })
          }
        }

      } else if (call.function.name === 'write_file') {
        broadcast({ type: 'tool_start', tool: 'write_file', label: args.path })
        const fname = path.basename(args.path || '')
        if (PROTECTED.has(fname)) {
          result = 'Error: file is protected'
          broadcast({ type: 'tool_done', icon: '🚫', text: 'write ' + args.path + ' (protected)', ok: false })
        } else {
          try {
            const filePath = path.join(WORKSPACE, args.path)
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, args.content)
            filesWritten++
            broadcast({ type: 'file', name: args.path })
            broadcast({ type: 'tool_done', icon: '📝', text: 'write ' + args.path, ok: true })
            result = 'OK'
          } catch (err) {
            result = 'Error: ' + err.message
            broadcast({ type: 'tool_done', icon: '❌', text: 'write ' + args.path + ': ' + err.message, ok: false })
          }
        }
      } else {
        result = 'Unknown tool'
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }

  // ── npm install if package.json changed ────────────────────────────────────
  state = 'installing'
  currentPhase = 'installing'
  let pkgJsonAfter = ''
  try { pkgJsonAfter = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8') } catch {}
  if (depsKey(pkgJsonBefore) !== depsKey(pkgJsonAfter) || !fs.existsSync(path.join(WORKSPACE, 'node_modules'))) {
    broadcast({ type: 'phase', phase: 'install', message: 'Installing new dependencies...' })
    try { await spawnStreaming('npm', ['install'], true) }
    catch (err) {
      const out = (err.output || err.message).slice(0, 2000)
      if (attempt < MAX_FIX_ATTEMPTS) return runAgenticPatch(description, 'NPM INSTALL FAILED:\n' + out, attempt + 1)
      return fail('npm install failed after ' + (attempt + 1) + ' attempts')
    }
  }

  // ── npm run build if needed — capture output for error feedback ─────────────
  // Always launch via `npm start` — npm resolves node_modules/.bin automatically
  let startBin = 'node', startArgs = ['src/index.js']
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'))
    if (pkg.scripts?.start) { startBin = 'npm'; startArgs = ['start'] }
    if (pkg.scripts?.build) {
      currentPhase = 'building'
      broadcast({ type: 'phase', phase: 'build', message: isRetry ? 'Rebuilding after fix...' : 'Building...' })
      try {
        await spawnStreaming('npm', ['run', 'build'], true)
      } catch (err) {
        const out = (err.output || err.message).slice(0, 2500)
        if (attempt < MAX_FIX_ATTEMPTS) {
          broadcast({ type: 'log', content: '❌ Build failed — asking agent to fix...\n' })
          return runAgenticPatch(description, 'BUILD ERROR (fix this before anything else):\n' + out, attempt + 1)
        }
        return fail('Build failed after ' + (attempt + 1) + ' fix attempts:\n' + out.slice(-600))
      }
    }
  } catch {}

  // ── Launch app — retry with crash log if it dies quickly ──────────────────
  // Kill any pre-launched boilerplate (or previous patched version) before spawning.
  // Wait briefly so the OS frees port 3001 before the new process binds it.
  if (currentApp) {
    killCurrentApp()  // kills npm + sh + next dev (entire process group)
    await new Promise(function(r) { setTimeout(r, 800) })
  }
  currentPhase = 'launching'
  broadcast({ type: 'launching', message: isRetry ? 'Relaunching after fix...' : 'Launching app...' })
  const crashError = await spawnApp(startBin, startArgs)
  if (crashError) {
    if (attempt < MAX_FIX_ATTEMPTS) {
      broadcast({ type: 'log', content: '❌ App crashed — asking agent to fix...\n' })
      return runAgenticPatch(description, 'RUNTIME CRASH (the app started then immediately died):\n' + crashError.slice(0, 2000), attempt + 1)
    }
    fail('App failed to start after ' + (attempt + 1) + ' fix attempts:\n' + crashError.slice(-600))
  }
}

// ── In-container rebuild triggered via HTTP ──────────────────────────────────
async function startRebuild(description) {
  console.log('[builder] HTTP rebuild triggered:', description)

  // Kill app process only — container keeps running
  killCurrentApp()

  state = 'building'
  buildError = null
  filesWritten = 0
  currentPhase = 'thinking'
  sseBuffer.length = 0   // clear replay buffer — rebuild starts fresh
  broadcast({ type: 'phase', phase: 'rebuilding', message: 'Agent is reading the codebase...' })

  runAgenticPatch(description)
}

// Script injected into every HTML page served by the proxy.
// ── Overlay rebuild watcher injected into every proxied HTML page ────────────
// Polls /health every 2s. When a rebuild starts, slides up a live-progress panel
// (no redirect — user stays on the page). When done, hides panel + reloads in-place.
const REBUILD_WATCHER = `<script>
(function(){
var panel=null,log=null,es=null,prev='running',lastLogType='',sawBuilding=false
var LABELS={thinking:'Agent thinking…',editing:'Applying changes…',installing:'Installing packages…',building:'Building…',launching:'Launching…',running:'Done',error:'Error'}
function createPanel(){
  if(panel)return
  var s=document.createElement('style')
  s.textContent='#vpsbot-panel{position:fixed;bottom:0;left:0;right:0;height:220px;background:#0f0f11;border-top:1px solid #27272a;z-index:2147483647;display:flex;flex-direction:column;transform:translateY(100%);transition:transform .3s ease;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",monospace}#vpsbot-panel.show{transform:translateY(0)}#vpsbot-header{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #27272a;flex-shrink:0}#vpsbot-spinner{width:14px;height:14px;border:2px solid #27272a;border-top-color:#6366f1;border-radius:50%;animation:vpssp .6s linear infinite;flex-shrink:0}@keyframes vpssp{to{transform:rotate(360deg)}}#vpsbot-phase{font-size:12px;color:#a1a1aa}#vpsbot-log{flex:1;overflow-y:auto;padding:6px 12px;font-size:11px;line-height:1.5;color:#71717a}'
  document.head.appendChild(s)
  panel=document.createElement('div');panel.id='vpsbot-panel'
  var hdr=document.createElement('div');hdr.id='vpsbot-header'
  var sp=document.createElement('div');sp.id='vpsbot-spinner'
  var ph=document.createElement('div');ph.id='vpsbot-phase';ph.textContent='⚡ Updating…'
  hdr.appendChild(sp);hdr.appendChild(ph);panel.appendChild(hdr)
  log=document.createElement('div');log.id='vpsbot-log';panel.appendChild(log)
  document.body.appendChild(panel)
  requestAnimationFrame(function(){requestAnimationFrame(function(){panel.classList.add('show')})})
}
function appendLog(txt){
  if(!log)return
  var line=document.createElement('div');line.textContent=txt;log.appendChild(line)
  log.scrollTop=log.scrollHeight
}
function setPhase(ph){var el=document.getElementById('vpsbot-phase');if(el)el.textContent='⚡ '+(LABELS[ph]||ph)}
function hidePanel(){
  if(!panel)return
  panel.classList.remove('show')
  setTimeout(function(){if(panel){panel.remove();panel=null;log=null}},300)
  if(es){es.close();es=null}
}
function startSSE(){
  if(es)return
  try{
    es=new EventSource('/events')
    es.onmessage=function(e){
      try{
        var d=JSON.parse(e.data)
        // Only reload on running if we saw a build start in this session —
        // prevents reload loop when SSE reconnects and replays old state:running from buffer
        if(d.state==='building'||d.state==='installing')sawBuilding=true
        if(d.state==='running'){if(sawBuilding){hidePanel();window.location.reload()}return}
        if(d.type==='phase')setPhase(d.phase)
        if(d.type==='thinking'&&lastLogType!=='thinking'){appendLog('💭 Thinking…')}
        if(d.type==='tool_start'&&d.tool)appendLog('🔧 '+d.tool+(d.label?' — '+d.label:''))
        if(d.type==='tool_done'&&d.text)appendLog((d.icon||'✓')+' '+d.text)
        if(d.type==='status'&&d.message)appendLog(d.message)
        if(d.type==='log'&&d.content)appendLog(d.content.trim())
        lastLogType=d.type
        if(d.state==='error'){setPhase('error')}
      }catch(ex){}
    }
    es.onerror=function(){sawBuilding=false;es.close();es=null;setTimeout(startSSE,3000)}
  }catch(ex){}
}
function poll(){
  fetch('/health').then(function(r){return r.json()}).then(function(d){
    if(prev==='running'&&(d.state==='building'||d.state==='installing')){
      sawBuilding=true;createPanel();startSSE()
    }
    if((prev==='building'||prev==='installing')&&d.state==='running'){
      hidePanel();window.location.reload();return
    }
    prev=d.state
    setTimeout(poll,2000)
  }).catch(function(){setTimeout(poll,3000)})
}
setTimeout(poll,2000)
})()
</script>`

// ── Proxy to app running on APP_PORT ─────────────────────────────────────────
function proxyToApp(req, res) {
  // Strip accept-encoding so we receive plain text we can modify for HTML injection
  const fwdHeaders = Object.assign({}, req.headers, { host: 'localhost:' + APP_PORT })
  delete fwdHeaders['accept-encoding']

  const options = {
    hostname: '127.0.0.1',
    port:     APP_PORT,
    path:     req.url || '/',
    method:   req.method,
    headers:  fwdHeaders,
  }
  const proxy = http.request(options, function(proxyRes) {
    const ct = proxyRes.headers['content-type'] || ''
    if (ct.includes('text/html')) {
      // Buffer HTML so we can inject the rebuild-watcher script
      const chunks = []
      proxyRes.on('data', function(c) { chunks.push(c) })
      proxyRes.on('end', function() {
        let body = Buffer.concat(chunks).toString('utf8')
        body = body.includes('</body>')
          ? body.replace('</body>', REBUILD_WATCHER + '</body>')
          : body + REBUILD_WATCHER
        const outHeaders = Object.assign({}, proxyRes.headers)
        delete outHeaders['content-length']   // length changed after injection
        outHeaders['cache-control'] = 'no-store'
        res.writeHead(proxyRes.statusCode, outHeaders)
        res.end(body)
      })
    } else {
      // CSS/JS/images: also no-store so rebuilds are always reflected immediately
      const outHeaders = Object.assign({}, proxyRes.headers)
      outHeaders['cache-control'] = 'no-store'
      res.writeHead(proxyRes.statusCode, outHeaders)
      proxyRes.pipe(res)
    }
  })
  proxy.on('error', function() {
    // App process started but not yet listening — serve loading page so the
    // browser's SSE connection keeps polling and reloads when truly ready.
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(HTML)
    }
  })
  req.pipe(proxy)
}

// ── Loading page (shown while building, auto-redirects when app is ready) ────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${PROJECT}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#0f0f11;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column;overflow:hidden}
.hero{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:0}
.ring{width:44px;height:44px;border:3px solid #27272a;border-top-color:#6366f1;border-radius:50%;animation:sp .75s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.name{font-size:18px;font-weight:600;color:#fafafa}
.phase{font-size:13px;color:#71717a;letter-spacing:.2px;transition:color .3s}
.phase.error{color:#f87171}
.logbox{height:200px;flex-shrink:0;border-top:1px solid #27272a;background:#09090b;display:flex;flex-direction:column}
.loghdr{font-size:10px;color:#52525b;padding:4px 12px;border-bottom:1px solid #1a1a1f;letter-spacing:.5px;text-transform:uppercase;flex-shrink:0}
.loglines{flex:1;overflow-y:auto;padding:6px 12px;font-size:11px;line-height:1.6;color:#71717a;font-family:ui-monospace,SFMono-Regular,monospace}
.loglines div{white-space:pre-wrap;word-break:break-all}
</style>
</head>
<body>
<div class="hero">
  <div class="ring" id="ring"></div>
  <div class="name">${PROJECT}</div>
  <div class="phase" id="ph">Starting…</div>
</div>
<div class="logbox">
  <div class="loghdr">Build log</div>
  <div class="loglines" id="log"></div>
</div>
<script>
var LABELS={thinking:'Thinking…',editing:'Applying changes…',installing:'Installing packages…',building:'Building…',launching:'Launching…',running:'Ready!',error:'Build failed'}
var logEl=document.getElementById('log')
var phEl=document.getElementById('ph')
var es=null,lastLogType=''

function appendLog(txt){
  var d=document.createElement('div');d.textContent=txt;logEl.appendChild(d)
  logEl.scrollTop=logEl.scrollHeight
}
function setPhase(ph){phEl.textContent=LABELS[ph]||ph;phEl.className='phase'+(ph==='error'?' error':'')}

function startSSE(){
  try{
    es=new EventSource('/events')
    es.onmessage=function(e){
      try{
        var d=JSON.parse(e.data)
        if(d.state==='running'){window.location.reload();return}
        if(d.type==='connected')setPhase(d.state||'building')
        if(d.type==='phase')setPhase(d.phase)
        if(d.type==='thinking'&&lastLogType!=='thinking')appendLog('💭 Thinking…')
        if(d.type==='tool_start'&&d.tool)appendLog('🔧 '+d.tool+(d.label?' — '+d.label:''))
        if(d.type==='tool_done'&&d.text)appendLog((d.icon||'✓')+' '+d.text)
        if(d.type==='status'&&d.message)appendLog(d.message)
        if(d.type==='log'&&d.content)appendLog(d.content.trim())
        lastLogType=d.type
        if(d.state==='error')setPhase('error')
      }catch(ex){}
    }
    es.onerror=function(){es.close();es=null;setTimeout(fallbackPoll,3000)}
  }catch(ex){fallbackPoll()}
}

function fallbackPoll(){
  fetch('/health').then(function(r){return r.json()}).then(function(d){
    setPhase(d.phase||d.state||'building')
    if(d.state==='running'){window.location.reload();return}
    if(d.state==='error')return
    setTimeout(fallbackPoll,2000)
  }).catch(function(){setTimeout(fallbackPoll,3000)})
}

startSSE()
</script>
</body>
</html>`

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  const url = req.url ? req.url.split('?')[0] : '/'

  // ── /health ────────────────────────────────────────────────────────────────
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      status:  buildError ? 'error' : 'ok',
      loading: state !== 'running' && state !== 'error',
      state,
      phase:   currentPhase,
      error:   buildError,
    }))
  }

  // ── /events (SSE) ──────────────────────────────────────────────────────────
  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    res.write('retry: 3000\n\n')
    // Replay history so late-joining browsers see everything that happened
    for (const past of sseBuffer) try { res.write(past) } catch {}
    // Current state sync (may advance past what was replayed)
    res.write('data: ' + JSON.stringify({ type: 'connected', state }) + '\n\n')
    sseClients.push(res)
    req.on('close', function() {
      const i = sseClients.indexOf(res)
      if (i >= 0) sseClients.splice(i, 1)
    })
    return
  }

  // ── /rebuild POST (HTTP rebuild trigger) ───────────────────────────────────
  if (url === '/rebuild' && req.method === 'POST') {
    if (REBUILD_SECRET && req.headers['x-rebuild-secret'] !== REBUILD_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Forbidden' }))
    }
    if (state === 'building' || state === 'installing') {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Build already in progress' }))
    }
    let body = ''
    req.on('data', function(d) { body += d })
    req.on('end', function() {
      try {
        const { description } = JSON.parse(body)
        if (!description) throw new Error('description required')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: 'Rebuild started' }))
        setImmediate(function() { startRebuild(description) })
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // ── Proxy to app when running, console otherwise ───────────────────────────
  if (state === 'running') {
    return proxyToApp(req, res)
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
})

server.listen(PORT, function() {
  console.log('[builder] server on :' + PORT + '  project=' + PROJECT)
  setTimeout(runWithAutofix, 800)
})
