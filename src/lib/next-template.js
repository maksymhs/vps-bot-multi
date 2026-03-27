/**
 * Built-in Next.js 14 + React 18 + Tailwind CSS boilerplate.
 *
 * copyNextTemplate(dir) writes the scaffold to disk and returns the list
 * of relative file paths that were written.  The AI only needs to
 * customise the files it actually changes (patch mode).
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'

// ── boilerplate files ──────────────────────────────────────────────────────

const FILES = {
  'package.json': JSON.stringify({
    name: 'app',
    version: '0.1.0',
    private: true,
    scripts: {
      start: 'next dev -p ${PORT:-3000}',
      build: 'next build',
    },
    dependencies: {
      next: '14.2.5',
      react: '^18',
      'react-dom': '^18',
    },
    devDependencies: {
      tailwindcss: '^3',
      autoprefixer: '^10',
      postcss: '^8',
    },
  }, null, 2),

  'next.config.mjs': `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
}
export default nextConfig
`,

  'tailwind.config.js': `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './components/**/*.{js,jsx,ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
`,

  'postcss.config.js': `module.exports = {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}
`,

  'app/globals.css': `@tailwind base;
@tailwind components;
@tailwind utilities;
`,

  'app/layout.jsx': `import './globals.css'

export const metadata = { title: 'App', description: 'Powered by vps-bot' }

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 min-h-screen">{children}</body>
    </html>
  )
}
`,

  'app/page.jsx': `export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold mb-4">Hello from vps-bot</h1>
      <p className="text-gray-500">Edit app/page.jsx to get started.</p>
    </main>
  )
}
`,

  'app/api/health/route.js': `export async function GET() {
  return Response.json({ status: 'ok' })
}
`,
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Write the Next.js boilerplate into `dir`.
 * Returns the list of relative file paths written.
 */
export function copyNextTemplate(dir) {
  const written = []
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    written.push(rel)
  }
  return written
}

// ── prompt helpers ─────────────────────────────────────────────────────────

/** Files the AI should never re-output (infrastructure handled separately). */
export const NEXT_SKIP_OUTPUT = new Set([
  'Dockerfile', 'docker-compose.yml', 'builder-server.js',
  '.dockerignore', '.gitignore', '.build-prompt.txt', '.build-system-prompt.txt', '.build-config.json',
])

/**
 * Build the AI prompt for customising the Next.js template.
 * `boilerplateFiles` is the array returned by copyNextTemplate().
 */
export function buildNextPrompt(name, description, boilerplateFiles, errorContext = null) {
  const fileList = boilerplateFiles.map(f => `  - ${f}`).join('\n')

  let prompt =
    `You are customising a Next.js 14 + React 18 + Tailwind CSS boilerplate for the following request.\n\n` +
    `App name: ${name}\n` +
    `User request: ${description}\n\n` +
    `BOILERPLATE FILES ALREADY ON DISK (DO NOT reproduce unchanged):\n${fileList}\n\n` +
    `TECH STACK RULES:\n` +
    `• Next.js 14 App Router (app/ directory). No pages/ directory.\n` +
    `• All UI components use Tailwind CSS only — no external component libraries unless the user explicitly asks.\n` +
    `• Add "use client" only for components that need browser APIs or event handlers.\n` +
    `• Keep app/api/health/route.js returning { status: "ok" } — do not delete or break it.\n` +
    `• package.json scripts.start must stay as "next dev -p \${PORT:-3000}".\n` +
    `• ALWAYS output package.json (update the name field to "${name}").\n` +
    `• Do NOT output: ${[...NEXT_SKIP_OUTPUT].join(', ')}\n\n` +
    `OUTPUT RULES:\n` +
    `• Output ONLY the files that differ from the boilerplate for this specific request.\n` +
    `• Create new components inside app/ or components/ as needed.\n` +
    `• Use modern, visually appealing design with Tailwind utility classes.\n` +
    `• ASCII only in JS/JSX. No explanations outside code blocks.`

  if (errorContext) {
    prompt += `\n\n⚠️ STARTUP ERROR TO FIX:\n${errorContext.slice(0, 1200)}`
  }

  return prompt
}
