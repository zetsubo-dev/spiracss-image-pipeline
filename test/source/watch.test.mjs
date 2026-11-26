import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { acquireFileLock } from '../../dist/shared/file-lock.js'
import { temporaryProject, file, makePng } from '../support/project.mjs'

test('the watcher waits for received changes and the ledger before completing shutdown', async (t) => {
  const { watchSources } = await import('@spiracss/image-pipeline/watch')
  const projectRoot = await temporaryProject(t)
  await fs.mkdir(path.join(projectRoot, 'images'))
  const source = path.join(projectRoot, 'images', file)
  const ledgerFile = path.join(projectRoot, '.source-image-processed.sha256')
  const lock = ledgerFile + '.lock'
  const release = await acquireFileLock(lock)
  t.after(release)
  const waiting = Promise.withResolvers()
  const mkdir = fs.mkdir
  t.mock.method(fs, 'mkdir', async (entry, ...args) => {
    try {
      return await mkdir(entry, ...args)
    } catch (error) {
      if (entry === lock + '.gate' && error.code === 'EEXIST') waiting.resolve()
      throw error
    }
  })
  const observer = watchSources({ projectRoot, roots: ['images'], publicRoots: [] })
  t.after(async () => {
    await release()
    await observer.close()
  })
  await observer.ready
  await makePng(source)
  const accepted = observer.handle('add', source)
  let closed = false
  const closing = observer.close().then(() => {
    closed = true
  })
  await Promise.race([waiting.promise, closing])
  assert.equal(closed, false)
  await assert.rejects(fs.readFile(ledgerFile), { code: 'ENOENT' })
  await release()
  await closing
  await accepted
  const digest = createHash('sha256')
    .update(await fs.readFile(source))
    .digest('hex')
  const ledger = await fs.readFile(ledgerFile, 'utf8')
  assert.ok(ledger.startsWith(digest + ' '))
})
