import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const listing = execFileSync('pnpm', ['pack', '--dry-run'], { cwd: root, encoding: 'utf8' })
const lines = listing.trim().split(/\r?\n/u)
const contents = lines.indexOf('Tarball Contents')
const details = lines.indexOf('Tarball Details')
assert.ok(contents >= 0 && details > contents, 'Expected a pnpm pack file listing')

const sourceRoot = path.join(root, 'src')
const expected = ['package.json', 'README.md', 'LICENSE']
for (const file of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
  if (!file.isFile() || !file.name.endsWith('.ts') || file.name.endsWith('.d.ts')) continue
  const relative = path.relative(sourceRoot, path.join(file.parentPath, file.name))
  const stem = relative.slice(0, -3).split(path.sep).join('/')
  expected.push(`dist/${stem}.js`, `dist/${stem}.d.ts`)
}

assert.deepEqual(lines.slice(contents + 1, details).sort(), expected.sort(), 'Package contents')
const cli = readFileSync(path.join(root, 'dist/cli.js'), 'utf8')
assert.equal(cli.split(/\r?\n/u, 1)[0], '#!/usr/bin/env node', 'Package CLI shebang')
console.log(`Pack verified: ${expected.length} files and CLI shebang`)
