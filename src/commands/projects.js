import { execFile, execSync, spawn } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { getDocker } from '../lib/docker-client.js'
import { buildingSet } from '../lib/build-state.js'
import { config } from '../lib/config.js'
import { userStore } from '../lib/user-store.js'
import { log } from '../lib/logger.js'
import { syncTemplates, matchTemplate, resolveAndCopy } from '../lib/templates.js'
import { enqueueBuild, getQueuePosition } from '../lib/build-queue.js'

const MAX_RETRIES = 2

// ── Loading server ────────────────────────────────────────────────────────────
// Injected in Phase 1 so the user has a live URL from the first seconds.
// The AI overwrites Dockerfile in Phase 2; loading artifacts are cleaned up
// before Phase 3 rebuilds with the real app.

const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Building your app...</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#09090b;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.wrap{text-align:center;padding:2rem}
.ring{width:52px;height:52px;border-radius:50%;border:3px solid #27272a;border-top-color:#6366f1;animation:spin .8s linear infinite;margin:0 auto 1.75rem}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:1.4rem;font-weight:600;color:#fafafa;margin-bottom:.5rem}
p{color:#71717a;font-size:.875rem;line-height:1.6;max-width:280px;margin:0 auto}
.dots span{animation:blink 1.4s infinite both}
.dots span:nth-child(2){animation-delay:.2s}
.dots span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:0}40%{opacity:1}}
</style>
</head>
<body>
<div class="wrap">
  <div class="ring"></div>
  <h1>Building your app<span class="dots"><span>.</span><span>.</span><span>.</span></span></h1>
  <p>AI is generating your code.<br>This page will update automatically.</p>
</div>
<script>
setInterval(async()=>{
  try{const r=await fetch('/health');const d=await r.json();if(!d.loading)location.reload()}catch(e){}
},2000)
setTimeout(()=>location.reload(),30000)
</script>
</body>
</html>`

const LOADING_SERVER_JS = `const http = require('http')
const html = ${JSON.stringify(LOADING_HTML)}
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'})
    return res.end('{"status":"ok","loading":true}')
  }
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
  res.end(html)
}).listen(3000)
`

const LOADING_DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY loading-server.js .
EXPOSE 3000
CMD ["node", "loading-server.js"]
`

function getUserId(ctx) {
  return ctx.from?.id
}

export function projectUrl(userId, name) {
  const slug = userStore.getUserSlug(userId)
  return config.projectUrl(slug, name)
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'], ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout)
    })
    // Close stdin immediately to prevent hanging
    if (child.stdin) child.stdin.end()
  })
}

// Version with output streaming
function runWithStreaming(cmd, args, opts = {}) {
  const { onData, timeout = 300_000, cwd, env } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let pendingCallbacks = 0
    let childClosed = false

    const tryResolve = () => {
      if (childClosed && pendingCallbacks === 0) {
        resolve(output)
      }
    }

    child.stdout?.on('data', (data) => {
      output += data.toString()
      if (onData) {
        pendingCallbacks++
        Promise.resolve(onData(data.toString())).finally(() => {
          pendingCallbacks--
          tryResolve()
        })
      }
    })

    child.stderr?.on('data', (data) => {
      output += data.toString()
      if (onData) {
        pendingCallbacks++
        Promise.resolve(onData(`❌ ${data.toString()}`)).finally(() => {
          pendingCallbacks--
          tryResolve()
        })
      }
    })

    const timeoutHandle = setTimeout(() => {
      child.kill()
      reject(new Error(`Command exceeded timeout (${timeout / 1000}s)`))
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timeoutHandle)
      childClosed = true
      if (code !== 0) {
        reject(new Error(output))
      } else {
        tryResolve()
      }
    })

    child.on('error', reject)
    if (child.stdin) child.stdin.end()
  })
}

function getNextPort(userId) {
  const BASE_PORT = 4000
  // Check all users' ports globally to avoid collisions
  const allProjects = userStore.getAllProjectsGlobal()
  const usedPorts = new Set(Object.values(allProjects).map(p => p.port).filter(Boolean))
  let port = BASE_PORT
  while (usedPorts.has(port)) port++
  return port
}


export function writeComposeFile(dir, userId, name) {
  const containerName = userStore.containerName(userId, name)
  const subdomain = name   // URL uses just the project name
  let compose
  if (config.domain) {
    compose = `services:
  app:
    container_name: ${containerName}
    build: .
    restart: unless-stopped
    networks:
      - caddy
    labels:
      caddy: ${subdomain}.${config.domain}
      caddy.reverse_proxy: "{{upstreams 3000}}"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

networks:
  caddy:
    external: true
`
  } else {
    const existing = userStore.getProject(userId, name)
    const port = existing?.port || getNextPort(userId)
    const url = `http://${config.ipAddress || 'localhost'}:${port}`
    userStore.setProject(userId, name, { port, url })
    compose = `services:
  app:
    container_name: ${containerName}
    build: .
    restart: unless-stopped
    ports:
      - "${port}:3000"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
`
  }
  writeFileSync(join(dir, 'docker-compose.yml'), compose)
}

