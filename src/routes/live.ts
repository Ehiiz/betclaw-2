import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { GoogleGenAI, Modality } from '@google/genai'
import { BetTrack } from '../models/BetTrack'
import { BetSession } from '../models/BetSession'
import { BetSlip } from '../models/BetSlip'
import { SlipGame } from '../models/SlipGame'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { fetchUpcomingFixtures, fetchTeamForm, fetchH2H } from '../services/sportsApi'
import { buildSyntheticFixtures, fetchOddsForDate, fetchUpcomingOddsFixtures, normaliseTeamKey } from '../services/oddsApi'
import { validate } from '../middleware/validate'
import { env } from '../config/env'
import { calculateStakes } from '../engines/stakingEngine'
import { runVerdictEngine } from '../engines/verdictEngine'
import { GameResult, PredictionType, SessionStatus, SlipStatus, Temperament } from '../types'

const router = Router()
router.use(authenticate)

const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'

const startSessionSchema = z.object({
  leagues: z.array(z.string().min(1)).max(8).default([]),
  objective: z.string().min(1).max(240).default('Build a disciplined football betting plan'),
  periodHours: z.number().int().min(12).max(168).default(48),
})

const liveFixtureSchema = z.object({
  fixtureId: z.string().min(1),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  league: z.string().min(1),
  kickoffTime: z.string().datetime(),
  odds: z.object({
    home: z.number().positive(),
    draw: z.number().positive(),
    away: z.number().positive(),
    bttsYes: z.number().positive(),
    bttsNo: z.number().positive(),
    over25: z.number().positive(),
    under25: z.number().positive(),
  }),
  evidence: z.array(z.string().min(1)).default([]),
})

const analyzeDossiersSchema = z.object({
  fixtures: z.array(liveFixtureSchema).min(1).max(10),
})

const createSlipSchema = z.object({
  fixtures: z.array(liveFixtureSchema).min(1).max(10),
})

const leagueAliases: Record<string, string[]> = {
  'Premier League': ['premier league', 'epl', 'english premier league'],
  'La Liga': ['la liga', 'laliga', 'spain'],
  'Bundesliga': ['bundesliga', 'germany'],
  'Serie A': ['serie a', 'italy'],
  'Championship': ['championship', 'efl championship'],
  'Süper Lig': ['super lig', 'süper lig', 'turkey'],
  'Ligue 1': ['ligue 1', 'france'],
  'UEFA Champions League': ['champions league', 'ucl'],
}

