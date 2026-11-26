import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'

import { file, makePng, request, temporaryProject } from '../support/project.mjs'

async function setup(t) {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const create = () => createImageBuild({ projectRoot, skipProcessing: true })
  const build = create()
  await build.registerFixedCopies([])
  const prepared = await build.prepareUse(request())
  const placement = { owner: 'source', generated: true, destination: file, url: '/' + file }
  return { build, create, prepared, placement }
}

test('publish returns a resolved image synchronously and rejects the wrong extension', async (t) => {
  const { build, prepared, placement } = await setup(t)
  assert.equal((await build.publish(prepared, placement)).destination, file)
  await assert.rejects(
    Promise.resolve().then(() =>
      build.publish(prepared, { ...placement, destination: 'out/a.webp' }),
    ),
    /Publication format does not match its destination/u,
  )
  const image = build.publish(prepared, placement)
  assert.equal(image.destination, file)
  assert.equal('then' in image, false)
  assert.equal('recordOutput' in build, false)
  assert.equal('recordUse' in build, false)
})

test('a prepared WebP cannot be published with a PNG extension', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const build = createImageBuild({
    projectRoot,
    config: { build: { outputFormat: 'webp' }, formats: { webp: { minSize: false } } },
  })
  await build.registerFixedCopies([])
  const prepared = await build.prepareUse(request())
  assert.equal(prepared.format, 'webp')
  await assert.rejects(
    Promise.resolve().then(() =>
      build.publish(prepared, {
        owner: file,
        generated: true,
        destination: 'out/a.png',
        url: '/out/a.png',
      }),
    ),
    /Publication format does not match its destination/u,
  )
  assert.deepEqual(build.getPublications(), [])
})

test('publish refuses another build’s preparation and an otherwise identical copy', async (t) => {
  const { build, create, prepared, placement } = await setup(t)
  const foreign = await create().prepareUse(request())
  for (const value of [foreign, { ...prepared }]) {
    await assert.rejects(
      Promise.resolve().then(() => build.publish(value, placement)),
      /Prepared image was not issued by this build/u,
    )
  }
  assert.deepEqual(build.getPublications(), [])
})

test('fixed-to-generated replacement reports the fixed-copy remedy', async (t) => {
  const { build, prepared, placement } = await setup(t)
  await build.publish(prepared, { ...placement, generated: false })
  await assert.rejects(
    Promise.resolve().then(() => build.publish(prepared, placement)),
    /Rename the fixed public asset or change the generated image directory/u,
  )
})