function buildClaudePrompt(name, description, errorContext = null, templateInfo = null) {
  // If we have a matched template, use template-aware prompt
  if (templateInfo) {
    return buildTemplatePrompt(name, description, templateInfo, errorContext)
  }

  const base =
    `Create a complete, functional Node.js web application.\n\n` +
    `Name: ${name}\n` +
    `Description: ${description}\n\n` +
    `REQUIRED STRUCTURE:\n` +
    `- src/index.js        → Entry point: Express server on process.env.PORT || 3000\n` +
    `- src/routes/          → Separate routes if the app has multiple endpoints\n` +
    `- src/public/          → Static files (CSS, client JS, images) if applicable\n` +
    `- package.json         → name "${name}", "type": "module", scripts.start "node src/index.js"\n` +
    `- Dockerfile           → First line must be "# syntax=docker/dockerfile:1". For plain Node apps: FROM node:20-alpine, WORKDIR /app, COPY package*.json ., RUN --mount=type=cache,target=/root/.npm npm install --omit=dev, COPY . ., EXPOSE 3000, CMD ["node","src/index.js"]. For Vite/React apps use multi-stage: builder stage with RUN --mount=type=cache,target=/root/.npm npm install and RUN --mount=type=cache,target=/app/node_modules/.vite npm run build, then a final node:20-alpine stage to serve the dist.\n` +
    `- .dockerignore        → node_modules, .git, .env, *.md\n` +
    `- .gitignore           → node_modules/, .env, dist/\n\n` +
    `RULES:\n` +
    `1. GET /health must return { status: "ok" } — mandatory health check endpoint\n` +
    `2. Use express.static('src/public') to serve static files\n` +
    `3. CSS goes in src/public/style.css (NOT inline). Design must be modern, responsive, and visually appealing\n` +
    `4. If the app has a UI, use semantic HTML with a professional layout\n` +
    `5. Handle errors with Express middleware (404 + error handler)\n` +
    `6. Use ONLY ASCII characters in JS code. Never use − (U+2212), smart quotes, or other Unicode\n` +
    `7. Do NOT use import maps, do NOT use require(). Use ESM (import/export)\n` +
    `8. Do NOT add the project name as a visible title. The app decides its own content\n` +
    `9. Output order: Dockerfile first, package.json second, then all other files.\n\n` +
    `Write ALL files to disk. Code only, no explanations.`

  if (!errorContext) return base

  return base + `\n\n⚠️ FIX: The previous attempt failed with this error. Analyze and fix the code:\n${errorContext}`
}

function buildTemplatePrompt(name, description, templateInfo, errorContext = null) {
  const { templateName, stackName, instructions, boilerplateFiles, components } = templateInfo
  const fileList = boilerplateFiles.map(f => `  - ${f}`).join('\n')

  const source = stackName ? `stack "${stackName}" (base: ${templateName})` : `template "${templateName}"`
  let prompt =
    `Build a web application based on the ${source}.\n\n` +
    `Name: ${name}\n` +
    `Description: ${description}\n\n` +
    `FILES ALREADY IN PROJECT DIRECTORY:\n${fileList}\n\n`

  if (components.length) {
    prompt += `INCLUDED COMPONENTS: ${components.join(', ')}\n\n`
  }

  if (instructions) {
    prompt += `INSTRUCTIONS:\n${instructions}\n\n`
  }

  prompt +=
    `YOUR TASK:\n` +
    `1. The files listed above are already copied into the project directory\n` +
    `2. Customize and extend them to match the user's description\n` +
    `3. Modify existing files as needed — you can overwrite any boilerplate file\n` +
    `4. Add new files if the description requires functionality beyond the template\n` +
    `5. Integrate all components listed above into the application\n` +
    `6. Update package.json name to "${name}"\n` +
    `7. Ensure GET /health returns { status: "ok" } — MANDATORY\n` +
    `8. Use ONLY ASCII characters in code\n` +
    `9. Do NOT add the project name as a visible title\n\n` +
    `Output order: Dockerfile first, package.json second, then all other files.\n` +
    `Write ALL modified/new files to disk. Code only, no explanations.`

  if (errorContext) {
    prompt += `\n\n⚠️ FIX: The previous attempt failed with this error. Analyze and fix the code:\n${errorContext}`
  }

  return prompt
}

function buildRebuildPrompt(name, description, mode, existingFiles, errorContext = null) {
  if (mode === 'full') {
    return buildClaudePrompt(name, description, errorContext)
  }

  // Patch mode: give Claude context about existing files
  const fileList = existingFiles.map(f => `  - ${f}`).join('\n')

  const prompt =
    `Modify the existing project "${name}".\n\n` +
    `Original project description: ${description.split('\nRequested changes:')[0].split('\n\nRequested changes:')[0]}\n\n` +
    `REQUESTED CHANGES:\n${description.split('Requested changes:').pop()?.trim() || description}\n\n` +
    `EXISTING FILES:\n${fileList}\n\n` +
    `RULES:\n` +
    `1. Modify ONLY the files necessary to implement the changes\n` +
    `2. Do NOT delete existing functionality unless explicitly requested\n` +
    `3. Keep GET /health → { status: "ok" }\n` +
    `4. Keep the existing file structure\n` +
    `5. If you need new dependencies, update package.json\n` +
    `6. Use ONLY ASCII characters in JS code\n` +
    `7. Write modified files to disk. Code only, no explanations.`

  if (!errorContext) return prompt
  return prompt + `\n\n⚠️ FIX: The previous attempt failed:\n${errorContext}`
}

