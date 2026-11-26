import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveCommand } from '../../dist/cli/arguments.js'

const prefixes = [
  [],
  ['source'],
  ['output'],
  ['record'],
  ['record', 'merge'],
  ['store'],
  ['store', 'check'],
  ['store', 'prune'],
  ['store', 'refresh'],
]
const invalid = { name: 'ImagePipelineError', code: 'INVALID_COMMAND' }

test('help accepts only a command prefix and a single help option', () => {
  for (const flag of ['--help', '-h']) {
    for (const prefix of prefixes) {
      assert.deepEqual(resolveCommand([...prefix, flag]), { kind: 'help' })
      assert.deepEqual(resolveCommand([flag, ...prefix]), { kind: 'help' })
      const literal = [...prefix, '--', flag]
      if (prefix.join(' ') === 'record merge')
        assert.deepEqual(resolveCommand(literal), { kind: 'merge', file: flag })
      else assert.throws(() => resolveCommand(literal), invalid, literal.join(' '))
      for (const args of [
        [...prefix, flag, '--staged'],
        [...prefix, flag, flag],
        [...prefix, flag, '--'],
        [flag, '--', ...prefix],
      ])
        assert.throws(() => resolveCommand(args), invalid, args.join(' '))
    }
  }
  for (const args of [
    ['record', 'merge', 'a.json', 'extra', '--staged', '--help'],
    ['unknown', '--help'],
    ['store', 'impossible', '-h'],
    ['source', 'inputs', '--help'],
    ['--unknown', '--help'],
  ])
    assert.throws(() => resolveCommand(args), invalid, args.join(' '))
})

test('empty CLI option values are invalid and -- permits literal option-like operands', () => {
  for (const empty of [['--config='], ['--config', '']]) {
    assert.throws(() => resolveCommand(['store', 'check', '--staged', ...empty]), invalid)
  }
  for (const empty of [['--env='], ['--env', '']]) {
    assert.throws(
      () => resolveCommand(['store', 'refresh', 'key', '--config=file', ...empty]),
      invalid,
    )
  }
  assert.deepEqual(resolveCommand(['record', 'merge', '--', '--help']), {
    kind: 'merge',
    file: '--help',
  })
  assert.deepEqual(resolveCommand(['--config=file', 'source', '--', '--help']), {
    kind: 'source',
    target: '--help',
    config: 'file',
    baseline: undefined,
    watch: undefined,
  })
  assert.deepEqual(resolveCommand(['store', 'check', '--staged', '--']), {
    kind: 'check',
    config: undefined,
  })
  assert.throws(() => resolveCommand(['store', 'check', '--', '--staged']), invalid)
})