router.get('/briefing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestedTrackId = typeof req.query.trackId === 'string' ? req.query.trackId : undefined
    const track = requestedTrackId
      ? await BetTrack.findOne({ _id: requestedTrackId, userId: req.user!.userId })
      : await BetTrack.findOne({ userId: req.user!.userId }).sort({ createdAt: -1 })

    if (!track) {
      throw new AppError(404, 'No track available for live briefing')
    }

    const session = await BetSession.findOne({ trackId: track._id }).sort({ createdAt: -1 })
    const slips = await BetSlip.find({ trackId: track._id }).sort({ createdAt: -1 }).limit(20)
    const upcomingFixtures = (await fetchUpcomingFixtures()).slice(0, 4)
    const useFixtureOddsDirectly = env.USE_SYNTHETIC_FIXTURES || env.NODE_ENV === 'development'
    const oddsMap = useFixtureOddsDirectly ? new Map() : await fetchOddsForDate()

    const slipIds = slips.map((slip) => slip._id)
    const games = slipIds.length > 0 ? await SlipGame.find({ slipId: { $in: slipIds } }) : []

    const slipCards = slips.map((slip) => ({
      _id: slip._id,
      sessionId: slip.sessionId,
      combinedOdds: slip.combinedOdds,
      stake: slip.stake,
      potentialReturn: slip.potentialReturn,
      status: slip.status,
      confidenceScore: slip.confidenceScore,
      verdict: slip.verdict,
      verdictReasoning: slip.verdictReasoning,
      games: games
        .filter((game) => game.slipId.toString() === slip._id.toString())
        .slice(0, 10)
        .map((game) => ({
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam,
          league: game.league,
          prediction: game.prediction,
          odds: game.odds,
        })),
    }))

    const fixtureCards = await Promise.all(
      upcomingFixtures.map(async (fixture) => {
        const [homeForm, awayForm, h2h] = fixture.homeTeamId && fixture.awayTeamId
          ? await Promise.all([
            fetchTeamForm(fixture.homeTeamId),
            fetchTeamForm(fixture.awayTeamId),
            fetchH2H(fixture.homeTeamId, fixture.awayTeamId, 4),
          ])
          : [null, null, []]

        const liveOdds = oddsMap.get(normaliseTeamKey(fixture.homeTeam, fixture.awayTeam))

        return {
          fixtureId: fixture.fixtureId,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          league: fixture.league,
          kickoffTime: fixture.kickoffTime,
          odds: liveOdds ?? fixture.odds,
          dossierPrompt: `Assess ${fixture.homeTeam} vs ${fixture.awayTeam} using the user's screenshots, recent form, and H2H context before recommending any market.`,
          h2h: h2h.slice(0, 4).map((match) => ({
            date: match.fixture.date,
            score: `${match.goals.home ?? '-'}-${match.goals.away ?? '-'}`,
            winner:
              match.goals.home === match.goals.away
                ? 'draw'
                : (match.goals.home ?? -1) > (match.goals.away ?? -1)
                  ? match.teams.home.name
                  : match.teams.away.name,
          })),
          form: {
            home: {
              team: fixture.homeTeam,
              streak: homeForm?.form ?? 'N/A',
              wins: homeForm?.fixtures.wins.total ?? 0,
              draws: homeForm?.fixtures.draws.total ?? 0,
              losses: homeForm?.fixtures.loses.total ?? 0,
            },
            away: {
              team: fixture.awayTeam,
              streak: awayForm?.form ?? 'N/A',
              wins: awayForm?.fixtures.wins.total ?? 0,
              draws: awayForm?.fixtures.draws.total ?? 0,
              losses: awayForm?.fixtures.loses.total ?? 0,
            },
          },
          suggestedEvidence: [
            `${fixture.homeTeam} recent form`,
            `${fixture.awayTeam} recent form`,
            `${fixture.homeTeam} vs ${fixture.awayTeam} head-to-head`,
            `${fixture.league} table or injuries`,
          ],
        }
      })
    )

    const prompt = [
      'You are BetClaw Live, a voice-first betting risk copilot.',
      `Track: ${track.name}.`,
      `Temperament: ${track.currentTemperament}.`,
      `Budget remaining: ₦${track.remainingBudget}.`,
      `Target: ₦${track.target}.`,
      `Total P&L: ₦${track.totalPnL}.`,
      session ? `Latest session: #${session.sessionNumber} (${session.status}).` : 'No session has started yet.',
      fixtureCards.length > 0
        ? `Review ${fixtureCards.length} fixtures as separate dossiers. For each one, combine screenshots, form, and H2H before assembling slips.`
        : 'If no fixtures are available, ask the user which leagues or kickoff windows to target.',
      slipCards.length > 0
        ? `Recent slips available: ${slipCards.length}. Focus on bankroll discipline, correlation risk, and concise explanations.`
        : 'No slips have been generated yet. Ask for a slip screenshot or suggest safer next steps.',
    ].join(' ')

    res.json({
      success: true,
      data: {
        track: {
          _id: track._id,
          name: track.name,
          currentTemperament: track.currentTemperament,
          remainingBudget: track.remainingBudget,
          target: track.target,
          totalPnL: track.totalPnL,
          status: track.status,
        },
        session: session
          ? {
            _id: session._id,
            sessionNumber: session.sessionNumber,
            status: session.status,
            allocation: session.allocation,
            totalStaked: session.totalStaked,
          }
          : null,
        fixtures: fixtureCards,
        slips: slipCards,
        systemPrompt: prompt,
      },
    })
  } catch (err) {
    next(err)
  }
})

