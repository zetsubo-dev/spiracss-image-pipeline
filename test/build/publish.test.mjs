import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'

import { file, makePng, request, temporaryProject } from '../support/project.mjs'

test('publish only returns a registered image', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const build = createImageBuild({ projectRoot, skipProcessing: true })
  await build.registerFixedCopies([{ file, destination: 'fixed.png' }])
  const prepared = await build.prepareUse(request())
  const placement = { owner: 'image', generated: true, destination: 'fixed.png', url: '/fixed.png' }
  assert.throws(() => build.publish(prepared, placement), /Rename the fixed public asset/u)
  assert.deepEqual(build.getPublications(), [])
  const destination = 'edited.png'
  const image = await build.publish(prepared, { ...placement, destination, url: '/edited.png' })
  assert.deepEqual(image.bytes, prepared.bytes)
  assert.equal(image.url, '/edited.png')
  assert.deepEqual(build.getPublishedDestinations(), ['fixed.png', destination])
})

test('fixed copies and resume reject entire batches on a prefix collision', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const options = { projectRoot, skipProcessing: true, caseInsensitiveOutputs: true }
  const build = createImageBuild(options)
  await assert.rejects(
    build.registerFixedCopies([
      { file, destination: 'assets/a.png' },
      { file, destination: 'ASSETS' },
    ]),
    /Image publication collision at ASSETS/u,
  )
  assert.deepEqual(build.getPublishedDestinations(), [])
  await build.registerFixedCopies([{ file, destination: 'assets' }])

  const producer = createImageBuild({ ...options, caseInsensitiveOutputs: false })
  await producer.registerFixedCopies([])
  const prepared = await producer.prepareUse(request())
  const destination = prepared.suggestedDestination
  producer.publish(prepared, {
    owner: 'original',
    generated: true,
    destination,
    url: '/' + destination,
  })
  producer.publish(prepared, {
    owner: 'other',
    generated: true,
    destination: destination.toUpperCase(),
    url: '/' + destination.toUpperCase(),
  })
  await producer.checkpoint('bad.json')
  const consumer = createImageBuild(options)
  await assert.rejects(consumer.resume('bad.json'), /Image publication collision/u)
  assert.deepEqual(consumer.getPublications(), [])
  const replacement = createImageBuild(options)
  await replacement.registerFixedCopies([])
  await replacement.resolveUse({ ...request(), input: { ...request().input, owner: 'new-owner' } })
  await replacement.checkpoint('valid.json')
  await consumer.resume('valid.json')
  assert.deepEqual(consumer.getPublications(), replacement.getPublications())
})
