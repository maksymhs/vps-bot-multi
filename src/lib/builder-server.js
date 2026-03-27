// builder-server.js — runs INSIDE the Docker container (permanent proxy + AI builder)
// Architecture:
//   Port 3000 (public) — builder-server.js always alive: serves console, handles /rebuild, proxies to app
//   Port 3001 (internal) — real app spawned here after build
//
// Flow: serve console → DeepSeek → write files → npm install → npm build → spawn app on 3001
//       On /rebuild: kill app → DeepSeek patch → npm install → respawn on 3001
// Uses only Node.js built-ins + global fetch (Node 18+). No external deps.
import http from 'http'
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
function spawnApp(bin, args) {
  return new Promise(function(resolve) {
    let errorOutput = ''
    const startedAt = Date.now()

    currentApp = cp.spawn(bin, args, {
      cwd:      WORKSPACE,
      env:      Object.assign({}, process.env, { PORT: String(APP_PORT) }),
      stdio:    ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    state = 'running'

    currentApp.stdout.on('data', function(d) { process.stdout.write(d); errorOutput += d.toString() })
    currentApp.stderr.on('data', function(d) { process.stderr.write(d); errorOutput += d.toString() })

    currentApp.on('error', function(err) {
      currentApp = null
      state = 'building'
      resolve(err.message)
    })

    currentApp.on('exit', function(code, signal) {
      currentApp = null
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        // Intentionally killed for rebuild — don't exit the process
        resolve(undefined)
        return
      }
      const quickCrash = code !== 0 && (Date.now() - startedAt) < CRASH_WINDOW_MS
      if (quickCrash) {
        state = 'building'
        resolve(errorOutput.slice(-1500))
      } else {
        process.exit(code || 0)
      }
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
  let pkgJsonAfter = ''
  try { pkgJsonAfter = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8') } catch {}
  const nodeModulesExists = fs.existsSync(path.join(WORKSPACE, 'node_modules'))
  const depsChanged = pkgJsonBefore !== pkgJsonAfter || !nodeModulesExists
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
      broadcast({ type: 'phase', phase: 'build', message: 'Building...' })
      await spawnStreaming('npm', ['run', 'build'])
    }
  } catch {}

  // ── 5. Resolve start command ─────────────────────────────────────────────────
  let startBin  = 'node'
  let startArgs = ['src/index.js']
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'))
    const startScript = (pkg.scripts && pkg.scripts.start) || 'node src/index.js'
    const parts = startScript.trim().split(/\s+/)
    startBin  = parts[0]
    startArgs = parts.slice(1)
  } catch {}

  // ── 6. Launch app on APP_PORT (builder stays alive as proxy on PORT) ─────────
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

async function runAgenticPatch(description, errorContext, attempt) {
  if (attempt === undefined) attempt = 0
  const isRetry = attempt > 0

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
  let pkgJsonAfter = ''
  try { pkgJsonAfter = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8') } catch {}
  if (pkgJsonBefore !== pkgJsonAfter || !fs.existsSync(path.join(WORKSPACE, 'node_modules'))) {
    broadcast({ type: 'phase', phase: 'install', message: 'Installing new dependencies...' })
    try { await spawnStreaming('npm', ['install'], true) }
    catch (err) {
      const out = (err.output || err.message).slice(0, 2000)
      if (attempt < MAX_FIX_ATTEMPTS) return runAgenticPatch(description, 'NPM INSTALL FAILED:\n' + out, attempt + 1)
      return fail('npm install failed after ' + (attempt + 1) + ' attempts')
    }
  }

  // ── npm run build if needed — capture output for error feedback ─────────────
  let startBin = 'node', startArgs = ['src/index.js']
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8'))
    startBin  = pkg.scripts?.start ? pkg.scripts.start.trim().split(/\s+/)[0] : 'node'
    startArgs = pkg.scripts?.start ? pkg.scripts.start.trim().split(/\s+/).slice(1) : ['src/index.js']
    if (pkg.scripts?.build) {
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
  if (currentApp) { currentApp.kill('SIGTERM'); currentApp = null }

  state = 'building'
  buildError = null
  filesWritten = 0
  sseBuffer.length = 0   // clear replay buffer — rebuild starts fresh
  broadcast({ type: 'phase', phase: 'rebuilding', message: 'Agent is reading the codebase...' })

  runAgenticPatch(description)
}

// ── Proxy to app running on APP_PORT ─────────────────────────────────────────
function proxyToApp(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port:     APP_PORT,
    path:     req.url || '/',
    method:   req.method,
    headers:  Object.assign({}, req.headers, { host: 'localhost:' + APP_PORT }),
  }
  const proxy = http.request(options, function(proxyRes) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })
  proxy.on('error', function() {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('App not ready yet')
  })
  req.pipe(proxy)
}

// ── Web console HTML ─────────────────────────────────────────────────────────
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
.title{color:#8b949e;font-size:13px}
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
.live{color:#58a6ff}
.sp{display:inline-block;width:1.2ch;font-style:normal}
.tok{color:#3fb950}
.ter{color:#f85149}
</style>
</head>
<body>
<div class="topbar">
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

var SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
var spinIdx = 0
var spinTimer = null
var liveEl = null
var liveSpEl = null
var liveTxtEl = null

function setLive(label) {
  if (!liveEl) {
    liveEl    = document.createElement('div')
    liveSpEl  = document.createElement('span')
    liveTxtEl = document.createElement('span')
    liveSpEl.className = 'sp'
    liveEl.className   = 'live'
    liveEl.appendChild(liveSpEl)
    liveEl.appendChild(liveTxtEl)
    con.appendChild(liveEl)
  }
  liveSpEl.textContent  = SPIN[0]
  liveTxtEl.textContent = ' ' + label
  liveEl.className      = 'live'
  con.scrollTop = con.scrollHeight
  if (!spinTimer) {
    spinTimer = setInterval(function() {
      if (liveSpEl) liveSpEl.textContent = SPIN[spinIdx++ % SPIN.length]
    }, 80)
  }
}

function finalizeLive(text, ok) {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null; spinIdx = 0 }
  if (liveEl) {
    liveEl.className  = ok ? 'tok' : 'ter'
    liveEl.textContent = text
    liveEl = null; liveSpEl = null; liveTxtEl = null
  } else {
    appendLine(text, ok ? 'tok' : 'ter')
  }
  con.scrollTop = con.scrollHeight
}

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
    setTimeout(pollAndReload, 2000)
  })
}

var es = new EventSource('/events')
es.onmessage = function(e) {
  var d = JSON.parse(e.data)

  if (d.type === 'thinking') {
    setLive('Agent thinking...')

  } else if (d.type === 'tool_start') {
    var lbl = d.tool.replace(/_/g,' ') + (d.label ? '  ' + d.label : '')
    setLive(lbl + '...')

  } else if (d.type === 'tool_done') {
    finalizeLive(d.icon + ' ' + d.text, d.ok)

  } else if (d.type === 'status') {
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
    } else if (d.phase === 'rebuilding' || d.phase === 'fixing') {
      fb.className = 'footbar install'
      fbL.textContent = 'AI is patching...'
    }

  } else if (d.type === 'log') {
    var lines = d.content.split('\\n')
    for (var i = 0; i < lines.length; i++) {
      if (lines[i]) appendLine(lines[i], 'lg')
    }

  } else if (d.type === 'running') {
    appendLine('')
    appendLine('── ' + d.message, 'sf')
    phEl.textContent = 'running'
    fb.className = 'footbar launch'
    fbL.textContent = 'App is live!'
    es.close()
    setTimeout(pollAndReload, 1000)

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

  // ── /console (always shows build console) ──────────────────────────────────
  if (url === '/console') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(HTML)
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