router.post('/session/start', validate(startSessionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { leagues, objective, periodHours } = req.body as z.infer<typeof startSessionSchema>
    const normalized = normalizeLeagueSelection(leagues)
    const fixtures = await buildFixtureCards(normalized, periodHours)

    res.json({
      success: true,
      data: {
        greeting: `Welcome to BetClaw Live. Tell me the leagues you care about and what you want to achieve. I will shortlist fixtures, build dossiers, and only then assemble slips.`,
        selectedLeagues: normalized,
        objective,
        periodHours,
        fixtures,
        nextPrompt: normalized.length > 0
          ? `I found ${fixtures.length} fixtures across ${normalized.join(', ')} in the next ${periodHours} hours. Pick the fixtures you want in the dossier stage.`
          : 'Tell me the leagues you want to target, for example Premier League and Serie A.',
      },
    })
  } catch (err) {
    next(err)
  }
})

router.post('/analyze', validate(analyzeDossiersSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fixtures } = req.body as z.infer<typeof analyzeDossiersSchema>
    const track = await getActiveTrack(req.user!.userId)

    const slipInputs = fixtures.map((fixture, index) => {
      const pick = choosePrediction(fixture.odds)
      const confidenceScore = scoreFromOdds(pick.odds)

      return {
        slipIndex: index,
        combinedOdds: pick.odds,
        stake: 0,
        potentialReturn: pick.odds,
        confidenceScore,
        games: [
          {
            homeTeam: fixture.homeTeam,
            awayTeam: fixture.awayTeam,
            league: fixture.league,
            kickoffTime: new Date(fixture.kickoffTime),
            prediction: pick.label,
            predictionType: pick.type,
            odds: pick.odds,
            confidenceScore,
          },
        ],
      }
    })

    const verdicts = await runVerdictEngine(
      slipInputs,
      track.currentTemperament as Temperament,
      {
        budget: track.budget,
        remainingBudget: track.remainingBudget,
        target: track.target,
        totalPnL: track.totalPnL,
        sessionCount: track.sessionCount,
      },
      track.verdictModel,
    )

    const analyses = fixtures.map((fixture, index) => {
      const slip = slipInputs[index]
      const verdict = verdicts.get(index)
      const pick = slip.games[0]

      return {
        fixtureId: fixture.fixtureId,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        league: fixture.league,
        kickoffTime: fixture.kickoffTime,
        evidence: fixture.evidence,
        recommendation: {
          prediction: pick.prediction,
          predictionType: pick.predictionType,
          odds: pick.odds,
          confidenceScore: pick.confidenceScore,
        },
        verdict: verdict?.verdict ?? 'bet',
        verdictConfidence: verdict?.confidence ?? pick.confidenceScore,
        verdictReasoning: verdict?.reasoning ?? 'Proceed with measured exposure.',
        analysis: verdict?.analysis ?? {
          overview: 'No model analysis available.',
          oddsAssessment: '',
          combinationRisk: '',
          leagueInsight: '',
          recommendation: '',
          keyRisks: [],
          keyStrengths: [],
          flags: [],
        },
      }
    })

    const approvedCount = analyses.filter((item) => item.verdict !== 'skip').length

    res.json({
      success: true,
      data: {
        analyses,
        prompt: approvedCount > 0
          ? `I have analyzed ${analyses.length} dossiers. ${approvedCount} fixture${approvedCount === 1 ? '' : 's'} look viable. Do you want me to create a slip from the approved fixtures?`
          : 'I analyzed the dossiers and none of the selected fixtures look strong enough to include in a slip yet.',
      },
    })
  } catch (err) {
    next(err)
  }
})

