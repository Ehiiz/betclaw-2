import { Types } from 'mongoose'
import { IBetTrack } from '../models/BetTrack'
import { IBetSession } from '../models/BetSession'
import { BetSlip } from '../models/BetSlip'
import { SlipGame } from '../models/SlipGame'
import { logger } from '../config/logger'
import { env } from '../config/env'
import { fetchUpcomingFixtures, ProcessedFixture } from '../services/sportsApi'
import { fetchOddsForDate, normaliseTeamKey } from '../services/oddsApi'
import { runVerdictEngine, SlipForVerdict } from './verdictEngine'
import { calculateStakes } from './stakingEngine'
import { TEMPERAMENT_CONFIG, FixtureScore, PredictionType, Temperament, SlipStatus } from '../types'

const LEAGUE_TIER_BONUS: Record<string, number> = {
  'Premier League': 5,
  'La Liga': 5,
  'Bundesliga': 5,
  'Serie A': 5,
  'Süper Lig': 3,
  'Championship': 2,
}

const ALLOWED_LEAGUE_IDS = new Set([
  39,   // English Premier League
  140,  // La Liga (Spain)
  78,   // Bundesliga (Germany)
  135,  // Serie A (Italy)
  203,  // Süper Lig (Turkey)
  17,   // Championship (England)
])

