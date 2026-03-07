import { Queue } from 'bullmq'
import { env } from '../config/env'

// BullMQ bundles its own ioredis internally.
// Pass connection options (not a Redis instance) to avoid ioredis version conflicts.
export function getConnectionOpts() {
  const url = new URL(env.REDIS_URL)
  return {
    host:     url.hostname,
    port:     parseInt(url.port || '6379', 10),
    password: url.password || undefined,
    maxRetriesPerRequest: null as null,  // required by BullMQ
  }
}

const queues = new Map<string, Queue>()

export function getQueue(name: string): Queue {
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, {
      connection: getConnectionOpts(),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail:     200,
      },
    }))
  }
  return queues.get(name)!
}

export async function closeAllQueues(): Promise<void> {
  for (const queue of queues.values()) {
    await queue.close()
  }
  queues.clear()
}
