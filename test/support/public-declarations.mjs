import assert from 'node:assert/strict'
import path from 'node:path'

import ts from 'typescript'

const printer = ts.createPrinter({ removeComments: true })

function publicDeclaration(node) {
  return node.parent && ts.isSourceFile(node.parent)
    ? node
    : ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent)
      ? node.parent.parent
      : undefined
}

function referencedProperty(checker, node) {
  if (!ts.isLiteralTypeNode(node.indexType) || !ts.isStringLiteral(node.indexType.literal)) return
  const object = checker.getTypeFromTypeNode(node.objectType)
  const property = checker.getPropertyOfType(object, node.indexType.literal.text)
  const declarations = property?.getDeclarations()
  if (declarations?.length === 1 && ts.isPropertySignature(declarations[0])) return declarations[0]
}

function literalUnion(checker, node, factory) {
  const type = checker.getTypeFromTypeNode(node)
  if (!type.isUnion() || !type.types.every((item) => item.isStringLiteral())) return
  return factory.createUnionTypeNode(
    type.types
      .map((item) => item.value)
      .sort()
      .map((value) => factory.createLiteralTypeNode(factory.createStringLiteral(value))),
  )
}

// Compare resolved declarations, including the private types visible in public signatures.
// Relative module paths, quote spelling and equivalent indexed types can change when a declaration moves.
export function publicDeclarations(directory, entries) {
  const files = entries.map((file) => path.resolve(directory, file + '.d.ts'))
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    types: ['node'],
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n',
    }),
  )
  const checker = program.getTypeChecker()

  return Object.fromEntries(
    files.map((file, index) => {
      const source = program.getSourceFile(file)
      const module = checker.getSymbolAtLocation(source)
      const exports = checker.getExportsOfModule(module)
      const declarations = new Map()
      const externalImports = new Map()
      const visited = new Set()

      function visitDeclaration(symbol) {
        if (!symbol) return
        if (symbol.flags & ts.SymbolFlags.Alias) {
          const alias = symbol.getDeclarations()?.[0]
          if (alias && ts.isImportSpecifier(alias)) {
            const specifier = alias.parent.parent.parent.moduleSpecifier.text
            if (!specifier.startsWith('.'))
              externalImports.set(symbol.name, [
                specifier,
                alias.propertyName?.text ?? alias.name.text,
              ])
          }
          symbol = checker.getAliasedSymbol(symbol)
        }
        if (visited.has(symbol)) return
        visited.add(symbol)
        for (const declaration of symbol.getDeclarations() ?? []) {
          const source = declaration.getSourceFile()
          if (!source.fileName.startsWith(path.dirname(file) + path.sep)) continue
          const statement = publicDeclaration(declaration)
          if (!statement) continue
          const text = declarationText(statement, source)
          const parts = declarations.get(symbol.name) ?? []
          parts.push(text)
          declarations.set(symbol.name, parts)
        }
      }

      function declarationText(statement, source) {
        const result = ts.transform(statement, [
          (context) => {
            const { factory } = context
            function visit(node) {
              if (ts.isIndexedAccessTypeNode(node)) {
                const property = referencedProperty(checker, node)
                if (
                  property?.type &&
                  property.getSourceFile().fileName.startsWith(path.dirname(file) + path.sep)
                ) {
                  const type = visit(property.type)
                  return property.questionToken
                    ? factory.createUnionTypeNode([
                        type,
                        factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
                      ])
                    : type
                }
                const literals = literalUnion(checker, node, factory)
                if (literals) return literals
              }
              if (ts.isImportTypeNode(node) && node.qualifier && !node.isTypeOf) {
                visitDeclaration(checker.getSymbolAtLocation(node.qualifier))
                return factory.createTypeReferenceNode(
                  node.qualifier,
                  ts.visitNodes(node.typeArguments, visit),
                )
              }
              if (ts.isTypeReferenceNode(node))
                visitDeclaration(checker.getSymbolAtLocation(node.typeName))
              if (ts.isExpressionWithTypeArguments(node))
                visitDeclaration(checker.getSymbolAtLocation(node.expression))
              if (ts.isStringLiteral(node)) return factory.createStringLiteral(node.text)
              return ts.visitEachChild(node, visit, context)
            }
            return (node) => ts.visitNode(node, visit)
          },
        ])
        try {
          return printer.printNode(ts.EmitHint.Unspecified, result.transformed[0], source)
        } finally {
          result.dispose()
        }
      }

      for (const symbol of exports) visitDeclaration(symbol)
      return [
        entries[index],
        {
          exports: exports.map((symbol) => symbol.name).sort(),
          externalImports: Object.fromEntries(
            [...externalImports].sort(([a], [b]) => a.localeCompare(b)),
          ),
          declarations: Object.fromEntries(
            [...declarations].sort(([a], [b]) => a.localeCompare(b)),
          ),
        },
      ]
    }),
  )
}