function fixUnicodeChars(dir) {
  try {
    execSync(
      `find "${dir}/src" -name "*.js" -exec sed -i ` +
      `'s/\xe2\x88\x92/-/g; s/\xe2\x80\x9c/"/g; s/\xe2\x80\x9d/"/g; s/\xe2\x80\x99/'"'"'/g' {} + < /dev/null`,
      { shell: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
  } catch { /* ignore */ }
}

function getExistingFiles(dir) {
  try {
    const entries = execSync(`find ${JSON.stringify(dir)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null || true`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim().split('\n').filter(Boolean)
    return entries.map(e => e.replace(dir + '/', '')).filter(f => f && !f.startsWith('.git/'))
  } catch {
    return []
  }
}

export async function generateProjectName(description, userId) {
  if (!config.openrouterKey) {
    // Fallback: derive from first words of description
    const words = description.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/).slice(0, 3)
    const base = words.join('-') || 'my-app'
    let candidate = base
    let i = 2
    while (userStore.isNameTakenGlobally(candidate)) { candidate = `${base}-${i}`; i++ }
    return candidate
  }

  let name = ''
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vps-bot-multi.local',
        'X-Title': 'VPS-Bot-Multi',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat-v3-0324',
        messages: [{
          role: 'user',
          content: `Generate a short project slug (2-3 words, kebab-case, lowercase, only a-z 0-9 hyphens, max 20 chars) for this app: "${description.slice(0, 200)}". Reply with ONLY the slug. Examples: task-tracker, weather-bot, link-saver`,
        }],
        max_tokens: 15,
      }),
    })
    const data = await res.json()
    name = (data.choices?.[0]?.message?.content || '').trim()
  } catch { /* ignore, fallback below */ }

  // Sanitize
  name = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 20)
  if (!name) {
    const words = description.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/).slice(0, 3)
    name = words.join('-') || 'my-app'
  }

  // Check availability globally (URL is name-only, so must be unique across all users)
  let candidate = name
  let i = 2
  while (userStore.isNameTakenGlobally(candidate)) { candidate = `${name}-${i}`; i++ }
  return candidate
}

async function generateCode(dir, name, description, onProgress = null, errorContext = null, _model = null, mode = 'new', templateInfo = null) {
  const existingFiles = (mode === 'patch') ? getExistingFiles(dir) : []
  const prompt = (mode === 'patch')
    ? buildRebuildPrompt(name, description, 'patch', existingFiles, errorContext)
    : buildClaudePrompt(name, description, errorContext, templateInfo)

  const startTime = Date.now()
  log.build(name, `=== ${mode.toUpperCase()} BUILD START ===`)
  log.build(name, 'Prompt:', prompt)

  if (onProgress) await onProgress('🧠 Generating code...')

  const systemPrompt = `You are a code generator. Output ONLY file contents in this exact format for EACH file:

--- FILE: path/to/file.ext ---
file contents here
--- END FILE ---

CRITICAL OUTPUT ORDER: Always output Dockerfile first, then package.json second, then all remaining files. This order is mandatory.
Do NOT include explanations, comments outside code, or markdown fences. Output ALL files needed for a complete working application. Every file must use this exact format.`

  if (!config.openrouterKey) throw new Error('No AI provider available (set OPENROUTER_API_KEY in .env)')

  const model = 'deepseek/deepseek-chat-v3-0324'
  log.build(name, `Using OpenRouter: ${model} (streaming)`)

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vps-bot-multi.local',
      'X-Title': 'VPS-Bot-Multi',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      max_tokens: 16384,
      stream: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`)
  }

  // ── Streaming parser ─────────────────────────────────────────────────────
  // Write each file to disk the moment its --- END FILE --- marker arrives.
  // When package.json + Dockerfile are both ready, fire onFilesReady() so the
  // caller can start a background Docker build (npm install) in parallel with
  // the remaining code still being generated.

  let fullContent = ''       // accumulated for fallback parsing
  let filesWritten = 0
  let currentFile = null
  let contentLines = []

  const writeFile = (filename, fileContent) => {
    if (!filename || filename.includes('..')) return
    const filePath = join(dir, filename)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, fileContent)
    filesWritten++
    log.build(name, `  wrote (stream): ${filename} (${fileContent.length}B)`)
  }

  const commitFile = () => {
    if (!currentFile) return
    writeFile(currentFile, contentLines.join('\n'))
    currentFile = null
    contentLines = []
  }

  const processLine = (line) => {
    const startMatch = line.match(/^---\s*FILE:\s*(.+?)\s*---$/)
    if (startMatch) { commitFile(); currentFile = startMatch[1].trim(); contentLines = []; return }
    if (/^---\s*END FILE\s*---$/.test(line)) { commitFile(); return }
    if (currentFile !== null) contentLines.push(line)
  }

  // Read SSE stream, buffer incomplete lines on both levels
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let sseBuffer  = ''   // raw SSE chunks
  let textBuffer = ''   // decoded AI text

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    sseBuffer += decoder.decode(value, { stream: true })
    const sseLines = sseBuffer.split('\n')
    sseBuffer = sseLines.pop()   // keep the incomplete trailing line

    for (const sseLine of sseLines) {
      if (!sseLine.startsWith('data: ')) continue
      const data = sseLine.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content
        if (chunk) {
          fullContent += chunk
          textBuffer  += chunk
          const parts = textBuffer.split('\n')
          textBuffer  = parts.pop()          // keep incomplete text line
          for (const line of parts) processLine(line)
        }
      } catch { /* ignore malformed SSE JSON */ }
    }
  }

  // Flush any remaining text
  if (textBuffer) processLine(textBuffer)
  commitFile()

  log.build(name, `OpenRouter response length: ${fullContent.length}`)

  // ── Fallbacks (in case streaming parser missed files) ────────────────────
  if (filesWritten === 0) {
    log.build(name, 'Stream parser found no files — trying full-content regex')
    const filePattern = /---\s*FILE:\s*([^\s-][^\n]*?)\s*---\n([\s\S]*?)\n---\s*END FILE\s*---/g
    let m
    while ((m = filePattern.exec(fullContent)) !== null) writeFile(m[1].trim(), m[2])
  }

  if (filesWritten === 0) {
    const fallbackFiles = parseMultiFileContent(fullContent)
    for (const [fn, fc] of Object.entries(fallbackFiles)) writeFile(fn, fc)
  }

  if (filesWritten === 0) {
    const cleanContent = fullContent.replace(/```[\w]*\n?|```/g, '').trim()
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.js'), cleanContent)
    if (!existsSync(join(dir, 'package.json'))) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name, type: 'module', scripts: { start: 'node src/index.js' },
        dependencies: { express: '^4.18.0' },
      }, null, 2))
    }
    filesWritten = 1
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000)
  log.build(name, `Code generation completed in ${elapsed}s (${filesWritten} files)`)

  // Log file summary
  try {
    const allFiles = readdirSync(dir, { recursive: true })
    const fileList = []
    for (const file of allFiles) {
      if (typeof file === 'string' && !file.includes('node_modules') && !file.includes('.git')) {
        const fullPath = join(dir, file)
        try {
          const stat = statSync(fullPath)
          if (stat.isFile()) {
            const sizeStr = stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`
            fileList.push(`${file} (${sizeStr})`)
          }
        } catch {}
      }
    }
    log.build(name, 'Files:', fileList.join(', '))
  } catch {}

  fixUnicodeChars(dir)
}