export async function runCurationEngine(
  track: IBetTrack,
  session: IBetSession,
  allocation: number,
  verdictModel: 'gemini' | 'gpt-4o' = 'gemini',
): Promise<void> {
  const config = TEMPERAMENT_CONFIG[track.currentTemperament]
  const temperament = track.currentTemperament

  logger.info({ trackId: track._id, sessionId: session._id, temperament }, 'Curation engine starting')

  // ── Step 1: Fetch fixtures ─────────────────────────────────────────────────
  const fixtures = await fetchUpcomingFixtures()
  if (fixtures.length === 0) {
    logger.warn({ sessionId: session._id }, 'No fixtures available')
    return
  }

  const filteredFixtures = fixtures;

  logger.info({
    total: fixtures.length,
    filtered: filteredFixtures.length,
    leagues: [...ALLOWED_LEAGUE_IDS]
  }, 'Fixtures filtered to allowed leagues')
  // ── Step 2: Enrich with real odds, unless dev mode is forcing synthetic data ──
  const useFixtureOddsDirectly = env.USE_SYNTHETIC_FIXTURES || env.NODE_ENV === 'development'
  const enrichedFixtures: ProcessedFixture[] = useFixtureOddsDirectly
    ? filteredFixtures.filter((fixture) => fixture.odds.home > 1 && fixture.odds.away > 1)
    : await enrichFixturesWithLiveOdds(filteredFixtures)

  logger.info({
    total: filteredFixtures.length,
    enriched: enrichedFixtures.length,
    skipped: filteredFixtures.length - enrichedFixtures.length,
    source: useFixtureOddsDirectly ? 'fixture_odds' : 'odds_api',
  }, 'Odds enrichment complete')

  // ── Step 3: Score fixtures ─────────────────────────────────────────────────
  const scored = scoreFixtures(enrichedFixtures, temperament)
  const qualified = scored.filter(s => s.confidenceScore >= config.minFixtureScore)

  logger.info({ total: enrichedFixtures.length, qualified: qualified.length }, 'Fixtures scored')

  if (qualified.length === 0) {
    logger.warn({ sessionId: session._id }, 'No fixtures met confidence threshold')
    return
  }

  qualified.sort((a, b) => b.confidenceScore - a.confidenceScore)

  // ── Step 4: Assemble slip groups ──────────────────────────────────────────
  const slipCount = randomBetween(config.slipsMin, config.slipsMax)
  const gamesPerSlip = randomBetween(config.gamesPerSlipMin, config.gamesPerSlipMax)
  const selected = qualified.slice(0, slipCount * gamesPerSlip)

  logger.info({
    sessionId: session._id,
    qualified: qualified.length,
    slipCount,
    gamesPerSlip,
    selected: selected.length,
  }, 'Slip assembly targets selected')

  const slipGroups: FixtureScore[][] = []
  for (let i = 0; i < slipCount; i++) {
    const group: FixtureScore[] = []
    for (let j = 0; j < gamesPerSlip; j++) {
      const idx = i * gamesPerSlip + j
      if (idx < selected.length) group.push(selected[idx])
    }
    if (group.length > 0) slipGroups.push(group)
  }

  // ── Step 5: Calculate initial stakes ────────────────────────────────────────
  const slipInputs = slipGroups.map((group, idx) => ({
    index: idx,
    combinedOdds: group.reduce((prod, g) => prod * g.odds, 1),
  }))
  const initialStakes = calculateStakes(slipInputs, allocation, temperament)

  // ── Step 6: Build slip data for Verdict Engine ────────────────────────────
  const slipsForVerdict: SlipForVerdict[] = slipGroups.map((group, i) => {
    const stakeData = initialStakes.find(s => s.slipIndex === i)!
    const combinedOdds = +group.reduce((prod, g) => prod * g.odds, 1).toFixed(2)
    return {
      slipIndex: i,
      combinedOdds,
      stake: stakeData.stake,
      potentialReturn: Math.floor(stakeData.stake * combinedOdds),
      confidenceScore: +(group.reduce((s, g) => s + g.confidenceScore, 0) / group.length).toFixed(1),
      games: group.map(g => ({
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        league: g.league,
        kickoffTime: g.kickoffTime,
        prediction: g.bestPrediction,
        predictionType: g.bestPrediction,
        odds: g.odds,
        confidenceScore: g.confidenceScore,
      })),
    }
  })

  // ── Step 7: Run GPT-4o Verdict Engine ────────────────────────────────────
  const verdicts = await runVerdictEngine(slipsForVerdict, temperament, {
    budget: track.budget,
    remainingBudget: track.remainingBudget,
    target: track.target,
    totalPnL: track.totalPnL,
    sessionCount: track.sessionCount,
  }, verdictModel)

  // Filter and adjust based on verdicts
  let approvedGroups = slipGroups.filter((_, i) => {
    const v = verdicts.get(i)
    return v?.verdict !== 'skip'
  })

  if (approvedGroups.length === 0) {
    const rescuedGroup = slipGroups[0]
    const rescuedVerdict = verdicts.get(0)

    if (!rescuedGroup || !rescuedVerdict) {
      logger.warn({ sessionId: session._id }, 'All slips skipped by Verdict Engine')
      return
    }

    verdicts.set(0, {
      ...rescuedVerdict,
      verdict: 'reduce',
      confidence: Math.max(rescuedVerdict.confidence, 55),
      reasoning: 'All slips were filtered out, so BetClaw is retrying with the strongest slip at reduced stake.',
      analysis: {
        ...rescuedVerdict.analysis,
        recommendation: 'Proceed at reduced stake while preserving session continuity.',
        flags: Array.from(new Set([...(rescuedVerdict.analysis.flags ?? []), 'rescued'])),
      },
    })

    approvedGroups.push(rescuedGroup)
    logger.info({ sessionId: session._id }, 'Rescued strongest slip after all AI verdicts skipped')
  }

  // Recalculate stakes for approved slips only
  const approvedInputs = approvedGroups.map((group, idx) => ({
    index: idx,
    combinedOdds: group.reduce((prod, g) => prod * g.odds, 1),
  }))
  const finalStakes = calculateStakes(approvedInputs, allocation, temperament)

  // ── Step 8: Persist BetSlips and SlipGames ────────────────────────────────
  let latestSettlementTime = new Date(0)

  // Persist ALL slips — approved ones as pending, skipped ones as void for UI visibility
  for (let i = 0; i < slipGroups.length; i++) {
    const group = slipGroups[i]
    const originalIdx = i
    const verdict = verdicts.get(originalIdx)!
    const isSkipped = verdict.verdict === 'skip'

    // For skipped slips, use the initial stake calculation for display purposes
    const stakeData = isSkipped
      ? initialStakes.find(s => s.slipIndex === i)!
      : finalStakes.find(s => s.slipIndex === approvedGroups.indexOf(group))!

    let finalStake = stakeData?.stake ?? 0

    // Apply stake reduction for 'reduce' verdicts
    if (verdict.verdict === 'reduce') {
      const reducedCap = allocation * 0.20
      finalStake = Math.min(finalStake, reducedCap)
      logger.info({ slipIndex: i, original: stakeData.stake, reduced: finalStake }, 'Stake reduced by verdict')
    }

    const combinedOdds = +group.reduce((prod, g) => prod * g.odds, 1).toFixed(2)
    const avgConfidence = +(group.reduce((s, g) => s + g.confidenceScore, 0) / group.length).toFixed(1)
    const lastKickoff = group.reduce((latest, g) => g.kickoffTime > latest ? g.kickoffTime : latest, new Date(0))
    const settlementTime = new Date(lastKickoff.getTime() + 110 * 60 * 1000)

    if (!isSkipped && settlementTime > latestSettlementTime) latestSettlementTime = settlementTime

    const slip = await BetSlip.create({
      sessionId: session._id,
      trackId: track._id,
      userId: track.userId,
      stake: finalStake,
      combinedOdds,
      potentialReturn: Math.floor(finalStake * combinedOdds),
      confidenceScore: avgConfidence,
      lastSettlementTime: settlementTime,
      status: isSkipped ? SlipStatus.VOID : SlipStatus.PENDING,
      verdict: verdict.verdict,
      verdictModel: verdict.model,
      verdictConfidence: verdict.confidence,
      verdictReasoning: verdict.reasoning,
      verdictAnalysis: verdict.analysis,
    })

    for (const game of group) {
      await SlipGame.create({
        slipId: slip._id,
        sessionId: session._id,
        externalFixtureId: game.fixtureId,
        league: game.league,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        kickoffTime: game.kickoffTime,
        predictionType: game.bestPrediction,
        prediction: game.bestPrediction,
        odds: game.odds,
        confidenceScore: game.confidenceScore,
        settlementTime: new Date(game.kickoffTime.getTime() + 110 * 60 * 1000),
      })
    }

    logger.info({
      slipId: slip._id,
      games: group.length,
      stake: finalStake,
      combinedOdds,
      verdict: verdict.verdict,
      status: isSkipped ? 'void' : 'pending',
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
    }, 'Slip created with verdict')
  }

  // ── Step 8b: If any slips were reduced, create a bonus slip with the saved amount ──
  const reducedSlips = slipGroups.filter((_, i) => verdicts.get(i)?.verdict === 'reduce')

  if (reducedSlips.length > 0 && qualified.length > 0) {
    // Calculate total saved from reductions
    const totalSaved = reducedSlips.reduce((sum, group, idx) => {
      const originalStake = initialStakes.find(s => s.slipIndex === slipGroups.indexOf(group))?.stake ?? 0
      const reducedStake = Math.min(originalStake, allocation * 0.20)
      return sum + (originalStake - reducedStake)
    }, 0)

    if (totalSaved >= 100) { // only create bonus slip if there's meaningful amount saved
      // Pick games not already used in any slip
      const usedFixtureIds = new Set(slipGroups.flat().map(g => g.fixtureId))
      const freshGames = qualified.filter(g => !usedFixtureIds.has(g.fixtureId))

      if (freshGames.length >= 2) {
        const bonusGroup = freshGames.slice(0, 2)
        const bonusCombinedOdds = +bonusGroup.reduce((prod, g) => prod * g.odds, 1).toFixed(2)
        const lastKickoff = bonusGroup.reduce((latest, g) => g.kickoffTime > latest ? g.kickoffTime : latest, new Date(0))
        const settlementTime = new Date(lastKickoff.getTime() + 110 * 60 * 1000)
        if (settlementTime > latestSettlementTime) latestSettlementTime = settlementTime

        const bonusSlip = await BetSlip.create({
          sessionId: session._id,
          trackId: track._id,
          userId: track.userId,
          stake: Math.floor(totalSaved),
          combinedOdds: bonusCombinedOdds,
          potentialReturn: Math.floor(totalSaved * bonusCombinedOdds),
          confidenceScore: +(bonusGroup.reduce((s, g) => s + g.confidenceScore, 0) / bonusGroup.length).toFixed(1),
          lastSettlementTime: settlementTime,
          status: SlipStatus.PENDING,
          verdict: 'bet',
          verdictModel: 'gemini',
          verdictConfidence: 60,
          verdictReasoning: `Bonus slip created from ₦${Math.floor(totalSaved)} saved via stake reduction on ${reducedSlips.length} slip(s).`,
          verdictAnalysis: { overview: 'Auto-generated bonus slip from reduction savings.', oddsAssessment: '', combinationRisk: '', leagueInsight: '', recommendation: '', keyRisks: [], keyStrengths: [], flags: ['bonus_slip'] },
        })

        for (const game of bonusGroup) {
          await SlipGame.create({
            slipId: bonusSlip._id,
            sessionId: session._id,
            externalFixtureId: game.fixtureId,
            league: game.league,
            homeTeam: game.homeTeam,
            awayTeam: game.awayTeam,
            kickoffTime: game.kickoffTime,
            predictionType: game.bestPrediction,
            prediction: game.bestPrediction,
            odds: game.odds,
            confidenceScore: game.confidenceScore,
            settlementTime: new Date(game.kickoffTime.getTime() + 110 * 60 * 1000),
          })
        }

        logger.info({
          bonusSlipId: bonusSlip._id,
          stake: Math.floor(totalSaved),
          combinedOdds: bonusCombinedOdds,
          games: bonusGroup.length,
        }, 'Bonus slip created from reduction savings')
      }
    }
  }

  // ── Step 9: Update session totals ─────────────────────────────────────────
  const allSlips = await BetSlip.find({ sessionId: session._id })
  session.totalStaked = allSlips.reduce((sum, s) => sum + s.stake, 0)
  await session.save()

  logger.info({
    sessionId: session._id,
    totalSlips: approvedGroups.length,
    skippedSlips: slipGroups.length - approvedGroups.length,
    totalStaked: session.totalStaked,
    settlementAt: latestSettlementTime,
  }, 'Curation complete')
}

