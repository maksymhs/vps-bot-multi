import { execSync } from 'child_process'
import { existsSync, readFileSync, cpSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import { log } from './logger.js'

const TEMPLATES_DIR = config.templatesDir || '/root/vps-bot-templates'
const TEMPLATES_REPO = config.templatesRepo || 'https://github.com/maksymhs/vps-bot-templates.git'

// ── Sync ────────────────────────────────────────────────────────────────────

export function syncTemplates() {
  try {
    if (existsSync(join(TEMPLATES_DIR, '.git'))) {
      execSync('git pull --ff-only 2>/dev/null || true', {
        cwd: TEMPLATES_DIR, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      })
      log.info('[templates] pulled latest')
    } else {
      execSync(`git clone --depth 1 ${TEMPLATES_REPO} ${TEMPLATES_DIR}`, {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
      })
      log.info('[templates] cloned from', TEMPLATES_REPO)
    }
    return true
  } catch (err) {
    log.error('[templates] sync failed', err.message)
    return false
  }
}

// ── Load data from repo ─────────────────────────────────────────────────────

function loadJson(relativePath) {
  const fullPath = join(TEMPLATES_DIR, relativePath)
  if (!existsSync(fullPath)) return null
  try { return JSON.parse(readFileSync(fullPath, 'utf8')) } catch { return null }
}

export function loadCatalog() {
  const data = loadJson('index.json')
  return data?.templates || []
}

function loadStacks() {
  const dir = join(TEMPLATES_DIR, 'stacks')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => loadJson(join('stacks', f)))
      .filter(Boolean)
  } catch { return [] }
}

function loadComponents() {
  const dir = join(TEMPLATES_DIR, 'components')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const meta = loadJson(join('components', d.name, 'component.json'))
        return meta ? { ...meta, name: meta.name || d.name } : null
      })
      .filter(Boolean)
  } catch { return [] }
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function scoreItem(item, description) {
  const desc = description.toLowerCase()
  const words = desc.split(/\s+/).filter(w => w.length > 2)
  let score = 0

  for (const tag of item.tags || []) {
    if (desc.includes(tag.toLowerCase())) score += 3
  }
  for (const tech of item.stack || []) {
    if (desc.includes(tech.toLowerCase())) score += 5
  }
  const itemDesc = (item.description || '').toLowerCase()
  for (const word of words) {
    if (itemDesc.includes(word)) score += 1
  }

  const categoryHints = {
    api: ['api', 'rest', 'backend', 'endpoint', 'server', 'webhook', 'microservice', 'crud'],
    fullstack: ['dashboard', 'admin', 'panel', 'saas', 'platform', 'fullstack', 'full-stack', 'webapp'],
    frontend: ['react', 'spa', 'interactive', 'tool', 'calculator', 'game', 'widget', 'app'],
    static: ['landing', 'page', 'portfolio', 'blog', 'site', 'website', 'simple', 'html', 'static'],
    auth: ['login', 'register', 'auth', 'user', 'session', 'jwt', 'signup'],
    database: ['database', 'db', 'sql', 'sqlite', 'postgres', 'mysql', 'data', 'store', 'persist'],
    payments: ['payment', 'stripe', 'billing', 'subscription', 'checkout', 'pay'],
  }
  const cat = item.category
  if (cat && categoryHints[cat]) {
    for (const hint of categoryHints[cat]) {
      if (desc.includes(hint)) score += 2
    }
  }
  return score
}

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Resolve the best build plan for a description.
 * Priority: stacks > templates. Components are added on top.
 * Returns { template, components[], stack?, score } or null.
 */
export function matchTemplate(description) {
  const templates = loadCatalog()
  const stacks = loadStacks()
  const components = loadComponents()

  let bestTemplate = null
  let bestScore = 0
  let matchedStack = null

  // 1. Score stacks first — a stack pre-defines template + components
  for (const stack of stacks) {
    const score = scoreItem(stack, description)
    if (score > bestScore) {
      bestScore = score
      matchedStack = stack
      bestTemplate = null
    }
  }

  // 2. Score individual templates
  for (const tpl of templates) {
    const score = scoreItem(tpl, description)
    if (score > bestScore) {
      bestScore = score
      bestTemplate = tpl
      matchedStack = null
    }
  }

  if (bestScore < 2) return null

  // If stack matched, resolve its template reference
  if (matchedStack) {
    bestTemplate = templates.find(t => t.name === matchedStack.template) || null
    if (!bestTemplate) {
      log.error(`[templates] stack "${matchedStack.name}" references unknown template "${matchedStack.template}"`)
      return null
    }
    // Stack defines its components
    const stackComponents = (matchedStack.components || [])
      .map(cName => components.find(c => c.name === cName))
      .filter(Boolean)

    log.info(`[templates] matched stack "${matchedStack.name}" (score=${bestScore}): template=${bestTemplate.name}, components=[${stackComponents.map(c => c.name).join(',')}]`)
    return {
      template: bestTemplate,
      components: stackComponents,
      stack: matchedStack,
      score: bestScore,
    }
  }

  // 3. Auto-detect compatible components for the matched template
  const matched = []
  for (const comp of components) {
    const compatible = comp.compatibleWith || []
    if (!compatible.includes(bestTemplate.name)) continue
    const cScore = scoreItem(comp, description)
    if (cScore >= 3) matched.push({ ...comp, _score: cScore })
  }
  matched.sort((a, b) => b._score - a._score)

  log.info(`[templates] matched template "${bestTemplate.name}" (score=${bestScore}), components=[${matched.map(c => c.name).join(',')}]`)
  return {
    template: bestTemplate,
    components: matched,
    stack: null,
    score: bestScore,
  }
}