function parseMultiFileContent(content) {
  const files = {}
  const filePattern = /(?:^|\n)(```(?:javascript|js|json|dockerfile|docker)?\s*(?:\/\/.*?\n)?(?:filename|file):\s*["']?([^"'\n]+)["']?\n)([\s\S]*?)(?=(?:\n```)|$)/gm
  const simplePattern = /```(?:javascript|js|node)?\n([\s\S]*?)```/g
  
  let match
  let currentFile = null
  let currentContent = []
  
  // Pattern 1: Try to match files with filename markers
  const lines = content.split('\n')
  let currentFilename = null
  let inCodeBlock = false
  let codeBuffer = []
  let codeLanguage = null
  
  for (const line of lines) {
    if (line.startsWith('```') && !inCodeBlock) {
      inCodeBlock = true
      codeBuffer = []
      const langMatch = line.match(/```(\w*)/)
      codeLanguage = langMatch ? langMatch[1] : null
      // Check for filename on same line or next
      const fnMatch = line.match(/file[":]+\s*([^\s"']+)/) || (lines[lines.indexOf(line) + 1]?.match(/^\s*"?([^"'\n]+)"?\s*$/))
      if (fnMatch) currentFilename = fnMatch[1]
    } else if (line.startsWith('```') && inCodeBlock) {
      inCodeBlock = false
      const content = codeBuffer.join('\n')
      if (currentFilename && content) {
        files[currentFilename] = content
      } else if (!currentFilename) {
        // Try to infer filename from language
        if (codeLanguage === 'json' || content.includes('"name"')) {
          files['package.json'] = content
        } else if (codeLanguage === 'dockerfile' || content.startsWith('FROM')) {
          files['Dockerfile'] = content
        } else {
          files['src/index.js'] = content
        }
      }
      currentFilename = null
      codeBuffer = []
    } else if (inCodeBlock) {
      codeBuffer.push(line)
    }
  }
  
  // Fallback: if no files parsed, try simple extraction
  if (Object.keys(files).length === 0) {
    const blocks = content.split(/```/).filter((_, i) => i % 2 === 1)
    if (blocks.length > 0) {
      blocks.forEach((block, idx) => {
        const clean = block.replace(/^\w*\n/, '').trim()
        if (clean.includes('"name"')) {
          files['package.json'] = clean
        } else if (clean.startsWith('FROM')) {
          files['Dockerfile'] = clean
        } else if (idx === 0 || !files['src/index.js']) {
          files['src/index.js'] = clean
        }
      })
    }
  }
  
  return files
}


async function dockerComposeUp(dir, onProgress = null) {
  const dockerEnv = { ...process.env, DOCKER_BUILDKIT: '1' }

  if (!onProgress) {
    // Modo simple (sin callbacks)
    await run('docker', ['compose', 'up', '--build', '-d'], { cwd: dir, env: dockerEnv })
    return
  }

  // Modo con salida simplificada
  return new Promise((resolve, reject) => {
    const allLines = []
    const child = spawn('docker', ['compose', 'up', '--build', '-d'], { cwd: dir, env: dockerEnv })
    const steps = new Set()

    const parseStep = (line) => {
      // Extract meaningful Docker build steps
      if (/\[\d+\/\d+\]/.test(line)) {
        const match = line.match(/\[\d+\/\d+\]\s+(.+)/)
        if (match) return `📦 ${match[1].split(' ').slice(0, 3).join(' ')}`
      }
      if (/Building/.test(line)) return '🔨 Building image...'
      if (/Built/.test(line)) return '✅ Image built'
      if (/Creating/.test(line) && /Container/.test(line)) return '📦 Creating container...'
      if (/Started/.test(line)) return '🚀 Container started'
      if (/npm install/.test(line) || /added \d+ packages/.test(line)) return '📦 npm install...'
      return null
    }

    child.stdout?.on('data', (data) => {
      allLines.push(data.toString())
    })

    child.stderr?.on('data', (data) => {
      const text = data.toString()
      allLines.push(text)
      for (const line of text.split('\n')) {
        const step = parseStep(line)
        if (step && !steps.has(step)) {
          steps.add(step)
          onProgress(step)
        }
      }
    })

    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`docker compose up failed\n${allLines.slice(-3).join('\n')}`))
      } else {
        resolve()
      }
    })

    child.on('error', reject)
    if (child.stdin) child.stdin.end()
  })
}

async function dockerComposeDown(dir) {
  try {
    await run('docker', ['compose', 'down', '--rmi', 'local'], { cwd: dir })
  } catch { /* ignore */ }
}

async function getContainerIpByFullName(containerFullName) {
  const containers = await getDocker().listContainers({
    filters: JSON.stringify({ name: [containerFullName] }),
  })
  if (!containers.length) return null
  const info = await getDocker().getContainer(containers[0].Id).inspect()
  // Try caddy network first, then any network with an IP
  const networks = info.NetworkSettings.Networks || {}
  if (networks.caddy?.IPAddress) return networks.caddy.IPAddress
  for (const net of Object.values(networks)) {
    if (net.IPAddress) return net.IPAddress
  }
  return null
}

async function getContainerLogsByFullName(containerFullName) {
  try {
    const containers = await getDocker().listContainers({
      all: true,
      filters: JSON.stringify({ name: [containerFullName] }),
    })
    if (!containers.length) return ''
    const container = getDocker().getContainer(containers[0].Id)
    const stream = await container.logs({ stdout: true, stderr: true, tail: 30 })
    return Buffer.isBuffer(stream) ? stream.toString() : String(stream)
  } catch {
    return ''
  }
}

async function pollHealth(ip, port, timeoutMs = 60_000, onProgress = null) {
  const deadline = Date.now() + timeoutMs
  let attempts = 0

  while (Date.now() < deadline) {
    attempts++
    try {
      if (onProgress) {
        const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000)
        await onProgress(`Attempt ${attempts} (${elapsed}s): connecting to http://${ip}:${port}/health...`)
      }

      const res = await fetch(`http://${ip}:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.status < 500) return true
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1500))
  }
  return false
}

async function buildAndVerify(dir, userId, name, description, onStatus, errorContext = null, _model = null, mode = 'new') {
  const slug = userStore.getUserSlug(userId)
  const logName = `${slug}-${name}`
  log.info(`[${logName}] build start`, `dir=${dir} mode=${mode}`)

  // ── Template resolution ────────────────────────────────────────────────────
  let templateInfo = null
  let templateStarted = false

  if (mode === 'new' || mode === 'full') {
    await onStatus('📦 Syncing templates...')
    const synced = syncTemplates()
    if (synced) {
      const match = matchTemplate(description)
      if (match) {
        const label = match.stack
          ? `stack: ${match.stack.displayName || match.stack.name}`
          : `template: ${match.template.displayName}`
        log.info(`[${logName}] matched ${label} (score=${match.score})`)
        await onStatus(`📋 Using ${label}`)

        templateInfo = resolveAndCopy(match, dir)
        if (templateInfo) {
          try { execSync(`chown -R vpsbot:vpsbot ${JSON.stringify(dir)}`) } catch {}
          userStore.setProject(userId, name, { template: templateInfo.templateName, components: templateInfo.components, stack: templateInfo.stackName })
          log.info(`[${logName}] files copied: ${templateInfo.boilerplateFiles.length} files, components=[${templateInfo.components.join(',')}]`)

          // ── Phase 1: start loading server immediately ───────────────────────
          // A minimal Node.js server starts in ~3s (no npm install, no vite build)
          // so the user gets a live URL right away while the real app is generated.
          // The AI overwrites Dockerfile in Phase 2; we restore or clean it before Phase 3.
          writeComposeFile(dir, userId, name)

          // Backup template's Dockerfile so we can restore if AI skips it
          if (existsSync(join(dir, 'Dockerfile'))) {
            writeFileSync(join(dir, 'Dockerfile.template'), readFileSync(join(dir, 'Dockerfile')))
          }
          writeFileSync(join(dir, 'loading-server.js'), LOADING_SERVER_JS)
          writeFileSync(join(dir, 'Dockerfile'), LOADING_DOCKERFILE)

          log.build(logName, 'Phase 1: starting loading server')
          try {
            await dockerComposeUp(dir, null)
            templateStarted = true
            const url = projectUrl(userId, name)
            log.build(logName, `Phase 1: loading server live → ${url}`)
            await onStatus(`🌐 Open now: ${url}\n🧠 Generating your app...`)
          } catch (err) {
            log.build(logName, `Phase 1: loading server failed (will build after gen): ${err.message}`)
            // Clean up loading artifacts so Phase 3 starts clean
            for (const f of ['loading-server.js', 'Dockerfile.template']) {
              try { rmSync(join(dir, f)) } catch {}
            }
            // Restore original Dockerfile
            if (existsSync(join(dir, 'Dockerfile.template'))) {
              writeFileSync(join(dir, 'Dockerfile'), readFileSync(join(dir, 'Dockerfile.template')))
              rmSync(join(dir, 'Dockerfile.template'))
            }
          }
        }
      } else {
        log.info(`[${logName}] no template matched, using generic build`)
      }
    } else {
      log.info(`[${logName}] templates sync failed, using generic build`)
    }
  }

  // Write compose file if Phase 1 didn't do it (patch/full modes or no template match)
  if (!templateStarted) {
    writeComposeFile(dir, userId, name)
  }

  // ── Phase 2: AI code generation ───────────────────────────────────────────
  // Runs while the template container is already serving (if Phase 1 succeeded).
  // For patch/rebuild modes this is the only generation step.
  try {
    await generateCode(dir, name, description, onStatus, errorContext, null, mode, templateInfo)
    log.info(`[${logName}] code generated`)
  } catch (err) {
    log.error(`[${logName}] code generation failed`, err.message)
    throw new Error(`Code generation failed: ${err.message}`)
  }

  // ── Clean up loading artifacts before Phase 3 ────────────────────────────
  if (templateStarted) {
    // If AI didn't generate a Dockerfile (overwrote loading one), restore template's
    const currentDockerfile = existsSync(join(dir, 'Dockerfile'))
      ? readFileSync(join(dir, 'Dockerfile'), 'utf8').trim()
      : ''
    if (currentDockerfile === LOADING_DOCKERFILE.trim() && existsSync(join(dir, 'Dockerfile.template'))) {
      writeFileSync(join(dir, 'Dockerfile'), readFileSync(join(dir, 'Dockerfile.template')))
      log.build(logName, 'Restored template Dockerfile (AI did not generate one)')
    }
    for (const f of ['Dockerfile.template', 'loading-server.js']) {
      try { rmSync(join(dir, f)) } catch {}
    }
  }

  // ── Phase 3: rebuild with AI-generated code ───────────────────────────────
  // For Node.js templates this is near-instant (just COPY new files + start).
  // For Vite templates the vite build runs with the new source code (~30-60s).
  if (!existsSync(join(dir, 'Dockerfile'))) {
    writeFileSync(join(dir, 'Dockerfile'), `# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]`)
    log.build(logName, 'Generated fallback Dockerfile')
  }

  log.build(logName, 'Phase 3: rebuilding with generated code')
  await onStatus('🐳 Applying...')

  const onDockerProgress = async (step) => { log.build(logName, `Docker: ${step}`) }

  try {
    await dockerComposeUp(dir, onDockerProgress)
    log.build(logName, 'Docker compose up OK')
    log.info(`[${logName}] docker compose up OK`)
  } catch (err) {
    log.buildError(logName, 'Docker compose up failed', err.message)
    log.error(`[${logName}] docker compose up failed`, err.message)
    throw err
  }

  // ── Health check ──────────────────────────────────────────────────────────
  await onStatus('🔍 Verifying...')

  const containerFullName = userStore.containerName(userId, name)
  const project = userStore.getProject(userId, name)
  let healthHost, healthPort
  log.info(`[${logName}] health check setup`, `domain=${config.domain || 'none'} project.port=${project?.port}`)

  if (!config.domain && project?.port) {
    healthHost = '127.0.0.1'
    healthPort = project.port
  } else {
    let ip = null
    for (let attempt = 0; attempt < 10; attempt++) {
      ip = await getContainerIpByFullName(containerFullName)
      if (ip) break
      await new Promise(r => setTimeout(r, 1000))
    }
    log.info(`[${logName}] container IP: ${ip || 'null'}`)
    if (!ip) {
      const logs = await getContainerLogsByFullName(containerFullName)
      log.error(`[${logName}] container has no IP`, logs)
      throw new Error(`Container failed to start.\n${logs.slice(-800)}`)
    }
    healthHost = ip
    healthPort = 3000
  }

  log.info(`[${logName}] polling health at ${healthHost}:${healthPort}`)

  const onHealthProgress = async (msg) => { log.build(logName, `Health: ${msg}`) }

  const healthy = await pollHealth(healthHost, healthPort, 60_000, onHealthProgress)
  if (!healthy) {
    const containerLogs = await getContainerLogsByFullName(containerFullName)
    log.buildError(logName, 'Health check failed after 60s', containerLogs)
    log.error(`[${logName}] health check failed after 60s`, containerLogs)
    throw new Error(`App not responding after 60s.\n${containerLogs.slice(-800)}`)
  }

  const url = projectUrl(userId, name)
  log.build(logName, `=== DEPLOY OK === ${url}`)
  log.info(`[${logName}] deploy OK → ${url}`)
  await onStatus(`✅ Ready → ${url}`)
}

// Animated progress indicator for Telegram
function createProgressAnimator(ctx, name, buildStart) {
  const frames = ['◐', '◓', '◑', '◒']
  const barFrames = ['▱▱▱▱▱', '▰▱▱▱▱', '▰▰▱▱▱', '▰▰▰▱▱', '▰▰▰▰▱', '▰▰▰▰▰']
  let msgId = null
  let currentText = ''
  let currentRetry = ''
  let frame = 0
  let barIdx = 0
  let timer = null
  let stopped = false

  const formatMsg = () => {
    const elapsed = Math.round((Date.now() - buildStart) / 1000)
    const timeStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
    const spinner = frames[frame % frames.length]
    const bar = barFrames[barIdx % barFrames.length]
    return `${spinner} *${name}*${currentRetry}\n${currentText}\n\`${bar}\` _${timeStr}_`
  }

  const tick = async () => {
    if (stopped || !msgId) return
    frame++
    // Advance bar slowly (every 2 ticks = 6s per step)
    if (frame % 2 === 0 && barIdx < barFrames.length - 1) barIdx++
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, formatMsg(), { parse_mode: 'Markdown' })
    } catch {}
  }

  return {
    async update(text) {
      currentText = text
      // Reset bar on phase change
      barIdx = 0
      frame = 0
      const fullText = formatMsg()
      if (msgId) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, fullText, { parse_mode: 'Markdown' })
        } catch {}
      } else {
        const msg = await ctx.reply(fullText, { parse_mode: 'Markdown' })
        msgId = msg.message_id
      }
      // Start animation loop
      if (timer) clearInterval(timer)
      timer = setInterval(tick, 3000)
    },
    setRetry(attempt, max) {
      currentRetry = ` · Retry ${attempt}/${max}`
    },
    resetMsg() {
      msgId = null
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}

