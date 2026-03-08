import { Types } from 'mongoose'
import { BetTrack } from '../models/BetTrack'
import { BetSession } from '../models/BetSession'
import { logger } from '../config/logger'
import { calculateAllocation } from './allocationEngine'
import { runCurationEngine } from './curationEngine'
import { recalibrate } from './recalibrationEngine'
import { TrackStatus, SessionStatus } from '../types'
import { getQueue } from '../workers/queues'
import { BetSlip } from '../models/BetSlip'

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
    // ── Step 1: Allocate ───────────────────────────────────────────────────────
    const allocation = calculateAllocation(track)
    logger.info({ trackId, amount: allocation.amount, pct: (allocation.percentage * 100).toFixed(1) + '%' }, 'Allocation calculated')

    // ── Step 2: Create session ─────────────────────────────────────────────────
    const session = await BetSession.create({
      trackId:             track._id,
      userId:              track.userId,
      sessionNumber:       track.sessionCount + 1,
      allocation:          allocation.amount,
      temperamentSnapshot: track.currentTemperament,
    })

    logger.info({ sessionId: session._id, sessionNumber: session.sessionNumber }, 'Session created')

    // ── Step 3: Run curation ───────────────────────────────────────────────────
    await runCurationEngine(track, session, allocation.amount, track.verdictModel as 'gemini' | 'gpt-4o')

    // ── Step 4: Find latest settlement time across all slips ───────────────────
    const allSlips = await BetSlip.find({ sessionId: session._id })

    if (allSlips.length === 0) {
      logger.warn({ sessionId: session._id }, 'No slips curated — no fixtures available. Will retry in 1 hour.')
      // Schedule a retry — no fixtures available right now
      const queue = getQueue('settlement')
      await queue.add('settle-session', { sessionId: session._id.toString() }, {
        delay:    60 * 60 * 1000,
        attempts: 3,
      })
      return
    }

    const latestSettlementTime = allSlips.reduce((latest, slip) =>
      slip.lastSettlementTime > latest ? slip.lastSettlementTime : latest,
      new Date(0)
    )

    // ── Step 5: Arm settlement timer ──────────────────────────────────────────
    const delay = Math.max(latestSettlementTime.getTime() - Date.now(), 0)
    const queue  = getQueue('settlement')

    const job = await queue.add(
      'settle-session',
      { sessionId: session._id.toString() },
      { delay, attempts: 3, backoff: { type: 'fixed', delay: 5 * 60 * 1000 } }
    )

    session.settlementJobId = job.id!
    await session.save()

    // ── Step 6: Update track ───────────────────────────────────────────────────
    track.remainingBudget -= allocation.amount
    track.sessionCount    += 1
    await track.save()

    logger.info(
      { sessionId: session._id, settlementAt: latestSettlementTime, delay: `${Math.round(delay / 60000)}min` },
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