// ── File operations ─────────────────────────────────────────────────────────

function listFiles(dir) {
  if (!existsSync(dir)) return []
  try {
    const files = []
    const entries = readdirSync(dir, { recursive: true, withFileTypes: false })
    for (const entry of entries) {
      if (typeof entry === 'string' && !entry.includes('node_modules')) {
        const full = join(dir, entry)
        try { if (statSync(full).isFile()) files.push(entry) } catch {}
      }
    }
    return files
  } catch { return [] }
}

function copyDir(src, dest) {
  if (!existsSync(src)) return false
  try {
    cpSync(src, dest, { recursive: true, force: false })
    return true
  } catch (err) {
    log.error(`[templates] copy failed: ${src}`, err.message)
    return false
  }
}

function readMd(filePath) {
  if (!existsSync(filePath)) return null
  try { return readFileSync(filePath, 'utf8') } catch { return null }
}

// ── Public API used by projects.js ──────────────────────────────────────────

export function copyBoilerplate(templateName, projectDir) {
  const src = join(TEMPLATES_DIR, 'templates', templateName, 'boilerplate')
  const ok = copyDir(src, projectDir)
  if (ok) log.info(`[templates] copied template boilerplate "${templateName}" → ${projectDir}`)
  return ok
}

export function copyComponentFiles(componentName, projectDir) {
  const src = join(TEMPLATES_DIR, 'components', componentName, 'files')
  const ok = copyDir(src, projectDir)
  if (ok) log.info(`[templates] copied component files "${componentName}" → ${projectDir}`)
  return ok
}

export function getInstructions(templateName) {
  return readMd(join(TEMPLATES_DIR, 'templates', templateName, 'INSTRUCTIONS.md'))
}

export function getComponentInstructions(componentName) {
  return readMd(join(TEMPLATES_DIR, 'components', componentName, 'INSTRUCTIONS.md'))
}

export function getBoilerplateFiles(templateName) {
  return listFiles(join(TEMPLATES_DIR, 'templates', templateName, 'boilerplate'))
}

export function getComponentFiles(componentName) {
  return listFiles(join(TEMPLATES_DIR, 'components', componentName, 'files'))
}

/**
 * Resolve full build context: copy all files & gather all instructions.
 * Called by projects.js after matchTemplate().
 * Returns { templateName, instructions, boilerplateFiles, components[] } or null.
 */
export function resolveAndCopy(match, projectDir) {
  const { template, components } = match

  // 1. Copy template boilerplate
  const tplCopied = copyBoilerplate(template.name, projectDir)
  if (!tplCopied) return null

  // 2. Copy component files (on top of template)
  const resolvedComponents = []
  for (const comp of components) {
    const copied = copyComponentFiles(comp.name, projectDir)
    const instructions = getComponentInstructions(comp.name)
    const files = getComponentFiles(comp.name)
    resolvedComponents.push({
      name: comp.name,
      displayName: comp.displayName || comp.name,
      copied,
      instructions,
      files,
    })
  }

  // 3. Gather instructions
  const templateInstructions = getInstructions(template.name)
  const componentInstructions = resolvedComponents
    .map(c => c.instructions)
    .filter(Boolean)

  // Combine all instructions
  let fullInstructions = ''
  if (templateInstructions) {
    fullInstructions += `## Base Template: ${template.displayName}\n\n${templateInstructions}\n\n`
  }
  for (const comp of resolvedComponents) {
    if (comp.instructions) {
      fullInstructions += `## Component: ${comp.displayName}\n\n${comp.instructions}\n\n`
    }
  }

  // 4. Gather all files
  const allFiles = [
    ...getBoilerplateFiles(template.name),
    ...resolvedComponents.flatMap(c => c.files.map(f => `[${c.name}] ${f}`)),
  ]

  log.info(`[templates] resolved: template=${template.name}, components=[${resolvedComponents.map(c => c.name).join(',')}], files=${allFiles.length}`)

  return {
    templateName: template.name,
    stackName: match.stack?.name || null,
    instructions: fullInstructions || null,
    boilerplateFiles: allFiles,
    components: resolvedComponents.map(c => c.name),
  }
}