async function deployWithRetry(ctx, dir, userId, name, description, action, model = null, mode = null) {
  let lastError = null
  const buildStart = Date.now()
  const slug = userStore.getUserSlug(userId)
  const logName = `${slug}-${name}`
  const anim = createProgressAnimator(ctx, name, buildStart)

  if (!mode) mode = action === 'new' ? 'new' : 'rebuild'

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      anim.setRetry(attempt, MAX_RETRIES)
      anim.resetMsg()
    }

    const onStatus = (text) => anim.update(text)

    try {
      await buildAndVerify(dir, userId, name, description, onStatus,
        attempt > 1 ? lastError?.message : null, model, mode)

      anim.stop()
      return true
    } catch (err) {
      lastError = err
      log.error(`[${logName}] attempt ${attempt} failed`, err.message)
      if (attempt < MAX_RETRIES) {
        anim.stop()
        await ctx.reply(`⚠️ Attempt ${attempt} failed, retrying...`, { parse_mode: 'Markdown' })
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  }

  anim.stop()
  log.error(`[${logName}] failed after ${MAX_RETRIES} attempts`, lastError?.message)
  await ctx.reply(`❌ *${name}* — Failed after ${MAX_RETRIES} attempts`, { parse_mode: 'Markdown' })
  return false
}

