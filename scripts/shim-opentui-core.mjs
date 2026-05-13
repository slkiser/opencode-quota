// Workaround for @opentui/core@0.2.x publishing *.d.ts without matching *.js
// siblings. When OpenCode's Bun-based TUI host loads `dist/tui.tsx`, it walks
// the type-import graph through `@opentui/core/index.d.ts` (which contains
// `export * from "./types.js"` and similar) and aborts with ENOENT on the
// missing runtime files. Bundled runtime symbols are re-exported from
// `index.js`, so empty stubs are sufficient to unblock resolution.
//
// Tracking: https://github.com/slkiser/opencode-quota/issues/87
//
// This script is safe to run repeatedly: it only writes `.js` files that do
// not already exist next to a `.d.ts`.

import { readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SHIM_BANNER = '// Auto-generated stub for missing .js sibling of .d.ts in @opentui/core.\n' +
  '// See scripts/shim-opentui-core.mjs in @slkiser/opencode-quota.\n' +
  'export {};\n'

async function findOpentuiCoreDirs(startDir) {
  const results = []
  let current = path.resolve(startDir)
  // Walk up looking for any node_modules/@opentui/core that contains this package.
  // The plugin is typically installed under <opencode cache>/node_modules/@slkiser/opencode-quota,
  // with @opentui/core as a sibling under the same node_modules root.
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, 'node_modules', '@opentui', 'core')
    if (existsSync(candidate)) results.push(candidate)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return results
}

async function shimDir(coreDir) {
  let created = 0
  const entries = await readdir(coreDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.d.ts')) continue
    if (entry.name.endsWith('.d.ts.map')) continue
    const base = entry.name.slice(0, -'.d.ts'.length)
    const jsPath = path.join(coreDir, `${base}.js`)
    const tsxPath = path.join(coreDir, `${base}.tsx`)
    const dirPath = path.join(coreDir, base)
    if (existsSync(jsPath) || existsSync(tsxPath)) continue
    try {
      const st = await stat(dirPath)
      if (st.isDirectory()) continue
    } catch {
      // not a directory, proceed
    }
    await writeFile(jsPath, SHIM_BANNER, 'utf-8')
    created++
  }
  return created
}

async function main() {
  // Two entry points: when run from this repo's `scripts/` during `npm run build`,
  // and when run as a postinstall hook from the installed package.
  // INIT_CWD is set by npm to the directory where install was invoked.
  const searchRoots = new Set()
  if (process.env.INIT_CWD) searchRoots.add(process.env.INIT_CWD)
  searchRoots.add(path.resolve(__dirname, '..'))
  searchRoots.add(process.cwd())

  const visited = new Set()
  let totalCreated = 0
  let dirsTouched = 0
  for (const root of searchRoots) {
    for (const coreDir of await findOpentuiCoreDirs(root)) {
      if (visited.has(coreDir)) continue
      visited.add(coreDir)
      try {
        const created = await shimDir(coreDir)
        if (created > 0) {
          dirsTouched++
          totalCreated += created
        }
      } catch {
        // best-effort; never fail install if shimming cannot run
      }
    }
  }

  if (totalCreated > 0) {
    console.log(
      `[opencode-quota] Added ${totalCreated} runtime stub(s) for @opentui/core .d.ts files in ${dirsTouched} location(s).`,
    )
  }
}

main().catch(() => {
  // Never fail install on shim errors.
  process.exit(0)
})
