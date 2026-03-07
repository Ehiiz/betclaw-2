import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import morgan from 'morgan'
import swaggerUi from 'swagger-ui-express'
import { connectDB } from './config/db'
import { logger } from './config/logger'
import { swaggerSpec } from './config/swagger'
import { errorHandler } from './middleware/errorHandler'
import { closeAllQueues } from './workers/queues'
import { closeRedis } from './config/redis'
import { startWorkers } from './workers'

// Routes
import authRouter from './routes/auth'
import tracksRouter from './routes/tracks'
import { sessionsRouter, slipsRouter, pulsesRouter } from './routes/sessions'
import { env } from './config/env'

const app = express()

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(morgan('dev'))

// ─── Swagger Docs ─────────────────────────────────────────────────────────────
// Disable helmet's CSP for the docs route so Swagger UI renders correctly
app.use('/docs', (_req, _res, next) => { next() })
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'BetClaw API Docs',
  customCss: '.swagger-ui .topbar { background-color: #1A1A2E } .swagger-ui .topbar-wrapper .link::after { content: "BetClaw"; color: #E94560; font-weight: bold; font-size: 1.2em; margin-left: 8px; }',
  swaggerOptions: { persistAuthorization: true },
}))

// Raw spec endpoint — useful for importing into Postman/Insomnia
app.get('/docs.json', (_req, res) => res.json(swaggerSpec))

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/v1/auth', authRouter)
app.use('/v1/tracks', tracksRouter)
app.use('/v1', sessionsRouter)
app.use('/v1', slipsRouter)
app.use('/v1', pulsesRouter)

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Error handler (must be last) ─────────────────────────────────────────────
app.use(errorHandler)

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  await connectDB()
  await startWorkers()

  const server = app.listen(Number(env.PORT), () => {
    logger.info(`🚀  BetClaw API running on port ${env.PORT} [${env.NODE_ENV}]`)
    logger.info(`📖  Swagger docs: http://localhost:${env.PORT}/docs`)
  })

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`)
    server.close(async () => {
      await closeAllQueues()
      await closeRedis()
      const { disconnectDB } = await import('./config/db')
      await disconnectDB()
      logger.info('Shutdown complete')
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Fatal error during bootstrap')
  process.exit(1)
})

export default app