export async function deployNew(ctx, name, description, model = null) {
  const userId = getUserId(ctx)
  const dir = userStore.projectDir(userId, name)
  mkdirSync(dir, { recursive: true })
  try { execSync(`chown -R vpsbot:vpsbot ${JSON.stringify(dir)}`) } catch {}
  const ok = await deployWithRetry(ctx, dir, userId, name, description, 'new', model)
  if (ok) {
    userStore.setProject(userId, name, { description, url: projectUrl(userId, name), dir, model })

    const { Markup } = await import('telegraf')
    const url = projectUrl(userId, name)
    await ctx.reply(`✅ *${name}* created\n🔗 ${url}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('♻️ Rebuild', `rb:${name}`), Markup.button.callback('📋 Logs', `lg:${name}`)],
        [Markup.button.callback('🔗 URL', `url:${name}`), Markup.button.callback('⬅️ List', 'list')],
      ]),
    })
  }
  return ok
}

export async function deployRebuild(ctx, name, description, model = null, mode = 'patch') {
  const userId = getUserId(ctx)
  const dir = userStore.projectDir(userId, name)

  // For full rebuild, remove the project directory first to recreate from scratch
  if (mode === 'full') {
    try {
      await dockerComposeDown(dir)
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
      }
      mkdirSync(dir, { recursive: true })
      try { execSync(`chown -R vpsbot:vpsbot ${JSON.stringify(dir)}`) } catch {}
    } catch (err) {
      console.error('Error cleaning directory:', err.message)
    }
  }

  const ok = await deployWithRetry(ctx, dir, userId, name, description, 'rebuild', model, mode)
  if (ok) {
    userStore.setProject(userId, name, { description, url: projectUrl(userId, name), dir, model })

    const { Markup } = await import('telegraf')
    const url = projectUrl(userId, name)
    await ctx.reply(`✅ *${name}* updated\n🔗 ${url}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('♻️ Rebuild', `rb:${name}`), Markup.button.callback('📋 Logs', `lg:${name}`)],
        [Markup.button.callback('🔗 URL', `url:${name}`), Markup.button.callback('⬅️ List', 'list')],
      ]),
    })
  }
  return ok
}

