import { Types } from 'mongoose'
import { IBetTrack } from '../models/BetTrack'
import { IBetSession } from '../models/BetSession'
import { BetSlip } from '../models/BetSlip'
import { SlipGame } from '../models/SlipGame'
import { logger } from '../config/logger'
import {
  fetchUpcomingFixtures, fetchTeamForm, fetchH2H,
  ProcessedFixture,
} from '../services/sportsApi'
import {
  Temperament, PredictionType, TEMPERAMENT_CONFIG, FixtureScore,
} from '../types'

const LEAGUE_TIER_BONUS: Record<string, number> = {
  'Premier League':   5,
  'La Liga':          5,
  'Bundesliga':       5,
  'Serie A':          5,
  'Ligue 1':          5,
  'Champions League': 5,
  'Europa League':    3,
  'Championship':     2,
}

/**
 * Fetches fixtures, scores them, groups into slips,
 * and persists BetSlip + SlipGame records for the session.
 */
export async function runCurationEngine(
  track:      IBetTrack,
  session:    IBetSession,
  allocation: number,
): Promise<void> {
  const config     = TEMPERAMENT_CONFIG[track.currentTemperament]
  const temperament = track.currentTemperament

  logger.info({ trackId: track._id, sessionId: session._id, temperament }, 'Curation engine starting')

  // ── Step 1: Fetch upcoming fixtures ─────────────────────────────────────────
  const fixtures = await fetchUpcomingFixtures()

  if (fixtures.length === 0) {
    logger.warn({ sessionId: session._id }, 'No fixtures available for curation')
    return
  }

  // ── Step 2: Score each fixture ───────────────────────────────────────────────
  const scored = await scoreFixtures(fixtures, temperament)

  // Filter by minimum confidence score for this temperament
  const qualified = scored.filter(s => s.confidenceScore >= config.minFixtureScore)

  logger.info({ total: fixtures.length, qualified: qualified.length }, 'Fixtures scored and filtered')

  if (qualified.length === 0) {
    logger.warn({ sessionId: session._id }, 'No fixtures met minimum confidence threshold')
    return
  }

  // Sort by confidence descending
  qualified.sort((a, b) => b.confidenceScore - a.confidenceScore)

  // ── Step 3: Determine slip count ─────────────────────────────────────────────
  const slipCount   = randomBetween(config.slipsMin, config.slipsMax)
  const gamesPerSlip = randomBetween(config.gamesPerSlipMin, config.gamesPerSlipMax)
  const totalGamesNeeded = slipCount * gamesPerSlip

  // Take the top-N fixtures we need
  const selected = qualified.slice(0, Math.min(totalGamesNeeded, qualified.length))

  if (selected.length < slipCount) {
    logger.warn({ needed: slipCount, available: selected.length }, 'Not enough fixtures for all slips — reducing slip count')
  }

  // ── Step 4: Group fixtures into slips ────────────────────────────────────────
  const slipGroups: FixtureScore[][] = []
  let fixtureIndex = 0

  for (let i = 0; i < slipCount; i++) {
    const group: FixtureScore[] = []
    for (let j = 0; j < gamesPerSlip; j++) {
      if (fixtureIndex < selected.length) {
        group.push(selected[fixtureIndex++])
      }
    }
    if (group.length > 0) slipGroups.push(group)
  }

  // ── Step 5: Calculate stakes via staking engine ───────────────────────────────
  const { calculateStakes } = await import('./stakingEngine')

  const slipInputs = slipGroups.map((group, idx) => ({
    index:        idx,
    combinedOdds: group.reduce((prod, g) => prod * g.odds, 1),
  }))

  const stakes = calculateStakes(slipInputs, allocation, temperament)

  // ── Step 6: Persist BetSlips and SlipGames ────────────────────────────────────
  let latestSettlementTime = new Date(0)

  for (let i = 0; i < slipGroups.length; i++) {
    const group       = slipGroups[i]
    const stakeData   = stakes.find(s => s.slipIndex === i)
    if (!stakeData) continue

    const combinedOdds     = group.reduce((prod, g) => prod * g.odds, 1)
    const avgConfidence    = group.reduce((sum, g) => sum + g.confidenceScore, 0) / group.length
    const lastGameKickoff  = group.reduce((latest, g) => g.kickoffTime > latest ? g.kickoffTime : latest, new Date(0))
    const settlementTime   = new Date(lastGameKickoff.getTime() + 110 * 60 * 1000)

    if (settlementTime > latestSettlementTime) {
      latestSettlementTime = settlementTime
    }

    const slip = await BetSlip.create({
      sessionId:          session._id,
      trackId:            track._id,
      userId:             track.userId,
      stake:              stakeData.stake,
      combinedOdds:       parseFloat(combinedOdds.toFixed(2)),
      potentialReturn:    Math.floor(stakeData.stake * combinedOdds),
      confidenceScore:    parseFloat(avgConfidence.toFixed(1)),
      lastSettlementTime: settlementTime,
    })

    // Persist each game in this slip
    for (const game of group) {
      const gameSettlementTime = new Date(game.kickoffTime.getTime() + 110 * 60 * 1000)

      await SlipGame.create({
        slipId:            slip._id,
        sessionId:         session._id,
        externalFixtureId: game.fixtureId,
        league:            game.league,
        homeTeam:          game.homeTeam,
        awayTeam:          game.awayTeam,
        kickoffTime:       game.kickoffTime,
        predictionType:    game.bestPrediction,
        prediction:        game.bestPrediction,
        odds:              game.odds,
        confidenceScore:   game.confidenceScore,
        settlementTime:    gameSettlementTime,
      })
    }

    logger.info(
      { slipId: slip._id, games: group.length, stake: stakeData.stake, combinedOdds },
      'Slip created'
    )
  }

  // ── Step 7: Update session totals ────────────────────────────────────────────
  const allSlips   = await BetSlip.find({ sessionId: session._id })
  const totalStaked = allSlips.reduce((sum, s) => sum + s.stake, 0)

  session.totalStaked = totalStaked
  await session.save()

  logger.info(
    { sessionId: session._id, slips: slipGroups.length, totalStaked, latestSettlementTime },
    'Curation complete'
  )
}