router.post('/create-slip', validate(createSlipSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fixtures } = req.body as z.infer<typeof createSlipSchema>
    const track = await getActiveTrack(req.user!.userId)
    let session = await getOrCreateLiveSession(track, req.user!.userId)
    const existingFixtures = await SlipGame.countDocuments({
      sessionId: session._id,
      externalFixtureId: { $in: fixtures.map((fixture) => fixture.fixtureId) },
    })
    if (existingFixtures > 0) {
      session = await createLiveSession(track, req.user!.userId)
    }

    const selectedFixtures = fixtures.map((fixture) => {
      const pick = choosePrediction(fixture.odds)
      return {
        fixture,
        pick,
        confidenceScore: scoreFromOdds(pick.odds),
      }
    })

    const combinedOdds = Number(
      selectedFixtures.reduce((acc, item) => acc * item.pick.odds, 1).toFixed(2)
    )
    const stakes = calculateStakes(
      [{ index: 0, combinedOdds }],
      session.allocation,
      track.currentTemperament as Temperament,
    )
    const stake = Math.max(1, Math.round(stakes[0]?.stake ?? session.allocation * 0.2))
    const avgConfidence = Math.round(
      selectedFixtures.reduce((acc, item) => acc + item.confidenceScore, 0) / selectedFixtures.length
    )

    const verdictInput = [{
      slipIndex: 0,
      combinedOdds,
      stake,
      potentialReturn: Number((stake * combinedOdds).toFixed(2)),
      confidenceScore: avgConfidence,
      games: selectedFixtures.map((item) => ({
        homeTeam: item.fixture.homeTeam,
        awayTeam: item.fixture.awayTeam,
        league: item.fixture.league,
        kickoffTime: new Date(item.fixture.kickoffTime),
        prediction: item.pick.label,
        predictionType: item.pick.type,
        odds: item.pick.odds,
        confidenceScore: item.confidenceScore,
      })),
    }]

    const verdict = (await runVerdictEngine(
      verdictInput,
      track.currentTemperament as Temperament,
      {
        budget: track.budget,
        remainingBudget: track.remainingBudget,
        target: track.target,
        totalPnL: track.totalPnL,
        sessionCount: track.sessionCount,
      },
      track.verdictModel,
    )).get(0)

    const slip = await BetSlip.create({
      sessionId: session._id,
      trackId: track._id,
      userId: req.user!.userId,
      stake,
      combinedOdds,
      potentialReturn: Number((stake * combinedOdds).toFixed(2)),
      actualReturn: 0,
      confidenceScore: avgConfidence,
      status: SlipStatus.PENDING,
      lastSettlementTime: new Date(
        Math.max(...selectedFixtures.map((item) => new Date(item.fixture.kickoffTime).getTime())) + 110 * 60 * 1000
      ),
      verdict: verdict?.verdict ?? 'bet',
      verdictModel: verdict?.model ?? 'none',
      verdictModelId: verdict?.modelId ?? '',
      verdictModelLabel: verdict?.modelLabel ?? 'System',
      verdictConfidence: verdict?.confidence ?? avgConfidence,
      verdictReasoning: verdict?.reasoning ?? 'Created from approved live dossiers.',
      verdictAnalysis: verdict?.analysis,
    })

    const games = await SlipGame.insertMany(
      selectedFixtures.map((item) => ({
        slipId: slip._id,
        sessionId: session._id,
        externalFixtureId: item.fixture.fixtureId,
        league: item.fixture.league,
        homeTeam: item.fixture.homeTeam,
        awayTeam: item.fixture.awayTeam,
        kickoffTime: new Date(item.fixture.kickoffTime),
        predictionType: item.pick.type,
        prediction: item.pick.label,
        odds: item.pick.odds,
        confidenceScore: item.confidenceScore,
        settlementTime: new Date(new Date(item.fixture.kickoffTime).getTime() + 110 * 60 * 1000),
        result: GameResult.PENDING,
      })),
      { ordered: true }
    )

    session.totalStaked += stake
    await session.save()

    res.status(201).json({
      success: true,
      data: {
        slip: {
          _id: slip._id,
          combinedOdds: slip.combinedOdds,
          stake: slip.stake,
          potentialReturn: slip.potentialReturn,
          status: slip.status,
          confidenceScore: slip.confidenceScore,
          verdict: slip.verdict,
          verdictReasoning: slip.verdictReasoning,
          games: games.map((game) => ({
            homeTeam: game.homeTeam,
            awayTeam: game.awayTeam,
            league: game.league,
            prediction: game.prediction,
            odds: game.odds,
          })),
        },
        prompt: 'Slip created from the approved dossiers. You can review it below or ask me to adjust the exposure.',
      },
    })
  } catch (err) {
    next(err)
  }
})