export async function newCommand(ctx) {
  const userId = getUserId(ctx)
  const parts = ctx.message.text.split(' ')
  const rawName = parts[1]
  const description = parts.slice(2).join(' ').trim()

  if (!rawName || !description) {
    return ctx.reply('Usage: /new <name> <project description>')
  }

  const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  if (!userStore.canCreateProject(userId)) {
    return ctx.reply(`⚠️ Limit reached (${config.maxAppsPerUser} apps). Delete one first.`)
  }
  if (userStore.getProject(userId, name)) {
    return ctx.reply(`"${name}" already exists. Use /rebuild ${name} to update it.`)
  }

  const slug = userStore.getUserSlug(userId)
  const buildKey = `${slug}-${name}`
  if (buildingSet.has(buildKey)) return ctx.reply(`"${name}" is already building...`)

  buildingSet.add(buildKey)
  const msg = await ctx.reply('⚙️ Starting...', { parse_mode: 'Markdown' })
  const ok = await deployNew(ctx, name, description)
  buildingSet.delete(buildKey)

  if (ok) {
    return ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `✅ *${name}* is ready!\n\n🔗 ${projectUrl(userId, name)}\n\n_/rebuild ${name} to iterate_`,
      { parse_mode: 'Markdown' }
    )
  }
}

