/**
 * next-template.js
 *
 * Copies the built-in Next.js 14 + React 18 + Tailwind CSS boilerplate
 * (stored in templates/next-react/ inside this repo) to the target project
 * directory, then provides the AI prompt so it only outputs what changes.
 *
 * No external git repo. No matching logic. One template for everything.
 */

import { cpSync, readdirSync, statSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Physical template folder: <repo-root>/templates/next-react/
const TEMPLATE_DIR = join(__dirname, '../../templates/next-react')

// ── file helpers ───────────────────────────────────────────────────────────

/** Recursively collect all relative file paths inside a directory. */
function listFiles(dir, base = dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      files.push(...listFiles(full, base))
    } else if (e.name !== '.gitkeep') {
      files.push(relative(base, full))
    }
  }
  return files
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Copy the Next.js template into `destDir`.
 * Returns the list of relative file paths that were written.
 */
export function copyNextTemplate(destDir) {
  cpSync(TEMPLATE_DIR, destDir, { recursive: true })
  return listFiles(TEMPLATE_DIR)
}

// ── AI prompt ──────────────────────────────────────────────────────────────

/** Files the AI must never re-generate (infrastructure handled separately). */
const SKIP_OUTPUT = [
  'Dockerfile', 'docker-compose.yml', 'builder-server.js',
  '.dockerignore', '.gitignore', '.build-prompt.txt',
  '.build-system-prompt.txt', '.build-config.json',
]

/**
 * Build the prompt for the AI to customise the Next.js template.
 *
 * @param {string}   name            - project slug
 * @param {string}   description     - user's request
 * @param {string[]} boilerplateFiles - list returned by copyNextTemplate()
 * @param {string|null} errorContext - previous build error, if any
 */
export function buildNextPrompt(name, description, boilerplateFiles, errorContext = null) {
  const fileList = boilerplateFiles.map(f => `  - ${f}`).join('\n')

  let prompt =
    `You are customising a Next.js 14 + React 18 + Tailwind CSS boilerplate for the following request.\n\n` +
    `App name: ${name}\n` +
    `User request: ${description}\n\n` +
    `BOILERPLATE ALREADY ON DISK (do NOT reproduce these files unless they must change):\n` +
    `${fileList}\n\n` +
    `STACK RULES:\n` +
    `• Use Next.js 14 App Router (app/ directory). No pages/ directory.\n` +
    `• Style exclusively with Tailwind CSS utility classes. No external UI libraries unless the user explicitly asks.\n` +
    `• Add "use client" only when the component needs browser APIs or event handlers.\n` +
    `• Keep app/api/health/route.js returning { status: "ok" } — never delete or modify it.\n` +
    `• Keep package.json scripts.start as "next dev -p \${PORT:-3000}".\n` +
    `• ALWAYS output package.json (set the name field to "${name}" and add any new deps).\n` +
    `• Do NOT output: ${SKIP_OUTPUT.join(', ')}\n\n` +
    `OUTPUT RULES:\n` +
    `• Output ONLY the files that are different from the boilerplate for this specific request.\n` +
    `• Put new React components in app/ or components/ as appropriate.\n` +
    `• Design must be modern, visually polished, and mobile-responsive.\n` +
    `• ASCII characters only inside JS/JSX. No explanations outside code blocks.`

  if (errorContext) {
    prompt += `\n\n⚠️ PREVIOUS BUILD ERROR — analyse and fix:\n${errorContext.slice(0, 1200)}`
  }

  return prompt
}