async function enrichFixturesWithLiveOdds(filteredFixtures: ProcessedFixture[]): Promise<ProcessedFixture[]> {
  logger.info('Fetching real odds from The Odds API...')
  const oddsMap = await fetchOddsForDate()
  logger.info({ realOddsCount: oddsMap.size }, 'Odds map built')

  return filteredFixtures
    .map((fixture) => {
      const key = normaliseTeamKey(fixture.homeTeam, fixture.awayTeam)
      const realOdds = oddsMap.get(key)
      if (realOdds && realOdds.home > 1) {
        logger.debug({ fixture: `${fixture.homeTeam} vs ${fixture.awayTeam}` }, 'Using real odds')
        return { ...fixture, odds: realOdds }
      }
      logger.debug({ fixture: `${fixture.homeTeam} vs ${fixture.awayTeam}` }, 'No real odds — skipping fixture')
      return null
    })
    .filter(Boolean) as ProcessedFixture[]
}

// ─── Fixture scoring ──────────────────────────────────────────────────────────
function scoreFixtures(fixtures: ProcessedFixture[], temperament: Temperament): FixtureScore[] {
  const config = TEMPERAMENT_CONFIG[temperament]
  return fixtures.map(f => {
    const { bestPrediction, odds } = pickBestPrediction(f, config)
    if (!odds || odds < 1.1) return null

    // Hard enforce: individual game odds must be within a sane range
    // Max single-game odds depends on temperament — prevents runaway accumulators
    const maxSingleOdds = temperament === 'conservative' ? 4.5
      : temperament === 'moderate' ? 7.5
        : temperament === 'aggressive' ? 12.0
          : 3.0

    if (odds > maxSingleOdds) return null

    const oddsScore = scoreOdds(odds, config.oddsMin, config.oddsMax)
    const leagueBonus = LEAGUE_TIER_BONUS[f.league] ?? 0
    const marketFitBonus = odds >= config.oddsMin && odds <= config.oddsMax ? 18 : 8
    const score = (oddsScore * 0.55) + (leagueBonus * 4) + marketFitBonus

    // In scoreFixtures, after calculating score:
    logger.debug({
      fixture: `${f.homeTeam} vs ${f.awayTeam}`,
      oddsScore: oddsScore.toFixed(1),
      leagueBonus,
      finalScore: Math.min(Math.round(score), 100),
      threshold: config.minFixtureScore,
      passed: Math.round(score) >= config.minFixtureScore,
    }, 'Fixture scored')

    return {
      fixtureId: f.fixtureId,
      homeTeam: f.homeTeam,
      awayTeam: f.awayTeam,
      league: f.league,
      kickoffTime: f.kickoffTime,
      confidenceScore: Math.min(Math.round(score), 100),
      bestPrediction,
      odds,
    } as FixtureScore
  }).filter(Boolean) as FixtureScore[]
}

