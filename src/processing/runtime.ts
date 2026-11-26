import PQueue from 'p-queue'
import sharp from 'sharp'

const threadPoolSize = Number(process.env.UV_THREADPOOL_SIZE)
const availableJobs =
  Number.isSafeInteger(threadPoolSize) && threadPoolSize > 0 ? threadPoolSize : 4

export function imageJobLimit(requested: number): number {
  return Math.min(requested, availableJobs)
}

export function createImageJobScheduler(
  requested: number,
): <T>(task: () => Promise<T>) => Promise<Awaited<T>> {
  const queue = new PQueue({ concurrency: imageJobLimit(requested) })
  return <T>(task: () => Promise<T>) => queue.add(task)
}

export function configureImageRuntime(options: {
  concurrency?: number
  cache?: Parameters<typeof sharp.cache>[0]
}): void {
  if (options.concurrency !== undefined) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
      throw new TypeError('Image runtime concurrency must be a positive integer')
    sharp.concurrency(options.concurrency)
  }
  if (options.cache !== undefined) sharp.cache(options.cache)
}
