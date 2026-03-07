import { TEMPERAMENT_CONFIG, SlipStake } from '../types'
import { Temperament } from '../types'

interface SlipInput {
  index:        number
  combinedOdds: number
}

/**
 * Distributes session allocation across curated slips using odds-weighted staking.
 * Higher combined odds = smaller stake (more risk = less exposure).
 * Temperament controls the max stake cap per slip.
 */
export function calculateStakes(
  slips:       SlipInput[],
  allocation:  number,
  temperament: Temperament,
): SlipStake[] {
  if (slips.length === 0) return []

  const config  = TEMPERAMENT_CONFIG[temperament]
  const maxPerSlip = allocation * config.maxSlipStakePct

  // Step 1: Calculate odds weights (inverse of odds = safer slip gets higher weight)
  const weights = slips.map(s => ({
    index:        s.index,
    combinedOdds: s.combinedOdds,
    weight:       1 / s.combinedOdds,
  }))

  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0)

  // Step 2: Initial proportional stakes
  let stakes: SlipStake[] = weights.map(w => ({
    slipIndex:    w.index,
    combinedOdds: w.combinedOdds,
    stake:        Math.floor((w.weight / totalWeight) * allocation),
  }))

  // Step 3: Apply per-slip cap and redistribute excess
  let iterations = 0
  let hasExcess  = true

  while (hasExcess && iterations < 10) {
    hasExcess = false
    iterations++

    const capped    = stakes.filter(s => s.stake >= maxPerSlip)
    const uncapped  = stakes.filter(s => s.stake <  maxPerSlip)

    if (capped.length === 0) break

    // Sum of excess from capped slips
    const excess = capped.reduce((sum, s) => sum + (s.stake - maxPerSlip), 0)
    if (excess <= 0) break

    // Cap the capped slips
    stakes = stakes.map(s => s.stake >= maxPerSlip ? { ...s, stake: maxPerSlip } : s)

    if (uncapped.length === 0) break

    // Redistribute excess proportionally to uncapped slips
    const uncappedWeightTotal = uncapped.reduce((sum, u) => {
      const w = weights.find(ww => ww.index === u.slipIndex)!
      return sum + w.weight
    }, 0)

    stakes = stakes.map(s => {
      if (s.stake < maxPerSlip) {
        const w     = weights.find(ww => ww.index === s.slipIndex)!
        const extra = Math.floor((w.weight / uncappedWeightTotal) * excess)
        return { ...s, stake: s.stake + extra }
      }
      return s
    })

    // Check if redistribution caused any new slips to exceed cap
    hasExcess = stakes.some(s => s.stake > maxPerSlip)
  }

  // Final safety: hard cap any remaining over-allocation
  stakes = stakes.map(s => ({ ...s, stake: Math.min(s.stake, maxPerSlip) }))

  // Ensure total doesn't exceed allocation (rounding correction on largest stake)
  const total = stakes.reduce((sum, s) => sum + s.stake, 0)
  if (total > allocation && stakes.length > 0) {
    const diff = total - allocation
    const largest = stakes.reduce((max, s) => s.stake > max.stake ? s : max, stakes[0])
    largest.stake = Math.max(0, largest.stake - diff)
  }

  return stakes
}
