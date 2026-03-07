import { IBetTrack } from '../models/BetTrack'
import { env } from '../config/env'
import { TEMPERAMENT_CONFIG, SessionAllocation } from '../types'

/**
 * Determines how much budget to allocate to the next session.
 * Applies base allocation rate from temperament config + urgency multiplier.
 */
export function calculateAllocation(track: IBetTrack): SessionAllocation {
  const config = TEMPERAMENT_CONFIG[track.currentTemperament]
  const { remainingBudget, budget, target, totalPnL } = track

  // Base allocation — midpoint of temperament range
  const baseRate = (config.allocationMin + config.allocationMax) / 2

  // Progress: how far along are we to target?  (0 = just started, 1 = at target)
  const currentValue   = budget + totalPnL
  const totalNeeded    = target - budget
  const progress       = totalNeeded > 0 ? Math.min((currentValue - budget) / totalNeeded, 1) : 1

  // Urgency: how many sessions remain?
  let urgencyMultiplier = 1.0

  if (progress < 0.3) {
    // Behind target — push harder if few sessions left
    urgencyMultiplier = 1.3
  } else if (progress > 0.7) {
    // Ahead of target — protect gains, ease off
    urgencyMultiplier = 0.85
  }

  // Apply urgency to rate, then clamp within temperament band
  let rate = baseRate * urgencyMultiplier
  rate = Math.min(Math.max(rate, config.allocationMin), config.allocationMax)

  // Hard cap: never more than 40% of remaining budget regardless of temperament
  rate = Math.min(rate, 0.40)

  let amount = remainingBudget * rate

  // Hard floor: never below minimum viable stake
  const minStake = env.MIN_STAKE
  amount = Math.max(amount, minStake)

  // Can't allocate more than what's left
  amount = Math.min(amount, remainingBudget)

  return {
    amount:            Math.floor(amount),   // whole numbers only
    percentage:        rate,
    urgencyMultiplier,
  }
}
