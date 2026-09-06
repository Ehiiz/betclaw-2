import { BetTrack } from '../models/BetTrack'
import { BetSession, IBetSession } from '../models/BetSession'
import { logger } from '../config/logger'
import { calculateAllocation } from './allocationEngine'
import { runCurationEngine } from './curationEngine'
import { recalibrate } from './recalibrationEngine'
import { TrackStatus, SessionStatus } from '../types'
import { getQueue } from '../workers/queues'
import { BetSlip } from '../models/BetSlip'

const EMPTY_SESSION_RETRY_DELAY_MS = 60 * 60 * 1000

/**
 * Entry point for the autonomous loop.
 * Called on track creation and after each recalibration.
 */
export async function startTrackLoop(trackId: string): Promise<void> {
  const track = await BetTrack.findById(trackId)
  if (!track) {
    logger.warn({ trackId }, 'Track loop: track not found')
    return
  }

  if (track.status !== TrackStatus.ACTIVE) {
    logger.info({ trackId, status: track.status }, 'Track loop: track not active — halting')
    return
  }

  logger.info({ trackId, temperament: track.currentTemperament }, 'Track loop: starting new session cycle')

  try {
    const existingSession = await BetSession.findOne({
      trackId: track._id,
      status: { $in: [SessionStatus.ACTIVE, SessionStatus.SETTLING, SessionStatus.PULSING] },
    }).sort({ createdAt: -1 })

    const existingSessionSlipCount = existingSession
      ? await BetSlip.countDocuments({ sessionId: existingSession._id })
      : 0

    if (existingSession && existingSessionSlipCount > 0) {
      logger.info(
        { sessionId: existingSession._id, status: existingSession.status, slipCount: existingSessionSlipCount },
        'Track loop: unresolved live session already exists'
      )
      await armSettlement(existingSession)
      return
    }

    const session = existingSession && existingSessionSlipCount === 0 ? existingSession : null

    // ── Step 1: Allocate ───────────────────────────────────────────────────────
    const allocation = session
      ? { amount: session.allocation, percentage: session.allocation / Math.max(track.remainingBudget, 1), urgencyMultiplier: 1 }
      : calculateAllocation(track)
    logger.info({ trackId, amount: allocation.amount, pct: (allocation.percentage * 100).toFixed(1) + '%' }, 'Allocation calculated')

    // ── Step 2: Create session ─────────────────────────────────────────────────
    const activeSession = session ?? await BetSession.create({
      trackId:             track._id,
      userId:              track.userId,
      sessionNumber:       track.sessionCount + 1,
      allocation:          allocation.amount,
      temperamentSnapshot: track.currentTemperament,
    })

    if (activeSession.retryJobId) {
      activeSession.retryJobId = undefined
      await activeSession.save()
    }

    logger.info(
      { sessionId: activeSession._id, sessionNumber: activeSession.sessionNumber, reused: !!session },
      session ? 'Session reused for retry' : 'Session created'
    )

    // ── Step 3: Run curation ───────────────────────────────────────────────────
    await runCurationEngine(track, activeSession, allocation.amount, track.verdictModel)

    // ── Step 4: Find latest settlement time across all slips ───────────────────
    const allSlips = await BetSlip.find({ sessionId: activeSession._id })

    if (allSlips.length === 0) {
      logger.warn({ sessionId: activeSession._id }, 'No slips curated — retaining session and retrying in 1 hour')
      await scheduleSessionRetry(activeSession._id.toString())
      return
    }

    const latestSettlementTime = allSlips.reduce((latest, slip) =>
      slip.lastSettlementTime > latest ? slip.lastSettlementTime : latest,
      new Date(0)
    )

    // ── Step 5: Arm settlement timer ──────────────────────────────────────────
    const delay = Math.max(latestSettlementTime.getTime() - Date.now(), 0)
    await armSettlement(activeSession, delay)

    // ── Step 6: Update track ───────────────────────────────────────────────────
    if (track.sessionCount < activeSession.sessionNumber) {
      track.remainingBudget = Math.max(0, track.remainingBudget - allocation.amount)
      track.sessionCount = activeSession.sessionNumber
      await track.save()
    }

    logger.info(
      { sessionId: activeSession._id, settlementAt: latestSettlementTime, delay: `${Math.round(delay / 60000)}min` },
      'Track loop: session live, settlement timer armed'
    )

  } catch (err) {
    logger.error({ err, trackId }, 'Track loop: error during session creation')
    throw err
  }
}

