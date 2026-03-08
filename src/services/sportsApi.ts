import { env } from '../config/env'
import { FixtureCache } from '../models/FixtureCache'
import { logger } from '../config/logger'
import { PredictionType } from '../types'

const BASE_URL = `https://${env.SPORTS_API_HOST}`

const headers: Record<string, string> = {
  'x-apisports-key': env.SPORTS_API_KEY,
  'Content-Type': 'application/json',
}

// ── Raw fetch ─────────────────────────────────────────────────────────────────
async function apiFetchRaw(path: string): Promise<any> {
  const url = `${BASE_URL}${path}`
  logger.debug({ url }, 'Sports API request')
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Sports API error: ${res.status} ${res.statusText}`)
  const json: any = await res.json()
  if (json.errors && Object.keys(json.errors).length > 0) {
    logger.error({ errors: json.errors, path }, 'Sports API returned errors')
    throw new Error(`Sports API errors: ${JSON.stringify(json.errors)}`)
  }
  return json
}

async function apiFetch<T>(path: string): Promise<T[]> {
  const json = await apiFetchRaw(path)
  return (json.response ?? []) as T[]
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string; elapsed: number | null } }
  league: { id: number; name: string; country: string }
  teams: { home: { id: number; name: string; winner?: boolean | null }; away: { id: number; name: string; winner?: boolean | null } }
  goals: { home: number | null; away: number | null }
  score: { fulltime: { home: number | null; away: number | null } }
}

export interface ApiTeamForm {
  team: { id: number; name: string }
  form: string
  fixtures: {
    wins: { home: number; away: number; total: number }
    draws: { home: number; away: number; total: number }
    loses: { home: number; away: number; total: number }
  }
}

export interface ProcessedFixture {
  fixtureId: string
  homeTeam: string
  awayTeam: string
  homeTeamId: number
  awayTeamId: number
  league: string
  leagueId: number      // ADD THIS
  country: string
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
}

// ─── Top league IDs on api-sports.io ──────────────────────────────────────────
// These get a slight confidence boost in curation scoring
const TOP_LEAGUE_IDS = new Set([
  39,   // Premier League
  140,  // La Liga
  78,   // Bundesliga
  135,  // Serie A
  61,   // Ligue 1
  2,    // Champions League
  3,    // Europa League
  848,  // Conference League
  94,   // Primeira Liga
  88,   // Eredivisie
])

// ─── Synthetic odds model ─────────────────────────────────────────────────────
// Since the free plan has no odds data, we generate plausible odds from
// league tier and a base home-advantage model. Real odds can replace this later.
function generateSyntheticOdds(leagueId: number): ProcessedFixture['odds'] {
  // Add slight randomness so every fixture isn't identical
  const r = () => 0.85 + Math.random() * 0.30   // multiplier 0.85–1.15

  const isTop = TOP_LEAGUE_IDS.has(leagueId)

  // Base odds — home advantage model
  // Top leagues: more competitive, draw odds lower, closer home/away
  const home = isTop ? +(1.80 * r()).toFixed(2) : +(2.10 * r()).toFixed(2)
  const draw = isTop ? +(3.40 * r()).toFixed(2) : +(3.20 * r()).toFixed(2)
  const away = isTop ? +(4.20 * r()).toFixed(2) : +(3.80 * r()).toFixed(2)
  const bttsYes = +(1.75 * r()).toFixed(2)
  const bttsNo = +(2.05 * r()).toFixed(2)
  const over25 = +(1.85 * r()).toFixed(2)
  const under25 = +(1.95 * r()).toFixed(2)

  // Ensure minimum odds of 1.10
  const floor = (n: number) => Math.max(1.10, n)

  return {
    home: floor(home),
    draw: floor(draw),
    away: floor(away),
    bttsYes: floor(bttsYes),
    bttsNo: floor(bttsNo),
    over25: floor(over25),
    under25: floor(under25),
  }
}

// ─── Fetch upcoming fixtures ──────────────────────────────────────────────────
export async function fetchUpcomingFixtures(windowHours = env.FIXTURE_WINDOW_HOURS): Promise<ProcessedFixture[]> {
  const now = new Date()
  const to = new Date(Date.now() + windowHours * 60 * 60 * 1000)
  const fromStr = now.toISOString().split('T')[0]

  logger.info({ date: fromStr, windowHours }, 'Fetching upcoming fixtures')

  try {
    const fixturesRaw = await apiFetchRaw(`/fixtures?date=${fromStr}`)

    logger.info({
      results: fixturesRaw.results,
      errors: fixturesRaw.errors,
      firstRecord: fixturesRaw.response?.[0]?.fixture ?? 'EMPTY',
    }, '=== RAW FIXTURES RESPONSE ===')

    const fixtures: ApiFixture[] = fixturesRaw.response ?? []

    let skippedStarted = 0
    const processed: ProcessedFixture[] = []

    for (const f of fixtures) {
      const kickoffTime = new Date(f.fixture.date)

      // Only future fixtures within our window
      if (kickoffTime <= now) { skippedStarted++; continue }
      if (kickoffTime > to) { continue }

      // Odds will be enriched in curationEngine via The Odds API
      // Placeholder zeros here — curation engine overwrites with real/synthetic odds
      processed.push({
        fixtureId: String(f.fixture.id),
        homeTeam: f.teams.home.name,
        awayTeam: f.teams.away.name,
        homeTeamId: f.teams.home.id,
        awayTeamId: f.teams.away.id,
        league: f.league.name,
        leagueId: f.league.id,
        country: f.league.country,
        kickoffTime,
        odds: { home: 0, draw: 0, away: 0, bttsYes: 0, bttsNo: 0, over25: 0, under25: 0 },
      })
    }

    logger.info({
      total: fixtures.length,
      skippedStarted,
      upcoming: processed.length,
      sample: processed[0] ? `${processed[0].homeTeam} vs ${processed[0].awayTeam} (${processed[0].league})` : 'none',
    }, 'Fixture processing complete')

    return processed

  } catch (err) {
    logger.error({ err }, 'Failed to fetch fixtures')
    throw err
  }
}

// ─── Fetch team form ──────────────────────────────────────────────────────────
export async function fetchTeamForm(teamId: number, last = 5): Promise<ApiTeamForm | null> {
  try {
    const data = await apiFetch<ApiTeamForm>(
      `/teams/statistics?team=${teamId}&season=${getCurrentSeason()}&last=${last}`
    )
    return data[0] ?? null
  } catch (err) {
    logger.warn({ err, teamId }, 'Could not fetch team form')
    return null
  }
}

// ─── Fetch H2H ────────────────────────────────────────────────────────────────
export async function fetchH2H(homeId: number, awayId: number, last = 5): Promise<ApiFixture[]> {
  try {
    return await apiFetch<ApiFixture>(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=${last}`)
  } catch (err) {
    logger.warn({ err, homeId, awayId }, 'Could not fetch H2H')
    return []
  }
}

