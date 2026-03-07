import { Redis } from 'ioredis'
import { env } from './env'
import { logger } from './logger'

let redisClient: Redis | null = null

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck:     false,
    })

    redisClient.on('connect',  () => logger.info('✅  Redis connected'))
    redisClient.on('error',    (err) => logger.error({ err }, 'Redis error'))
    redisClient.on('close',    () => logger.warn('Redis connection closed'))
  }
  return redisClient
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit()
    redisClient = null
    logger.info('Redis disconnected gracefully')
  }
}