router.post('/session/token', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!env.GEMINI_API_KEY) {
      throw new AppError(500, 'GEMINI_API_KEY is not configured')
    }

    const client = new GoogleGenAI({
      apiKey: env.GEMINI_API_KEY,
      httpOptions: { apiVersion: 'v1alpha' },
    })

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            sessionResumption: {},
            systemInstruction: 'You are BetClaw Live, a sharp football betting strategy copilot. Start by greeting the user, asking which leagues matter, what bankroll objective they want, and what risk level to keep.',
          },
        },
        httpOptions: { apiVersion: 'v1alpha' },
      },
    })

    res.json({
      success: true,
      data: {
        token: token.name,
        model: LIVE_MODEL,
      },
    })
  } catch (err) {
    next(err)
  }
})

async function buildFixtureCards(selectedLeagues: string[], windowHours = 48): Promise<Array<{
  fixtureId: string
  homeTeam: string
  awayTeam: string
  league: string
  kickoffTime: Date
  odds: {
    home: number
    draw: number
    away: number
    bttsYes: number
    bttsNo: number
    over25: number
    under25: number
  }
  dossierPrompt: string
  h2h: Array<{ date: string; score: string; winner: string }>
  form: {
    home: { team: string; streak: string; wins: number; draws: number; losses: number }
    away: { team: string; streak: string; wins: number; draws: number; losses: number }
  }
  suggestedEvidence: string[]
}>> {
  const fixtures = await getLiveFixtures(selectedLeagues, windowHours)
  const filteredFixtures = selectedLeagues.length > 0
    ? fixtures.filter((fixture) => selectedLeagues.includes(fixture.league))
    : fixtures
  const shortlist = filteredFixtures.slice(0, 6)
  const useFixtureOddsDirectly = env.USE_SYNTHETIC_FIXTURES || env.NODE_ENV === 'development'
  const oddsMap = useFixtureOddsDirectly ? new Map() : await fetchOddsForDate()

  return Promise.all(
    shortlist.map(async (fixture) => {
      const [homeForm, awayForm, h2h] = fixture.homeTeamId && fixture.awayTeamId
        ? await Promise.all([
          fetchTeamForm(fixture.homeTeamId),
          fetchTeamForm(fixture.awayTeamId),
          fetchH2H(fixture.homeTeamId, fixture.awayTeamId, 4),
        ])
        : [null, null, []]

      const liveOdds = oddsMap.get(normaliseTeamKey(fixture.homeTeam, fixture.awayTeam))
      return {
        fixtureId: fixture.fixtureId,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        league: fixture.league,
        kickoffTime: fixture.kickoffTime,
        odds: liveOdds ?? fixture.odds,
        dossierPrompt: `Assess ${fixture.homeTeam} vs ${fixture.awayTeam} using screenshots, form, H2H, and bankroll context before recommending any market.`,
        h2h: h2h.slice(0, 4).map((match) => ({
          date: match.fixture.date,
          score: `${match.goals.home ?? '-'}-${match.goals.away ?? '-'}`,
          winner:
            match.goals.home === match.goals.away
              ? 'draw'
              : (match.goals.home ?? -1) > (match.goals.away ?? -1)
                ? match.teams.home.name
                : match.teams.away.name,
        })),
        form: {
          home: {
            team: fixture.homeTeam,
            streak: homeForm?.form ?? 'N/A',
            wins: homeForm?.fixtures.wins.total ?? 0,
            draws: homeForm?.fixtures.draws.total ?? 0,
            losses: homeForm?.fixtures.loses.total ?? 0,
          },
          away: {
            team: fixture.awayTeam,
            streak: awayForm?.form ?? 'N/A',
            wins: awayForm?.fixtures.wins.total ?? 0,
            draws: awayForm?.fixtures.draws.total ?? 0,
            losses: awayForm?.fixtures.loses.total ?? 0,
          },
        },
        suggestedEvidence: [
          `${fixture.homeTeam} recent form`,
          `${fixture.awayTeam} recent form`,
          `${fixture.homeTeam} vs ${fixture.awayTeam} head-to-head`,
          `${fixture.league} table or injuries`,
        ],
      }
    })
  )
}

