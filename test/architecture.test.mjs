import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceRoot = path.join(root, 'src')
const publicEntries = new Set(['index.ts', 'config.ts', 'build.ts', 'watch.ts'])
const cliEntry = 'cli.ts'
const entries = [...publicEntries, cliEntry]
const packageName = '@spiracss/image-pipeline'
const selfImports = new Map([
  [packageName, 'index.ts'],
  [packageName + '/config', 'config.ts'],
  [packageName + '/adapter/v1', 'build.ts'],
  [packageName + '/watch', 'watch.ts'],
])
const layerOrder = [
  ['shared'],
  ['config'],
  ['processing'],
  ['store', 'references'],
  ['publication'],
  ['build'],
  ['source', 'output'],
  ['cli'],
  ['entry'],
]

function layerOf(file) {
  if (entries.includes(file)) return 'entry'
  return file.includes('/') ? file.split('/')[0] : undefined
}

function isImportMetaResolve(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'resolve' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  )
}

function moduleReferences(source) {
  const references = []
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) references.push(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      references.push(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      references.push(node.argument.literal)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isImportMetaResolve(node.expression) ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      references.push(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return references.map((reference) => {
    assert.ok(
      reference && ts.isStringLiteralLike(reference),
      `Non-literal import in ${source.fileName}`,
    )
    return reference.text
  })
}

function reachable(graph, starts) {
  const seen = new Set()
  const pending = [...starts]
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    pending.push(...graph.get(file))
  }
  return seen
}

function dependencyGraph(sources, options) {
  const graph = new Map()
  for (const [file, source] of sources) {
    const dependencies = new Set()
    for (const specifier of moduleReferences(source)) {
      if (specifier.startsWith(packageName)) {
        const selfImport = selfImports.get(specifier)
        assert.ok(selfImport, `Undeclared package import: ${file} -> ${specifier}`)
        dependencies.add(selfImport)
        continue
      }
      const target = ts.resolveModuleName(specifier, source.fileName, options, ts.sys)
        .resolvedModule?.resolvedFileName
      const relative = target && path.relative(sourceRoot, target).split(path.sep).join('/')
      if (relative && sources.has(relative)) dependencies.add(relative)
      else
        assert.ok(
          !specifier.startsWith('.'),
          `Import outside src or unresolved: ${file} -> ${specifier}`,
        )
    }
    graph.set(file, dependencies)
  }
  return graph
}

function verifyArchitecture(overlays = {}) {
  const configPath = path.join(root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const settings = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  assert.deepEqual(settings.errors, [])

  const sources = new Map()
  for (const entry of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const file = path.join(entry.parentPath, entry.name)
    const logicalPath = path.relative(sourceRoot, file).split(path.sep).join('/')
    const text = readFileSync(file, 'utf8') + (overlays[logicalPath] ?? '')
    sources.set(logicalPath, ts.createSourceFile(file, text, settings.options.target, true))
  }
  for (const entry of entries) assert.ok(sources.has(entry), `Missing source entry ${entry}`)

  const graph = dependencyGraph(sources, settings.options)
  const violations = []
  for (const file of reachable(graph, ['index.ts'])) {
    if (file.startsWith('cli/') || file === 'source/watch.ts')
      violations.push(`root loads CLI or file watching: ${file}`)
  }
  for (const entry of publicEntries) {
    if (
      sources
        .get(entry)
        .statements.some((node) => !ts.isExportDeclaration(node) || !node.moduleSpecifier)
    ) {
      violations.push(`entry contains implementation: ${entry}`)
    }
  }
  const fromEntries = reachable(graph, entries)
  const fromFile = new Map(
    [...graph.keys()].map((file) => [file, reachable(graph, graph.get(file))]),
  )
  for (const [from, dependencies] of graph) {
    if (!fromEntries.has(from)) violations.push(`unreachable: ${from}`)
    const layer = layerOf(from)
    const rank = layerOrder.findIndex((group) => group.includes(layer))
    assert.ok(rank >= 0, `No architecture layer for ${from}`)
    for (const to of dependencies) {
      const edge = `${from} -> ${to}`
      const targetLayer = layerOf(to)
      if (fromFile.get(to).has(from)) violations.push(`cycle: ${edge}`)
      if (entries.includes(to)) {
        violations.push(`imports entry: ${edge}`)
      } else if (from === cliEntry && targetLayer !== 'cli') {
        violations.push(`bin bypasses cli layer: ${edge}`)
      } else if (
        layerOrder.findIndex((group) => group.includes(targetLayer)) > rank ||
        (layer !== targetLayer &&
          ['store', 'references'].includes(layer) &&
          ['store', 'references'].includes(targetLayer))
      ) {
        violations.push(`layer: ${edge}`)
      }
    }
  }
  assert.deepEqual(violations.sort(), [])
}

test('source imports and re-exports obey the architecture, including type-only dependencies', () => {
  verifyArchitecture()
})

test('architecture rejects hidden module references and undeclared package specifiers', () => {
  for (const [specifier, expected] of [
    ['../build/image-build.ts', /layer: shared\/paths\.ts -> build\/image-build\.ts/u],
    ['@spiracss/image-pipeline/dist/output.js', /Undeclared package import/u],
    ['@spiracss/image-pipeline-private', /Undeclared package import/u],
  ]) {
    assert.throws(
      () =>
        verifyArchitecture({
          'shared/paths.ts': `\nimport.meta.resolve(${JSON.stringify(specifier)})\n`,
        }),
      expected,
    )
  }
})