/**
 * Called by the settlement engine after a session fully settles.
 * Runs recalibration, updates the track, and immediately starts the next cycle.
 */
export async function runRecalibration(trackId: string, sessionId: string): Promise<void> {
  const [track, session] = await Promise.all([
    BetTrack.findById(trackId),
    BetSession.findById(sessionId),
  ])

  if (!track || !session) {
    logger.warn({ trackId, sessionId }, 'Recalibration: track or session not found')
    return
  }

  // Update track P&L with session result
  track.totalPnL      += session.pnl
  track.remainingBudget = Math.max(0, track.remainingBudget + session.totalReturn)

  const result = recalibrate(track, session)

  logger.info(
    { trackId, pnlRating: result.pnlRating, newTemperament: result.newTemperament, shouldContinue: result.shouldContinue },
    'Recalibration complete'
  )

  track.currentTemperament = result.newTemperament

  if (!result.shouldContinue && result.closeReason) {
    track.status   = result.closeReason
    track.closedAt = new Date()
    await track.save()

    logger.info({ trackId, closeReason: result.closeReason }, 'Track closed')
    return
  }

  await track.save()

  // Immediately start the next session cycle
  if (result.shouldContinue) {
    setImmediate(() => startTrackLoop(trackId))
  }
}

export async function retryPendingSessionCuration(sessionId: string): Promise<void> {
  const session = await BetSession.findById(sessionId)
  if (!session) {
    logger.warn({ sessionId }, 'Retry curation: session not found')
    return
  }

  if (session.status !== SessionStatus.ACTIVE) {
    logger.info({ sessionId, status: session.status }, 'Retry curation: session no longer active')
    return
  }

  const slipCount = await BetSlip.countDocuments({ sessionId: session._id })
  if (slipCount > 0) {
    logger.info({ sessionId, slipCount }, 'Retry curation: session already has slips')
    return
  }

  await startTrackLoop(session.trackId.toString())
}

async function scheduleSessionRetry(sessionId: string): Promise<void> {
  const session = await BetSession.findById(sessionId)
  if (!session || session.status !== SessionStatus.ACTIVE) {
    return
  }

  const queue = getQueue('settlement')
  const job = await queue.add(
    'retry-curation',
    { sessionId },
    { delay: EMPTY_SESSION_RETRY_DELAY_MS, attempts: 3 }
  )

  session.retryJobId = job.id!
  await session.save()
}

async function armSettlement(session: IBetSession, explicitDelay?: number): Promise<void> {
  const allSlips = await BetSlip.find({ sessionId: session._id })
  if (allSlips.length === 0) {
    return
  }

  const latestSettlementTime = allSlips.reduce((latest, slip) =>
    slip.lastSettlementTime > latest ? slip.lastSettlementTime : latest,
    new Date(0)
  )

  const delay = explicitDelay ?? Math.max(latestSettlementTime.getTime() - Date.now(), 0)
  const queue = getQueue('settlement')
  if (session.settlementJobId) {
    const existingJob = await queue.getJob(session.settlementJobId)
    if (existingJob) {
      return
    }
  }

  const job = await queue.add(
    'settle-session',
    { sessionId: session._id.toString() },
    { delay, attempts: 3, backoff: { type: 'fixed', delay: 5 * 60 * 1000 } }
  )

  session.settlementJobId = job.id!
  await session.save()
}