async function getLiveFixtures(selectedLeagues: string[], windowHours: number) {
  try {
    const sportsFixtures = await fetchUpcomingFixtures(windowHours)
    if (sportsFixtures.length > 0) {
      return sportsFixtures
    }
  } catch {
    // Fall through to odds fallback.
  }

  const oddsFixtures = await fetchUpcomingOddsFixtures(windowHours)
  const filteredOdds = selectedLeagues.length > 0
    ? oddsFixtures.filter((fixture) => selectedLeagues.includes(fixture.league))
    : oddsFixtures

  if (filteredOdds.length > 0) {
    return filteredOdds
  }

  return buildSyntheticFixtures(selectedLeagues, windowHours)
}

function normalizeLeagueSelection(leagues: string[]): string[] {
  const joined = leagues.join(' ').toLowerCase()
  const matches = Object.entries(leagueAliases)
    .filter(([, aliases]) => aliases.some((alias) => joined.includes(alias)))
    .map(([league]) => league)

  return Array.from(new Set(matches.length > 0 ? matches : leagues.filter(Boolean)))
}

async function getActiveTrack(userId: string) {
  const track = await BetTrack.findOne({ userId, status: 'active' }).sort({ createdAt: -1 })
  if (!track) {
    throw new AppError(404, 'No active track available')
  }

  return track
}

async function getOrCreateLiveSession(track: Awaited<ReturnType<typeof getActiveTrack>>, userId: string) {
  const existing = await BetSession.findOne({
    trackId: track._id,
    userId,
    status: SessionStatus.ACTIVE,
  }).sort({ createdAt: -1 })

  if (existing) {
    return existing
  }

  return createLiveSession(track, userId)
}

async function createLiveSession(track: Awaited<ReturnType<typeof getActiveTrack>>, userId: string) {
  const sessionNumber = track.sessionCount + 1
  const allocation = Math.max(1, Math.round(track.remainingBudget * 0.2))

  const session = await BetSession.create({
    trackId: track._id,
    userId,
    sessionNumber,
    allocation,
    totalStaked: 0,
    totalReturn: 0,
    pnl: 0,
    temperamentSnapshot: track.currentTemperament,
    status: SessionStatus.ACTIVE,
  })

  track.sessionCount = sessionNumber
  await track.save()

  return session
}

function choosePrediction(odds: {
  home: number
  draw: number
  away: number
  bttsYes: number
  bttsNo: number
  over25: number
  under25: number
}) {
  const options = [
    { type: PredictionType.HOME_WIN, label: 'Home Win', odds: odds.home },
    { type: PredictionType.DRAW, label: 'Draw', odds: odds.draw },
    { type: PredictionType.AWAY_WIN, label: 'Away Win', odds: odds.away },
    { type: PredictionType.BTTS_YES, label: 'BTTS Yes', odds: odds.bttsYes },
    { type: PredictionType.BTTS_NO, label: 'BTTS No', odds: odds.bttsNo },
    { type: PredictionType.OVER_25, label: 'Over 2.5', odds: odds.over25 },
    { type: PredictionType.UNDER_25, label: 'Under 2.5', odds: odds.under25 },
  ].filter((option) => Number.isFinite(option.odds) && option.odds > 0)

  options.sort((left, right) => Math.abs(left.odds - 1.75) - Math.abs(right.odds - 1.75))
  return options[0]
}

function scoreFromOdds(odds: number) {
  if (odds <= 1.45) return 84
  if (odds <= 1.7) return 78
  if (odds <= 2.05) return 72
  if (odds <= 2.5) return 66
  if (odds <= 3.2) return 58
  return 50
}

export default router