export async function rebuildCommand(ctx) {
  const userId = getUserId(ctx)
  const parts = ctx.message.text.split(' ')
  const name = parts[1]?.toLowerCase()
  const newDescription = parts.slice(2).join(' ').trim()

  if (!name) return ctx.reply('Usage: /rebuild <name> [new description]')

  const project = userStore.getProject(userId, name)
  if (!project) return ctx.reply(`Project "${name}" not found. Use /new to create it.`)

  const slug = userStore.getUserSlug(userId)
  const buildKey = `${slug}-${name}`
  if (buildingSet.has(buildKey)) return ctx.reply(`"${name}" is already building...`)

  buildingSet.add(buildKey)
  const description = newDescription || project.description
  const msg = await ctx.reply('♻️ Starting...', { parse_mode: 'Markdown' })
  const ok = await deployRebuild(ctx, name, description)
  buildingSet.delete(buildKey)

  if (ok) {
    return ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `✅ *${name}* updated!\n\n🔗 ${projectUrl(userId, name)}`,
      { parse_mode: 'Markdown' }
    )
  }
}

export async function listCommand(ctx) {
  const userId = getUserId(ctx)
  const projects = userStore.getAllProjects(userId)
  const names = Object.keys(projects)

  if (!names.length) {
    return ctx.reply('No projects yet. Use `/new <name> <description>` to create one.', { parse_mode: 'Markdown' })
  }

  const lines = names.map(n => {
    const p = projects[n]
    return `• *${n}*\n  🔗 ${p.url}\n  _${(p.description ?? '').slice(0, 80)}_`
  })

  return ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' })
}

export async function urlCommand(ctx) {
  const userId = getUserId(ctx)
  const name = ctx.message.text.split(' ')[1]?.toLowerCase()
  if (!name) return ctx.reply('Usage: /url <name>')

  const project = userStore.getProject(userId, name)
  if (!project) return ctx.reply(`Project "${name}" not found.`)

  return ctx.reply(`🔗 *${name}*: ${project.url}`, { parse_mode: 'Markdown' })
}

export async function deleteProjectCommand(ctx) {
  const userId = getUserId(ctx)
  const name = ctx.message.text.split(' ')[1]?.toLowerCase()
  if (!name) return ctx.reply('Usage: /delete <name>')

  const project = userStore.getProject(userId, name)
  if (!project) return ctx.reply(`Project "${name}" not found.`)

  const msg = await ctx.reply(`🗑️ Deleting *${name}*...`, { parse_mode: 'Markdown' })
  const dir = userStore.projectDir(userId, name)

  try {
    await dockerComposeDown(dir)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    userStore.deleteProject(userId, name)

    return ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `🗑️ *${name}* deleted.`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    return ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `❌ Error deleting *${name}*:\n\`${err.message.slice(0, 300)}\``,
      { parse_mode: 'Markdown' }
    )
  }
}