// ─── Fixture scoring ──────────────────────────────────────────────────────────

async function scoreFixtures(
  fixtures:    ProcessedFixture[],
  temperament: Temperament,
): Promise<FixtureScore[]> {
  const config = TEMPERAMENT_CONFIG[temperament]
  const scored: FixtureScore[] = []

  // Batch form requests — limit concurrency to avoid rate limits
  const BATCH_SIZE = 5

  for (let i = 0; i < fixtures.length; i += BATCH_SIZE) {
    const batch = fixtures.slice(i, i + BATCH_SIZE)

    await Promise.all(batch.map(async (fixture) => {
      try {
        const [homeForm, awayForm, h2h] = await Promise.all([
          fetchTeamForm(fixture.homeTeamId),
          fetchTeamForm(fixture.awayTeamId),
          fetchH2H(fixture.homeTeamId, fixture.awayTeamId),
        ])

        // Pick the best prediction market for this fixture
        const { bestPrediction, odds, confidence } = pickBestPrediction(fixture, config)

        if (!odds) return  // no usable odds

        // Validate odds are within temperament range
        // For multi-game slips the combined odds are what matter,
        // but per-game odds still need to be reasonable
        if (odds < 1.1) return

        const score = computeFixtureScore(
          fixture, homeForm, awayForm, h2h,
          bestPrediction, odds, config,
        )

        scored.push({
          fixtureId:       fixture.fixtureId,
          homeTeam:        fixture.homeTeam,
          awayTeam:        fixture.awayTeam,
          league:          fixture.league,
          kickoffTime:     fixture.kickoffTime,
          confidenceScore: score,
          bestPrediction,
          odds,
        })
      } catch (err) {
        logger.warn({ err, fixtureId: fixture.fixtureId }, 'Error scoring fixture — skipping')
      }
    }))
  }

  return scored
}

