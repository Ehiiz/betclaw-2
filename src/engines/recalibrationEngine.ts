import { IBetTrack } from '../models/BetTrack'
import { IBetSession } from '../models/BetSession'
import {
  Temperament, TrackStatus, DurationType,
  TEMPERAMENT_LADDER, RecalibrationResult,
} from '../types'
import { env } from '../config/env'

/**
 * Scores a completed session and decides:
 * - New temperament for next session
 * - Whether the track should continue or close
 */
export function recalibrate(track: IBetTrack, session: IBetSession): RecalibrationResult {
  const { pnl, allocation } = session
  const pnlRatio = allocation > 0 ? pnl / allocation : 0

  // ── Score the session outcome ────────────────────────────────────────────────
  let pnlRating: RecalibrationResult['pnlRating']

  if (pnlRatio > 0.20) {
    pnlRating = 'big_win'
  } else if (pnlRatio >= 0) {
    pnlRating = 'small_win'
  } else if (pnlRatio > -0.20) {
    pnlRating = 'small_loss'
  } else {
    pnlRating = 'big_loss'
  }

  // ── Check track exit conditions ──────────────────────────────────────────────
  const currentValue   = track.budget + track.totalPnL
  const minStake       = env.MIN_STAKE

  // Target hit
  if (currentValue >= track.target) {
    return { newTemperament: track.currentTemperament, shouldContinue: false, closeReason: TrackStatus.COMPLETED, pnlRating }
  }

  // Budget exhausted
  if (track.remainingBudget <= minStake) {
    return { newTemperament: track.currentTemperament, shouldContinue: false, closeReason: TrackStatus.FAILED, pnlRating }
  }

  // Duration expired (days-based)
  if (track.duration.type === DurationType.DAYS && new Date() >= track.endsAt) {
    return { newTemperament: track.currentTemperament, shouldContinue: false, closeReason: TrackStatus.EXPIRED, pnlRating }
  }

  // Duration expired (session-based)
  if (track.duration.type === DurationType.SESSIONS && track.sessionCount >= track.duration.value) {
    return { newTemperament: track.currentTemperament, shouldContinue: false, closeReason: TrackStatus.EXPIRED, pnlRating }
  }

  // Track paused by user
  if (track.status === TrackStatus.PAUSED) {
    return { newTemperament: track.currentTemperament, shouldContinue: false, pnlRating }
  }

  // ── Adjust temperament ───────────────────────────────────────────────────────
  const newTemperament = adjustTemperament(track.currentTemperament, track.startingTemperament, pnlRating)

  return { newTemperament, shouldContinue: true, pnlRating }
}

function adjustTemperament(
  current:  Temperament,
  ceiling:  Temperament,
  rating:   RecalibrationResult['pnlRating'],
): Temperament {
  // Restorative is a special recovery mode — always exit after one session
  // (either to conservative if still recovering, or follow normal rules)
  const effectiveCurrent = current === Temperament.RESTORATIVE
    ? Temperament.CONSERVATIVE
    : current

  const ceilingIndex = TEMPERAMENT_LADDER.indexOf(ceiling)
  const currentIndex = TEMPERAMENT_LADDER.indexOf(effectiveCurrent)

  switch (rating) {
    case 'big_win': {
      // Nudge up one level, but never exceed starting ceiling
      const next = Math.min(currentIndex + 1, ceilingIndex)
      return TEMPERAMENT_LADDER[next]
    }
    case 'small_win': {
      // Hold current
      return effectiveCurrent
    }
    case 'small_loss': {
      // Nudge down one level
      const next = Math.max(currentIndex - 1, 1) // floor at conservative (index 1)
      return TEMPERAMENT_LADDER[next]
    }
    case 'big_loss': {
      // Enter restorative mode
      return Temperament.RESTORATIVE
    }
  }
}
