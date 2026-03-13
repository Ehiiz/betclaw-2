import { Worker, Job } from 'bullmq'
import { logger } from '../config/logger'
import { settleSession, checkGameResult, tryFinaliseSession } from '../engines/settlementEngine'
import { retryPendingSessionCuration } from '../engines/trackLoop'
import { PulseJob } from '../models/PulseJob'
import { PulseStatus } from '../types'
import { getConnectionOpts } from './queues'

// ─── Settlement Worker ────────────────────────────────────────────────────────

export function createSettlementWorker(): Worker {
  const worker = new Worker(
    'settlement',
    async (job: Job) => {
      const { sessionId } = job.data
      logger.info({ sessionId, jobId: job.id, jobName: job.name }, 'Settlement worker: processing')

      if (job.name === 'retry-curation') {
        await retryPendingSessionCuration(sessionId)
        return
      }

      await settleSession(sessionId)
    },
    {
      connection: getConnectionOpts(),
      concurrency: 5,
    }
  )

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Settlement job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Settlement job failed')
  })

  return worker
}

// ─── Pulse Worker ─────────────────────────────────────────────────────────────

export function createPulseWorker(): Worker {
  const worker = new Worker(
    'pulse',
    async (job: Job) => {
      const { slipGameId, sessionId, attemptNumber } = job.data

      logger.info({ slipGameId, sessionId, attemptNumber, jobId: job.id }, 'Pulse worker: checking result')

      await PulseJob.findOneAndUpdate(
        { bullJobId: job.id, status: PulseStatus.ACTIVE },
        { status: PulseStatus.RESOLVED, resolvedAt: new Date() }
      )

      await checkGameResult(slipGameId, sessionId)
      await tryFinaliseSession(sessionId)
    },
    {
      connection: getConnectionOpts(),
      concurrency: 10,
    }
  )

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Pulse job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Pulse job failed')
  })

  return worker
}

// ─── Worker bootstrap (run as separate process) ───────────────────────────────

export async function startWorkers(): Promise<{ settlement: Worker; pulse: Worker }> {
  const settlement = createSettlementWorker()
  const pulse      = createPulseWorker()

  logger.info('Workers started: settlement, pulse')

  return { settlement, pulse }
}
