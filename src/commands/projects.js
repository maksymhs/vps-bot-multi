import { execFile, execSync, spawn } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { getDocker } from '../lib/docker-client.js'
import { buildingSet, pollingSet } from '../lib/build-state.js'
import { config } from '../lib/config.js'
import { userStore } from '../lib/user-store.js'
import { log } from '../lib/logger.js'
import { copyNextTemplate, buildNextPrompt } from '../lib/next-template.js'
import { enqueueBuild, getQueuePosition } from '../lib/build-queue.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUILDER_SERVER_JS = readFileSync(join(__dirname, '../lib/builder-server.js'), 'utf8')
const TEMPLATE_PKG = join(__dirname, '../../templates/next-react/package.json')

// ── Pre-built base image ────────────────────────────────────────────────────
// Built once from the template package.json so every new project inherits
// node_modules without running npm install during docker build.
export async function ensureBaseImage() {
  try {
    const images = await getDocker().listImages({
      filters: JSON.stringify({ reference: ['vpsbot-next-base'] }),
    })
    if (images.length > 0) {
      log.info('[base-image] vpsbot-next-base already exists')
      return
    }
  } catch {}

  log.info('[base-image] building vpsbot-next-base (first time, ~60s)...')
  const tmpDir = mkdtempSync(join(tmpdir(), 'vpsbot-base-'))
  try {
    copyFileSync(TEMPLATE_PKG, join(tmpDir, 'package.json'))
    writeFileSync(join(tmpDir, 'Dockerfile'), [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package.json ./',
      'RUN --mount=type=cache,target=/root/.npm npm install',
    ].join('\n') + '\n')
    execSync(`DOCKER_BUILDKIT=1 docker build -t vpsbot-next-base:latest "${tmpDir}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000,
    })
    log.info('[base-image] vpsbot-next-base built successfully')
  } catch (err) {
    log.error('[base-image] build failed — containers will install deps themselves:', err.message)
    // Fallback: write a plain Dockerfile without the base image so builds still work
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

const MAX_RETRIES = 2

// Single Dockerfile: inherits deps from pre-built base image — no npm install at build time.
// node_modules come from vpsbot-next-base; builder-server.js installs new deps on demand.
const BASE_IMAGE = 'vpsbot-next-base:latest'
const BUILDER_DOCKERFILE = `FROM ${BASE_IMAGE}
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["node", "builder-server.js"]
`

const SYSTEM_PROMPT = `You are a code generator. Output ONLY file contents in this exact format for EACH file:

--- FILE: path/to/file.ext ---
file contents here
--- END FILE ---

CRITICAL OUTPUT ORDER: Always output Dockerfile first, then package.json second, then all remaining files. This order is mandatory.
DOCKERFILE RULES: Always use "COPY package*.json ./" (never "COPY package.json package-lock.json ./"). Always use node:20-alpine. Always use --mount=type=cache,target=/root/.npm for npm install.
For multi-stage Vite builds Stage 2 MUST include node_modules — use exactly this pattern:
  FROM node:20-alpine AS build
  WORKDIR /app
  COPY package*.json ./
  RUN --mount=type=cache,target=/root/.npm npm install
  COPY . .
  RUN npm run build
  FROM node:20-alpine
  WORKDIR /app
  COPY --from=build /app/dist ./dist
  COPY --from=build /app/node_modules ./node_modules
  COPY --from=build /app/package.json ./
  EXPOSE 3000
  CMD ["npm", "start"]
TOOLKIT FILES: Files listed with a [component-name] prefix are pre-built toolkit files. Do NOT rewrite or output them — only output application files that need to change.
Do NOT include explanations, comments outside code, or markdown fences. Output ONLY the files specified in the task. Every file must use this exact format.`

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

// Builder compose: adds env vars for the AI builder container (no volume needed — files are baked in)
function writeBuilderComposeFile(dir, userId, name) {
  const containerName = userStore.containerName(userId, name)
  const subdomain = name
  let compose
  if (config.domain) {
    compose = `services:
  app:
    container_name: ${containerName}
    build: .
    restart: unless-stopped
    environment:
      - OPENROUTER_API_KEY=${config.openrouterKey || ''}
      - PROJECT_NAME=${name}
      - REBUILD_SECRET=${config.rebuildSecret}
    networks:
      - caddy
    labels:
      caddy: ${subdomain}.${config.domain}
      caddy.reverse_proxy: "{{upstreams 3000}}"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 10s
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
    environment:
      - OPENROUTER_API_KEY=${config.openrouterKey || ''}
      - PROJECT_NAME=${name}
      - REBUILD_SECRET=${config.rebuildSecret}
    ports:
      - "${port}:3000"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
`
  }
  writeFileSync(join(dir, 'docker-compose.yml'), compose)
}

// Stream container logs to the build log file in the background.
// Runs until the container stops or MAX_LOG_FOLLOW_MS elapses.
const MAX_LOG_FOLLOW_MS = 15 * 60 * 1000  // 15 min ceiling

function followContainerLogs(containerFullName, logName) {
  const child = spawn('docker', ['logs', '--follow', '--timestamps', containerFullName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const writeLine = (line) => {
    // Strip Docker multiplexed stream header bytes (8-byte binary prefix)
    line = line.replace(/^[\x00-\x02][\x00\x00\x00\x00][\x00-\xff][\x00-\xff][\x00-\xff][\x00-\xff]/, '').trim()
    if (line) log.build(logName, `[container] ${line}`)
  }

  child.stdout.on('data', d => d.toString().split('\n').forEach(writeLine))
  child.stderr.on('data', d => d.toString().split('\n').forEach(writeLine))
  child.on('exit', (code) => log.build(logName, `[container] log stream ended (exit ${code})`))
  child.on('error', () => {})

  const timer = setTimeout(() => { try { child.kill() } catch {} }, MAX_LOG_FOLLOW_MS)
  child.on('exit', () => clearTimeout(timer))
}

// Start the builder container (fire-and-forget).
// The container handles generation → npm install → npm build → app launch internally.
// Returns 'async' on success (caller skips Phase 3), false if container failed to start.
// ── Fast HTTP rebuild: sends description to running container, no Docker needed ──
async function rebuildViaHttp(url, description) {
  if (!config.rebuildSecret) return false
  try {
    const res = await fetch(url + '/rebuild', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Rebuild-Secret':  config.rebuildSecret,
      },
      body:   JSON.stringify({ description }),
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function runBuilderContainer(dir, userId, name, prompt, logName, onStatus, buildConfig = {}) {
  // ── Sync latest files from running container → host dir ──────────────────
  // On patch/rebuild, the AI previously modified files inside the container.
  // The host dir may have stale template files. Sync before the new build so
  // the AI sees the current state and the build context is up to date.
  const containerName = userStore.containerName(userId, name)
  try {
    execSync(`docker cp "${containerName}:/app/." "${dir}/"`, { stdio: 'pipe' })
    log.build(logName, 'Synced files from running container to host')
  } catch {
    // Container not running yet (first build) — files already in dir from template copy
  }

  // Write builder artifacts (overwrite whatever was synced)
  writeFileSync(join(dir, '.build-prompt.txt'), prompt)
  writeFileSync(join(dir, '.build-system-prompt.txt'), SYSTEM_PROMPT)
  writeFileSync(join(dir, '.build-config.json'), JSON.stringify({
    mode:      buildConfig.mode || 'generate',
    maxTokens: buildConfig.maxTokens || 14000,
  }))
  writeFileSync(join(dir, 'builder-server.js'), BUILDER_SERVER_JS)

  // Use base image if available; fall back to full install Dockerfile if not
  let dockerfile = BUILDER_DOCKERFILE
  try {
    const images = await getDocker().listImages({ filters: JSON.stringify({ reference: ['vpsbot-next-base'] }) })
    if (!images.length) {
      log.build(logName, 'Base image not found — using fallback Dockerfile with npm install')
      dockerfile = `FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN --mount=type=cache,target=/root/.npm npm install\nCOPY . .\nEXPOSE 3000\nCMD ["node", "builder-server.js"]\n`
    }
  } catch {}
  writeFileSync(join(dir, 'Dockerfile'), dockerfile)
  writeFileSync(join(dir, '.dockerignore'), '.git\nnode_modules\n*.md\n.env\n')
  writeBuilderComposeFile(dir, userId, name)

  log.build(logName, 'Builder container: starting')
  try {
    await dockerComposeUp(dir, null)
  } catch (err) {
    log.build(logName, `Builder container failed to start: ${err.message}`)
    return false
  }

  // Wait until builder-server.js is actually serving before sending the URL.
  // Resolve container address (domain mode → container IP, IP mode → host:port).
  let healthHost, healthPort
  const project = userStore.getProject(userId, name)
  if (!config.domain && project?.port) {
    healthHost = '127.0.0.1'
    healthPort = project.port
  } else {
    for (let i = 0; i < 20; i++) {
      const ip = await getContainerIpByFullName(containerName)
      if (ip) { healthHost = ip; healthPort = 3000; break }
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  if (healthHost) {
    await pollHealth(healthHost, healthPort, 30_000)
    log.build(logName, `Builder console ready at ${healthHost}:${healthPort}`)
  }

  const url = projectUrl(userId, name)
  log.build(logName, `Builder container live → ${url}`)
  await onStatus(`🌐 Open now: ${url}\n🧠 AI is building your app live...`)

  // Stream container output to the build log (non-blocking)
  followContainerLogs(containerName, logName)

  // The container self-manages: generation → install → launch. Nothing more to do here.
  return 'async'
}

function buildClaudePrompt(name, description, errorContext = null, templateInfo = null, dir = null) {
  // If we have a matched template, use template-aware prompt
  if (templateInfo) {
    return buildTemplatePrompt(name, description, templateInfo, errorContext, dir)
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

// Files the AI should never output for template builds (handled by the builder infrastructure)
const TEMPLATE_SKIP_OUTPUT = new Set([
  'Dockerfile', 'docker-compose.yml', 'builder-server.js',
  '.dockerignore', '.gitignore', '.build-prompt.txt', '.build-system-prompt.txt', '.build-config.json',
  'vite.config.js', 'vite.config.ts', 'main.jsx', 'main.tsx', 'main.js',
])
// Files to skip when reading boilerplate contents (large or binary)
const TEMPLATE_SKIP_READ = new Set([
  'Dockerfile', 'docker-compose.yml', 'builder-server.js', '.dockerignore', '.gitignore',
  '.build-prompt.txt', '.build-system-prompt.txt', '.build-config.json', 'package-lock.json',
])
const BOILERPLATE_MAX_FILE_CHARS = 6000

function buildTemplatePrompt(name, description, templateInfo, errorContext = null, dir = null) {
  const { templateName, stackName, instructions, boilerplateFiles, components } = templateInfo
  const source = stackName ? `stack "${stackName}"` : `template "${templateName}"`

  // Read boilerplate file contents from disk so AI knows exactly what already exists
  let boilerplateSection = ''
  if (dir) {
    const fileParts = []
    for (const f of boilerplateFiles) {
      if (TEMPLATE_SKIP_READ.has(f.split('/').pop())) continue
      try {
        const content = readFileSync(join(dir, f), 'utf8')
        if (content.length <= BOILERPLATE_MAX_FILE_CHARS) {
          fileParts.push(`--- FILE: ${f} ---\n${content}\n--- END FILE ---`)
        }
      } catch {}
    }
    if (fileParts.length) {
      boilerplateSection = `\nBOILERPLATE ALREADY DEPLOYED (files live in the container):\n\n${fileParts.join('\n\n')}\n`
    }
  }

  let prompt =
    `Customize this ${source} boilerplate for the user's request.\n\n` +
    `App name: ${name}\n` +
    `User request: ${description}\n` +
    boilerplateSection + '\n'

  if (instructions) {
    prompt += `TEMPLATE INSTRUCTIONS:\n${instructions}\n\n`
  }

  if (components.length) {
    prompt += `PRE-BUILT COMPONENTS (do NOT rewrite): ${components.join(', ')}\n\n`
  }

  prompt +=
    `OUTPUT RULES — read carefully:\n` +
    `• The boilerplate files above are ALREADY in the container. Do NOT regenerate them unchanged.\n` +
    `• Output ONLY files that need to change for this specific request.\n` +
    `• Minimum output = fastest build. Only output what is genuinely different.\n` +
    `• ALWAYS output: package.json (update name to "${name}")\n` +
    `• Output HTML/CSS/JS/JSX only if you must customize the content for this request\n` +
    `• Do NOT output: ${[...TEMPLATE_SKIP_OUTPUT].join(', ')}\n` +
    `• GET /health must return { status: "ok" } — do not break it\n` +
    `• ASCII only. No explanations outside code blocks.`

  if (errorContext) {
    prompt += `\n\n⚠️ STARTUP ERROR TO FIX:\n${errorContext.slice(0, 1200)}`
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
    `7. Dockerfiles: always use "COPY package*.json ./" and node:20-alpine\n` +
    `8. Write modified files to disk. Code only, no explanations.`

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

// Rewrite direct named imports to use barrel index when available.
// Fixes AI habit of: import { CartoonSun } from './components/3d/CartoonSun'
// when only default export exists in that file but barrel re-exports it as named.
function fixComponentImports(dir) {
  try {
    const jsFiles = []
    const scanDir = join(dir, 'src')
    function scan(d) {
      try {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue
          const full = join(d, entry.name)
          if (entry.isDirectory()) scan(full)
          else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) jsFiles.push(full)
        }
      } catch {}
    }
    if (existsSync(scanDir)) scan(scanDir)

    for (const filePath of jsFiles) {
      let content
      try { content = readFileSync(filePath, 'utf8') } catch { continue }

      // Match named imports whose path ends with a capitalized segment (component name)
      // e.g. import { CartoonSun } from './components/3d/CartoonSun'
      //   or import { CartoonSun } from './components/3d/CartoonSun.jsx'
      const importRe = /^(import\s+\{[^}]+\}\s+from\s+['"])(\.[^'"]+\/[A-Z][^'"]*)(['"])/gm
      const modified = content.replace(importRe, (match, prefix, importPath, suffix) => {
        const parentDir = dirname(join(dirname(filePath), importPath))
        if (existsSync(join(parentDir, 'index.js'))) {
          // Use the directory barrel instead
          return `${prefix}${dirname(importPath)}${suffix}`
        }
        return match
      })

      if (modified !== content) {
        writeFileSync(filePath, modified)
        log.build(dir.split('/').pop(), `Fixed barrel imports in ${filePath.replace(dir + '/', '')}`)
      }
    }
  } catch (err) {
    log.error('[fixComponentImports]', err.message)
  }
}

// Fix package.json scripts.start pointing to a non-existent file.
// The AI often writes "node src/server.js" but may create the file as
// "server.js" (root) or "src/index.js". Also generates a minimal fallback
// server for Vite apps if no server file is found at all.
function fixPackageStart(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const startCmd = pkg.scripts?.start
    if (!startCmd) return

    const nodeMatch = startCmd.match(/node\s+(\S+\.(?:js|mjs|cjs))/)
    if (!nodeMatch) return
    const declared = nodeMatch[1]

    if (existsSync(join(dir, declared))) return  // all good

    // Find an existing server/index file
    const candidates = ['server.js', 'src/index.js', 'index.js', 'src/app.js', 'app.js', 'src/server.js']
    const found = candidates.find(c => c !== declared && existsSync(join(dir, c)))
    if (found) {
      pkg.scripts.start = `node ${found}`
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
      log.build(dir.split('/').pop(), `Fixed package.json start: "${startCmd}" → "node ${found}"`)
      return
    }

    // No server file at all — generate a minimal Express server for Vite dist
    const serverContent = `import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.static(join(__dirname, 'dist')))
app.get('/health', (_, res) => res.json({ status: 'ok' }))
app.get('*', (_, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
app.listen(process.env.PORT || 3000)
`
    writeFileSync(join(dir, 'server.js'), serverContent)
    pkg.scripts.start = 'node server.js'
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    log.build(dir.split('/').pop(), `Generated fallback server.js (start was "${startCmd}", file missing)`)
  } catch (err) {
    log.error('[fixPackageStart]', err.message)
  }
}

const BUILDER_ARTIFACTS = new Set([
  'builder-server.js', '.build-prompt.txt', '.build-system-prompt.txt',
  '.build-error', 'docker-compose.yml', 'Dockerfile', '.dockerignore',
])

function getExistingFiles(dir) {
  try {
    const entries = execSync(`find ${JSON.stringify(dir)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null || true`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim().split('\n').filter(Boolean)
    return entries
      .map(e => e.replace(dir + '/', ''))
      .filter(f => f && !f.startsWith('.git/') && !BUILDER_ARTIFACTS.has(f))
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

  const systemPrompt = SYSTEM_PROMPT

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
  fixComponentImports(dir)
  fixPackageStart(dir)
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

  // ── Template scaffold (Next.js 14 + React + Tailwind) ─────────────────────
  let builderResult = false   // 'async' | false

  if (mode === 'new' || mode === 'full') {
    await onStatus('📦 Preparing Next.js template...')
    const boilerplateFiles = copyNextTemplate(dir)
    try { execSync(`chown -R vpsbot:vpsbot ${JSON.stringify(dir)}`) } catch {}
    userStore.setProject(userId, name, { template: 'next-react' })
    log.info(`[${logName}] next-react boilerplate written: ${boilerplateFiles.length} files`)

    const prompt = buildNextPrompt(name, description, boilerplateFiles, errorContext)
    builderResult = await runBuilderContainer(dir, userId, name, prompt, logName, onStatus, { mode: 'patch', maxTokens: 8000 })
  }

  // ── Builder container for patch mode ───────────────────────────────────────
  if (!builderResult && config.openrouterKey) {
    if (mode === 'patch') {
      // Try fast HTTP rebuild first (no Docker, no container restart)
      const url = projectUrl(userId, name)
      log.build(logName, `Attempting HTTP rebuild → ${url}`)
      const ok = await rebuildViaHttp(url, description)
      if (ok) {
        log.build(logName, 'HTTP rebuild accepted by container')
        builderResult = 'async'
      } else {
        // Container not reachable — fall back to full Docker rebuild
        log.build(logName, 'HTTP rebuild failed, falling back to Docker rebuild')
        const existingFiles = getExistingFiles(dir)
        const prompt = buildRebuildPrompt(name, description, 'patch', existingFiles, errorContext)
        builderResult = await runBuilderContainer(dir, userId, name, prompt, logName, onStatus)
      }
    }
  }

  // ── Builder is self-managing: generation → install → launch inside container ─
  // Return 'async' so callers know to fire pollUntilReady.
  if (builderResult === 'async') {
    const url = projectUrl(userId, name)
    log.build(logName, `=== ASYNC DEPLOY === ${url}`)
    return 'async'
  }

  // ── Fallback: external generation + docker rebuild ────────────────────────
  // Only reached if builder container failed to start (Docker unavailable, etc.)
  writeComposeFile(dir, userId, name)
  try {
    await generateCode(dir, name, description, onStatus, errorContext, null, mode, null)
    log.info(`[${logName}] code generated (external)`)
  } catch (err) {
    log.error(`[${logName}] code generation failed`, err.message)
    throw new Error(`Code generation failed: ${err.message}`)
  }

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

  log.build(logName, 'Rebuilding with generated code...')
  await onStatus('🐳 Applying...')
  try {
    await dockerComposeUp(dir, async (step) => { log.build(logName, `Docker: ${step}`) })
    log.build(logName, 'Docker compose up OK')
  } catch (err) {
    log.buildError(logName, 'Docker compose up failed', err.message)
    throw err
  }

  await onStatus('🔍 Verifying...')

  const containerFullName = userStore.containerName(userId, name)
  const project = userStore.getProject(userId, name)
  let healthHost, healthPort

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
    if (!ip) {
      const logs = await getContainerLogsByFullName(containerFullName)
      throw new Error(`Container failed to start.\n${logs.slice(-800)}`)
    }
    healthHost = ip
    healthPort = 3000
  }

  const healthy = await pollHealth(healthHost, healthPort, 60_000,
    async (msg) => { log.build(logName, `Health: ${msg}`) })
  if (!healthy) {
    const containerLogs = await getContainerLogsByFullName(containerFullName)
    throw new Error(`App not responding after 60s.\n${containerLogs.slice(-800)}`)
  }

  const url = projectUrl(userId, name)
  log.build(logName, `=== DEPLOY OK === ${url}`)
  await onStatus(`✅ Ready → ${url}`)
}

async function deployWithRetry(ctx, dir, userId, name, description, action, model = null, mode = null) {
  let lastError = null
  const slug = userStore.getUserSlug(userId)
  const logName = `${slug}-${name}`

  if (!mode) mode = action === 'new' ? 'new' : 'rebuild'

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const onStatus = (text) => log.info(`[${logName}] ${text}`)

    try {
      const result = await buildAndVerify(dir, userId, name, description, onStatus,
        attempt > 1 ? lastError?.message : null, model, mode)
      return result === 'async' ? 'async' : true
    } catch (err) {
      lastError = err
      log.error(`[${logName}] attempt ${attempt} failed`, err.message)
      if (attempt < MAX_RETRIES) {
        await ctx.reply(`⚠️ Attempt ${attempt} failed, retrying...`, { parse_mode: 'Markdown' })
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  }

  log.error(`[${logName}] failed after ${MAX_RETRIES} attempts`, lastError?.message)
  await ctx.reply(`❌ *${name}* — Failed to start. Check your config.`, { parse_mode: 'Markdown' })
  return false
}

async function sendProjectMessage(ctx, name, result, loadingMsg = null, mode = 'new') {
  const { Markup } = await import('telegraf')
  const url = projectUrl(getUserId(ctx), name)

  let text, keyboard
  const baseButtons = [
    [Markup.button.callback('♻️ Rebuild', `rb:${name}`), Markup.button.callback('📋 Logs', `lg:${name}`)],
    [Markup.button.callback('🔗 URL', `url:${name}`), Markup.button.callback('⬅️ List', 'list')],
  ]

  if (result === 'async' && mode === 'patch') {
    text = `🔨 *${name}* — patching\n\n_The page will reload automatically when done._`
    keyboard = Markup.inlineKeyboard(baseButtons)
  } else if (result === 'async') {
    text = `🚀 *${name}*\n\n_Building your app — the URL will show it live when ready._\n🔗 ${url}`
    keyboard = Markup.inlineKeyboard([
      [Markup.button.url('🔗 Open', url)],
      ...baseButtons,
    ])
  } else {
    text = `✅ *${name}* is ready\n🔗 ${url}`
    keyboard = Markup.inlineKeyboard(baseButtons)
  }

  if (loadingMsg) {
    await ctx.telegram.editMessageText(
      loadingMsg.chat.id, loadingMsg.message_id, null,
      text, { parse_mode: 'Markdown', ...keyboard }
    ).catch(() => ctx.reply(text, { parse_mode: 'Markdown', ...keyboard }))
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard })
  }
}

// Progress bar helpers for Telegram build status messages
const PHASE_STEPS = { starting: 1, thinking: 3, editing: 5, installing: 7, building: 8, launching: 9, running: 10 }
const PHASE_LABEL = { thinking: 'Agent thinking', editing: 'Applying changes', installing: 'Installing deps', building: 'Building', launching: 'Launching', starting: 'Starting' }
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
function buildProgressText(name, url, phase, userInput, tick) {
  const n = PHASE_STEPS[phase] ?? 1
  const bar = '▓'.repeat(n) + '░'.repeat(10 - n)
  const spin = SPINNER_FRAMES[(tick || 0) % SPINNER_FRAMES.length]
  const label = PHASE_LABEL[phase] || 'Working'
  if (userInput) {
    return `🔨 *${name}* — _"${userInput.slice(0, 55)}"_\n\`${bar}\` ${spin} ${label}...\n[🌐 Watch live](${url})`
  }
  return `⏳ *${name}*\n\`${bar}\` ${spin} ${label}...\n[🌐 Watch live](${url})`
}

// Poll container /health in background; update Telegram message with progress bar,
// then show completion message with applied change + "type next change" hint.
async function pollUntilReady(ctx, userId, name, loadingMsg, userInput) {
  if (!loadingMsg) return
  const buildKey = `${userStore.getUserSlug(userId)}-${name}`
  pollingSet.add(buildKey)   // mark as "build running inside container"
  const containerName = userStore.containerName(userId, name)
  // Wait for container IP (may take a couple seconds on first boot)
  let host = null
  for (let i = 0; i < 15; i++) {
    try { host = await getContainerIpByFullName(containerName) } catch {}
    if (host) break
    await new Promise(r => setTimeout(r, 2000))
  }
  if (!host) { pollingSet.delete(buildKey); return }
  const url = projectUrl(userId, name)
  let tick = 0

  // Poll /health every 3s for up to 5 minutes
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const ctrl = new AbortController()
      const tid = setTimeout(() => ctrl.abort(), 3000)
      const resp = await fetch(`http://${host}:3000/health`, { signal: ctrl.signal })
      clearTimeout(tid)
      const data = await resp.json()
      const phase = data.phase || data.state || 'starting'

      // Update every tick so the spinner animates (Telegram ignores edits with identical text)
      if (data.state !== 'running' && data.state !== 'error') {
        tick++
        const { Markup } = await import('telegraf')
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id, loadingMsg.message_id, null,
          buildProgressText(name, url, phase, userInput, tick),
          { parse_mode: 'Markdown', disable_web_page_preview: true, ...Markup.inlineKeyboard([]) }
        ).catch(() => {})
      }

      if (data.state === 'running') {
        pollingSet.delete(buildKey)
        const { Markup } = await import('telegraf')
        let completionText, completionKeyboard

        if (userInput) {
          // Conversational change — compact: no URL, just confirmation + hint
          completionText =
            `✅ _"${userInput.slice(0, 70)}"_ aplicado a *${name}*\n\n` +
            `_Ya visible en la web. Sigue escribiendo cambios o usa el menú._`
          completionKeyboard = Markup.inlineKeyboard([
            [Markup.button.url('🔗 Abrir app', url), Markup.button.callback('📋 Logs', `lg:${name}`), Markup.button.callback('⬅️ Menú', 'main')],
          ])
        } else {
          // Menu-triggered rebuild or new project — full message with URL
          completionText =
            `✅ *${name}* is ready\n🔗 ${url}\n\n_Type your next change directly in the chat._`
          completionKeyboard = Markup.inlineKeyboard([
            [Markup.button.url('🔗 Open', url), Markup.button.callback('♻️ Rebuild', `rb:${name}`)],
            [Markup.button.callback('📋 Logs', `lg:${name}`), Markup.button.callback('⬅️ List', 'list')],
          ])
        }

        await ctx.telegram.editMessageText(
          loadingMsg.chat.id, loadingMsg.message_id, null,
          completionText,
          { parse_mode: 'Markdown', ...completionKeyboard }
        ).catch(() => {})
        return
      }

      if (data.state === 'error') {
        pollingSet.delete(buildKey)
        const { Markup } = await import('telegraf')
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id, loadingMsg.message_id, null,
          `❌ *${name}* build failed`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('♻️ Retry', `rb:${name}`), Markup.button.callback('⬅️ Menu', 'main')]]) }
        ).catch(() => {})
        return
      }
    } catch { /* container not ready yet, keep polling */ }
  }
  // Timeout — clean up
  pollingSet.delete(buildKey)
}

