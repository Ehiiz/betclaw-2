import { Types } from 'mongoose'
import { BetSession } from '../models/BetSession'
import { BetSlip } from '../models/BetSlip'
import { SlipGame } from '../models/SlipGame'
import { PulseJob } from '../models/PulseJob'
import { BetTrack } from '../models/BetTrack'
import { logger } from '../config/logger'
import { fetchFixtureResult, evaluatePrediction } from '../services/sportsApi'
import { SessionStatus, SlipStatus, GameResult, PulseStatus } from '../types'
import { getQueue } from '../workers/queues'

const PULSE_DELAY_ATTEMPT_1 = 30 * 60 * 1000   // 30 minutes
const PULSE_DELAY_SUBSEQUENT = 60 * 60 * 1000  // 1 hour

/**
 * Called by the settlement BullMQ worker.
 * Checks all pending SlipGames in the session for results.
 */
export async function settleSession(sessionId: string): Promise<void> {
  const session = await BetSession.findById(sessionId)
  if (!session) {
    logger.warn({ sessionId }, 'Settlement: session not found')
    return
  }

  if (session.status === SessionStatus.SETTLED || session.status === SessionStatus.CANCELLED) {
    logger.info({ sessionId }, 'Settlement: session already resolved — skipping')
    return
  }

  session.status               = SessionStatus.SETTLING
  session.lastSettlementAttempt = new Date()
  await session.save()

  logger.info({ sessionId }, 'Settlement: checking game results')

  const pendingGames = await SlipGame.find({ sessionId, result: GameResult.PENDING })

  for (const game of pendingGames) {
    await checkGameResult(game._id.toString(), sessionId)
  }

  await tryFinaliseSession(sessionId)
}

/**
 * Checks a single SlipGame result.
 * If unavailable, spawns a pulse job.
 */
export async function checkGameResult(slipGameId: string, sessionId: string): Promise<void> {
  const game = await SlipGame.findById(slipGameId)
  if (!game || game.result !== GameResult.PENDING) return

  const result = await fetchFixtureResult(game.externalFixtureId)

  if (!result) {
    logger.warn({ slipGameId, fixtureId: game.externalFixtureId }, 'No result returned from API — spawning pulse')
    await spawnPulse(slipGameId, sessionId, 1)
    return
  }

  if (!result.finished) {
    logger.info({ slipGameId, fixtureId: game.externalFixtureId }, 'Match not finished — spawning pulse')
    await spawnPulse(slipGameId, sessionId, 1)
    return
  }

  // Result is available — evaluate prediction
  const won = result.homeGoals !== null && result.awayGoals !== null
    ? evaluatePrediction(game.prediction, game.predictionType, result.homeGoals, result.awayGoals)
    : false

  game.result    = won ? GameResult.WON : GameResult.LOST
  game.score     = result.score
  game.settledAt = new Date()
  await game.save()

  logger.info(
    { slipGameId, fixtureId: game.externalFixtureId, result: game.result, score: result.score },
    'Game settled'
  )
}

/**
 * Checks whether all games in a session are resolved.
 * If so, scores all slips and finalises the session.
 * Triggers recalibration engine on completion.
 */
export async function tryFinaliseSession(sessionId: string): Promise<void> {
  const session = await BetSession.findById(sessionId)
  if (!session) return
  if (session.status === SessionStatus.SETTLED || session.status === SessionStatus.CANCELLED) return

  const allGames     = await SlipGame.find({ sessionId })
  const pendingGames = allGames.filter(g => g.result === GameResult.PENDING)

  if (pendingGames.length > 0) {
    // Still waiting on results — check if pulses are active
    const activePulses = await PulseJob.countDocuments({ sessionId, status: PulseStatus.ACTIVE })
    if (activePulses > 0) {
      session.status = SessionStatus.PULSING
      await session.save()
    }
    logger.info({ sessionId, pendingGames: pendingGames.length }, 'Session not yet fully settled')
    return
  }

  // ── All games resolved — score slips ───────────────────────────────────────
  const allSlips = await BetSlip.find({ sessionId })

  let sessionTotalReturn = 0

  for (const slip of allSlips) {
    const slipGames = allGames.filter(g => g.slipId.toString() === slip._id.toString())

    const allWon  = slipGames.every(g => g.result === GameResult.WON || g.result === GameResult.VOID)
    const anyLost = slipGames.some(g => g.result === GameResult.LOST)
    const allVoid = slipGames.every(g => g.result === GameResult.VOID)

    let slipStatus: SlipStatus
    let actualReturn = 0

    if (allVoid) {
      slipStatus   = SlipStatus.VOID
      actualReturn = slip.stake   // stake refunded on void
    } else if (anyLost) {
      slipStatus   = SlipStatus.LOST
      actualReturn = 0
    } else if (allWon) {
      slipStatus   = SlipStatus.WON
      // For void games in a winning slip: remove their odds from combined
      const effectiveOdds = slipGames
        .filter(g => g.result !== GameResult.VOID)
        .reduce((prod, g) => prod * g.odds, 1)
      actualReturn = Math.floor(slip.stake * effectiveOdds)
    } else {
      slipStatus   = SlipStatus.PARTIAL
      actualReturn = 0
    }

    slip.status       = slipStatus
    slip.actualReturn = actualReturn
    slip.settledAt    = new Date()
    await slip.save()

    sessionTotalReturn += actualReturn
  }

  // ── Update session ──────────────────────────────────────────────────────────
  session.totalReturn = sessionTotalReturn
  session.pnl         = sessionTotalReturn - session.totalStaked
  session.status      = SessionStatus.SETTLED
  session.settledAt   = new Date()
  await session.save()

  logger.info(
    { sessionId, totalStaked: session.totalStaked, totalReturn: sessionTotalReturn, pnl: session.pnl },
    'Session fully settled'
  )

  // ── Trigger recalibration ───────────────────────────────────────────────────
  const { runRecalibration } = await import('./trackLoop')
  await runRecalibration(session.trackId.toString(), sessionId)
}

// ─── Pulse spawning ───────────────────────────────────────────────────────────

async function spawnPulse(slipGameId: string, sessionId: string, attemptNumber: number): Promise<void> {
  const delay       = attemptNumber === 1 ? PULSE_DELAY_ATTEMPT_1 : PULSE_DELAY_SUBSEQUENT
  const nextCheckAt = new Date(Date.now() + delay)
  const queue       = getQueue('pulse')

  const job = await queue.add(
    'check-result',
    { slipGameId, sessionId, attemptNumber },
    { delay, attempts: 1 }
  )

  await PulseJob.create({
    sessionId:    new Types.ObjectId(sessionId),
    slipGameId:   new Types.ObjectId(slipGameId),
    bullJobId:    job.id!,
    attemptNumber,
    nextCheckAt,
  })

  logger.info({ slipGameId, attemptNumber, nextCheckAt }, 'Pulse job spawned')
}