// ─── Fetch fixture result (settlement) ───────────────────────────────────────
export async function fetchFixtureResult(fixtureId: string): Promise<{
  finished: boolean
  homeGoals: number | null
  awayGoals: number | null
  score: string
} | null> {
  const cached = await FixtureCache.findOne({ externalFixtureId: fixtureId })
  if (cached) {
    const data = cached.data as { finished: boolean; homeGoals: number | null; awayGoals: number | null; score: string }
    if (data.finished) return data
  }

  try {
    const fixtures = await apiFetch<ApiFixture>(`/fixtures?id=${fixtureId}`)
    const fixture = fixtures[0]
    if (!fixture) return null

    const status = fixture.fixture.status.short
    const finished = ['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(status)
    const homeGoals = fixture.score.fulltime.home
    const awayGoals = fixture.score.fulltime.away
    const score = homeGoals !== null && awayGoals !== null ? `${homeGoals}-${awayGoals}` : ''
    const result = { finished, homeGoals, awayGoals, score }

    if (finished) {
      await FixtureCache.findOneAndUpdate(
        { externalFixtureId: fixtureId },
        { data: result, fetchedAt: new Date() },
        { upsert: true }
      )
    }
    return result
  } catch (err) {
    logger.warn({ err, fixtureId }, 'Could not fetch fixture result')
    return null
  }
}

// ─── Evaluate prediction ──────────────────────────────────────────────────────
export function evaluatePrediction(
  prediction: string,
  predictionType: PredictionType,
  homeGoals: number,
  awayGoals: number,
): boolean {
  switch (predictionType) {
    case PredictionType.HOME_WIN: return homeGoals > awayGoals
    case PredictionType.DRAW: return homeGoals === awayGoals
    case PredictionType.AWAY_WIN: return awayGoals > homeGoals
    case PredictionType.BTTS_YES: return homeGoals > 0 && awayGoals > 0
    case PredictionType.BTTS_NO: return homeGoals === 0 || awayGoals === 0
    case PredictionType.OVER_25: return (homeGoals + awayGoals) > 2.5
    case PredictionType.UNDER_25: return (homeGoals + awayGoals) < 2.5
    case PredictionType.OVER_15: return (homeGoals + awayGoals) > 1.5
    case PredictionType.UNDER_15: return (homeGoals + awayGoals) < 1.5
    default: return false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getCurrentSeason(): number {
  const now = new Date()
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1
}