export async function deployNew(ctx, name, description, model = null) {
  const userId = getUserId(ctx)
  const dir = userStore.projectDir(userId, name)
  mkdirSync(dir, { recursive: true })
  try { execSync(`chown -R vpsbot:vpsbot ${JSON.stringify(dir)}`) } catch {}
  const loadingMsg = await ctx.reply(`⏳ *${name}*\n_Starting build..._`, { parse_mode: 'Markdown' }).catch(() => null)
  const result = await deployWithRetry(ctx, dir, userId, name, description, 'new', model)
  if (result) {
    userStore.setProject(userId, name, { description, url: projectUrl(userId, name), dir, model })
    await sendProjectMessage(ctx, name, result, loadingMsg)
    if (result === 'async') pollUntilReady(ctx, userId, name, loadingMsg)
  } else if (loadingMsg) {
    await ctx.telegram.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => {})
  }
  return result
}

export async function deployRebuild(ctx, name, description, model = null, mode = 'patch', userInput = null) {
  const userId = getUserId(ctx)
  const dir = userStore.projectDir(userId, name)

  if (mode === 'full') {
    try {
      await dockerComposeDown(dir)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      try { execSync(`chown -R vpsbot:vpsbot ${JSON.stringify(dir)}`) } catch {}
    } catch (err) {
      console.error('Error cleaning directory:', err.message)
    }
  }

  // Conversational changes get a compact one-liner; menu rebuilds get the full message
  const initialText = userInput
    ? `🔨 _"${userInput.slice(0, 60)}"_ — applying to *${name}*...`
    : `⏳ *${name}*\n_Rebuilding..._`
  const loadingMsg = await ctx.reply(initialText, { parse_mode: 'Markdown' }).catch(() => null)
  const result = await deployWithRetry(ctx, dir, userId, name, description, 'rebuild', model, mode)
  if (result) {
    userStore.setProject(userId, name, { description, url: projectUrl(userId, name), dir, model })
    // For conversational changes, skip sendProjectMessage — pollUntilReady owns the message
    if (!userInput) await sendProjectMessage(ctx, name, result, loadingMsg, mode)
    if (result === 'async') pollUntilReady(ctx, userId, name, loadingMsg, userInput)
  } else if (loadingMsg) {
    await ctx.telegram.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => {})
  }
  return result
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
  await deployNew(ctx, name, description)
  buildingSet.delete(buildKey)
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
  await deployRebuild(ctx, name, description)
  buildingSet.delete(buildKey)
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