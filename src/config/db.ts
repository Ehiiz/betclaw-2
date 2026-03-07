import mongoose from 'mongoose'
import { env } from './env'
import { logger } from './logger'

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(env.MONGODB_URI)
    logger.info('✅  MongoDB connected')
  } catch (err) {
    logger.error({ err }, '❌  MongoDB connection failed')
    process.exit(1)
  }

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — attempting reconnect...')
  })

  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected')
  })
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect()
  logger.info('MongoDB disconnected gracefully')
}
