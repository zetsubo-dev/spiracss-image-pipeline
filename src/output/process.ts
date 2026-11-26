import fs from 'node:fs/promises'
import path from 'node:path'

import { acquireFileLock } from '../shared/file-lock.ts'
import { commitOutput } from './commit.ts'
import { discoverOutput, outputLockName, type ProcessOutputOptions } from './discover.ts'
import { planOutput, verifyOutputPlan } from './plan.ts'

export async function processOutput(options: ProcessOutputOptions): Promise<{
  missing: string[]
  processed: string[]
  retained: {
    file: string
    reason: string
  }[]
}> {
  const missing: string[] = []
  const processed: string[] = []
  const retained: { file: string; reason: string }[] = []
  const results = { missing, processed, retained }
  if (!Array.isArray(options.publicCopies)) missing.push('publicCopies')
  if (!Array.isArray(options.editableDocuments)) missing.push('editableDocuments')
  if (options.config?.build?.ignoreSrcConversion?.length && !options.inventory)
    missing.push('inventory.generatedImages')
  if (missing.length) return results

  const projectRoot = await fs.realpath(options.projectRoot)
  const outputRoot = await fs.realpath(path.resolve(projectRoot, options.outputDir))
  const release = await acquireFileLock(path.join(outputRoot, outputLockName), {
    onWarning: options.onWarning,
  })
  try {
    const discovered = await discoverOutput(options, projectRoot, outputRoot, retained)
    const plan = planOutput(options, projectRoot, outputRoot, discovered, retained)
    try {
      const verified = await verifyOutputPlan(plan)
      await commitOutput(verified, outputRoot, processed)
      return results
    } finally {
      await plan.finish()
    }
  } finally {
    await release()
  }
}