function pickBestPrediction(
  fixture: ProcessedFixture,
  config:  { oddsMin: number; oddsMax: number },
): { bestPrediction: PredictionType; odds: number; confidence: number } {
  const { odds } = fixture
  const { oddsMin, oddsMax } = config

  // All candidate markets
  const candidates: Array<{ type: PredictionType; odds: number }> = [
    { type: PredictionType.HOME_WIN,  odds: odds.home    },
    { type: PredictionType.DRAW,      odds: odds.draw    },
    { type: PredictionType.AWAY_WIN,  odds: odds.away    },
    { type: PredictionType.BTTS_YES,  odds: odds.bttsYes },
    { type: PredictionType.BTTS_NO,   odds: odds.bttsNo  },
    { type: PredictionType.OVER_25,   odds: odds.over25  },
    { type: PredictionType.UNDER_25,  odds: odds.under25 },
  ].filter(c => c.odds > 1.05)

  // Prefer candidates whose odds fall within the temperament's target range
  const inRange = candidates.filter(c => c.odds >= oddsMin && c.odds <= oddsMax)
  const pool    = inRange.length > 0 ? inRange : candidates

  if (pool.length === 0) {
    return { bestPrediction: PredictionType.HOME_WIN, odds: 0, confidence: 0 }
  }

  // Pick the one closest to the middle of the target range
  const midpoint = (oddsMin + oddsMax) / 2
  const best = pool.reduce((prev, curr) =>
    Math.abs(curr.odds - midpoint) < Math.abs(prev.odds - midpoint) ? curr : prev
  )

  return { bestPrediction: best.type, odds: best.odds, confidence: 50 }
}

function computeFixtureScore(
  fixture:    ProcessedFixture,
  homeForm:   any,
  awayForm:   any,
  h2h:        any[],
  prediction: PredictionType,
  odds:       number,
  config:     { oddsMin: number; oddsMax: number },
): number {
  let score = 0

  // ── Odds attractiveness (40%) ─────────────────────────────────────────────
  const { oddsMin, oddsMax } = config
  const midpoint = (oddsMin + oddsMax) / 2
  const range    = (oddsMax - oddsMin) / 2 || 1
  const oddsDist = Math.abs(odds - midpoint) / range
  const oddsScore = Math.max(0, 100 - oddsDist * 100)
  score += oddsScore * 0.40

  // ── Home team form (20%) ──────────────────────────────────────────────────
  const homeFormScore = homeForm ? calcFormScore(homeForm.form ?? '') : 50
  score += homeFormScore * 0.20

  // ── Away team form (20%) ──────────────────────────────────────────────────
  const awayFormScore = awayForm ? calcFormScore(awayForm.form ?? '') : 50
  score += awayFormScore * 0.20

  // ── H2H record (15%) ─────────────────────────────────────────────────────
  const h2hScore = calcH2HScore(h2h, prediction, fixture.homeTeam)
  score += h2hScore * 0.15

  // ── League tier bonus (5%) ────────────────────────────────────────────────
  const leagueBonus = LEAGUE_TIER_BONUS[fixture.league] ?? 0
  score += leagueBonus

  return Math.min(Math.round(score), 100)
}

function calcFormScore(form: string): number {
  if (!form) return 50
  const recent = form.slice(-5).split('')
  const points = recent.reduce((sum, r) => {
    if (r === 'W') return sum + 3
    if (r === 'D') return sum + 1
    return sum
  }, 0)
  return (points / 15) * 100  // max 15 points (5W) → 100
}

function calcH2HScore(h2h: any[], prediction: PredictionType, homeTeam: string): number {
  if (!h2h?.length) return 50

  let wins = 0
  for (const match of h2h.slice(-5)) {
    const hg = match.score?.fulltime?.home ?? 0
    const ag = match.score?.fulltime?.away ?? 0
    const matchHome = match.teams?.home?.name === homeTeam

    const won = checkH2HPrediction(prediction, hg, ag, matchHome)
    if (won) wins++
  }

  return (wins / Math.min(h2h.length, 5)) * 100
}

function checkH2HPrediction(prediction: PredictionType, hg: number, ag: number, matchHome: boolean): boolean {
  switch (prediction) {
    case PredictionType.HOME_WIN:  return matchHome ? hg > ag : ag > hg
    case PredictionType.AWAY_WIN:  return matchHome ? ag > hg : hg > ag
    case PredictionType.DRAW:      return hg === ag
    case PredictionType.BTTS_YES:  return hg > 0 && ag > 0
    case PredictionType.BTTS_NO:   return hg === 0 || ag === 0
    case PredictionType.OVER_25:   return (hg + ag) > 2.5
    case PredictionType.UNDER_25:  return (hg + ag) < 2.5
    default: return false
  }
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