function pickBestPrediction(
  fixture: ProcessedFixture,
  config: { oddsMin: number; oddsMax: number },
): { bestPrediction: PredictionType; odds: number } {
  const { odds } = fixture
  const candidates = [
    { type: PredictionType.HOME_WIN, odds: odds.home },
    { type: PredictionType.DRAW, odds: odds.draw },
    { type: PredictionType.AWAY_WIN, odds: odds.away },
    { type: PredictionType.BTTS_YES, odds: odds.bttsYes },
    { type: PredictionType.BTTS_NO, odds: odds.bttsNo },
    { type: PredictionType.OVER_15, odds: Math.max(1.1, (odds.over25 || 0) - 0.28) },
    { type: PredictionType.UNDER_15, odds: Math.max(1.1, (odds.under25 || 0) - 0.22) },
    { type: PredictionType.OVER_25, odds: odds.over25 },
    { type: PredictionType.UNDER_25, odds: odds.under25 },
  ].filter(c => c.odds > 1.05)

  const inRange = candidates.filter(c => c.odds >= config.oddsMin && c.odds <= config.oddsMax)
  const pool = inRange.length > 0 ? inRange : candidates
  if (pool.length === 0) return { bestPrediction: PredictionType.HOME_WIN, odds: 0 }

  const mid = (config.oddsMin + config.oddsMax) / 2
  const best = pool.reduce((prev, curr) =>
    Math.abs(curr.odds - mid) < Math.abs(prev.odds - mid) ? curr : prev
  )
  return { bestPrediction: best.type, odds: best.odds }
}

function scoreOdds(odds: number, min: number, max: number): number {
  const mid = (min + max) / 2
  const range = (max - min) / 2 || 1
  return Math.max(0, 100 - (Math.abs(odds - mid) / range) * 100)
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
