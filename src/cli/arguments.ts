import { parseArgs } from 'node:util'

import { ImagePipelineError } from '../shared/errors.ts'

const switches = {
  config: { type: 'string' },
  baseline: { type: 'boolean' },
  watch: { type: 'boolean' },
  apply: { type: 'boolean' },
  env: { type: 'string' },
  staged: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} satisfies NonNullable<Parameters<typeof parseArgs>[0]>['options']

type Flag = Exclude<keyof typeof switches, 'help'>
type Flags = {
  [Name in Flag]?: (typeof switches)[Name]['type'] extends 'string' ? string : boolean
}

interface CommandRule {
  prefix: readonly string[]
  positionals: number
  required: readonly Flag[]
  optional: readonly Flag[]
  exclusive?: readonly Flag[]
  missingRequiredMessage?: string
}

const commands = {
  source: {
    prefix: ['source'],
    positionals: 2,
    required: ['config'],
    optional: ['baseline', 'watch'],
    exclusive: ['baseline', 'watch'],
    missingRequiredMessage: 'Specify --config with publicRoots. Use [] when there are none.',
  },
  merge: { prefix: ['record', 'merge'], positionals: 3, required: [], optional: [] },
  output: { prefix: ['output'], positionals: 2, required: ['config'], optional: [] },
  check: { prefix: ['store', 'check'], positionals: 2, required: ['staged'], optional: ['config'] },
  prune: { prefix: ['store', 'prune'], positionals: 2, required: ['config'], optional: ['apply'] },
  refresh: {
    prefix: ['store', 'refresh'],
    positionals: 3,
    required: ['config'],
    optional: ['env'],
  },
} satisfies Record<string, CommandRule>

const helpRule = {
  flag: 'help' as const,
  prefixes: Object.values(commands).map(({ prefix }) => prefix),
}

function invalidCommand(message = 'Invalid command. See --help.', cause?: unknown) {
  return new ImagePipelineError('INVALID_COMMAND', message, { cause })
}

function parseArguments(args: readonly string[]) {
  try {
    return parseArgs({ args: [...args], allowPositionals: true, options: switches, tokens: true })
  } catch (cause) {
    if (cause instanceof TypeError) throw invalidCommand(cause.message, cause)
    throw cause
  }
}

function validateFlags(rule: CommandRule, values: Flags, supplied: readonly string[]) {
  const allowed = new Set<string>([...rule.required, ...rule.optional])
  if (supplied.some((flag) => !allowed.has(flag)) || new Set(supplied).size !== supplied.length)
    throw invalidCommand()
  if (rule.exclusive && rule.exclusive.filter((flag) => values[flag]).length > 1)
    throw invalidCommand()
  if (rule.required.some((flag) => !values[flag])) throw invalidCommand(rule.missingRequiredMessage)
}

type ResolvedCommand =
  | { kind: 'help' }
  | { kind: 'merge'; file: string }
  | { kind: 'output'; target: string; config: string }
  | { kind: 'check'; config?: string }
  | { kind: 'prune'; config: string; apply?: boolean }
  | { kind: 'refresh'; config: string; key: string; environment?: string }
  | { kind: 'source'; target: string; config: string; baseline?: boolean; watch?: boolean }

function resolveHelp(
  positionals: readonly string[],
  tokens: ReturnType<typeof parseArguments>['tokens'],
): ResolvedCommand {
  const prefix = helpRule.prefixes.some(
    (parts) =>
      parts.length >= positionals.length &&
      positionals.every((part, index) => part === parts[index]),
  )
  if (!prefix || tokens.length !== positionals.length + 1) throw invalidCommand()
  return { kind: 'help' }
}

export function resolveCommand(args: readonly string[]): ResolvedCommand {
  const { positionals, values, tokens } = parseArguments(args)
  if (values[helpRule.flag]) return resolveHelp(positionals, tokens)
  if (tokens.some((token) => token.kind === 'option' && token.value === '')) throw invalidCommand()
  const match = (Object.keys(commands) as (keyof typeof commands)[]).find((kind) => {
    const { prefix, positionals: count } = commands[kind]
    return (
      count === positionals.length && prefix.every((part, index) => part === positionals[index])
    )
  })
  if (!match) throw invalidCommand()
  const supplied = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
  validateFlags(commands[match], values, supplied)
  const [, target, operand] = positionals
  const { config } = values
  switch (match) {
    case 'check':
      return { kind: match, config }
    case 'merge':
      if (operand) return { kind: match, file: operand }
      break
    case 'output':
      if (target && config) return { kind: match, target, config }
      break
    case 'source':
      if (target && config)
        return { kind: match, target, config, watch: values.watch, baseline: values.baseline }
      break
    case 'prune':
      if (config) return { kind: match, config, apply: values.apply }
      break
    case 'refresh':
      if (operand && config) return { kind: match, config, key: operand, environment: values.env }
      break
  }
  throw invalidCommand()
}
