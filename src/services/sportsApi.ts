import { env } from '../config/env'
import { FixtureCache } from '../models/FixtureCache'
import { logger } from '../config/logger'
import { PredictionType } from '../types'

// api-sports.io direct endpoint
const BASE_URL = `https://${env.SPORTS_API_HOST}`

const headers: Record<string, string> = {
  'x-apisports-key': env.SPORTS_API_KEY,
  'Content-Type': 'application/json',
}

// ── Raw fetch — returns full API envelope so we can log errors/paging ─────────
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

// ── Typed fetch — unwraps response array ──────────────────────────────────────
async function apiFetch<T>(path: string): Promise<T[]> {
  const json = await apiFetchRaw(path)
  return (json.response ?? []) as T[]
}

// ─── Fixture types ────────────────────────────────────────────────────────────
export interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string; elapsed: number | null } }
  league: { id: number; name: string; country: string }
  teams: { home: { id: number; name: string }; away: { id: number; name: string } }
  goals: { home: number | null; away: number | null }
  score: { fulltime: { home: number | null; away: number | null } }
}

export interface ApiOdds {
  fixture: { id: number }
  bookmakers: Array<{
    id: number; name: string
    bets: Array<{ id: number; name: string; values: Array<{ value: string; odd: string }> }>
  }>
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
  fixtureId: string; homeTeam: string; awayTeam: string
  homeTeamId: number; awayTeamId: number; league: string; kickoffTime: Date
  odds: { home: number; draw: number; away: number; bttsYes: number; bttsNo: number; over25: number; under25: number }
}

// ─── Fetch upcoming fixtures ──────────────────────────────────────────────────
export async function fetchUpcomingFixtures(windowHours = env.FIXTURE_WINDOW_HOURS): Promise<ProcessedFixture[]> {
  const from = new Date()
  const to = new Date(Date.now() + windowHours * 60 * 60 * 1000)
  const fromStr = from.toISOString().split('T')[0]
  const toStr = to.toISOString().split('T')[0]

  logger.info({ from: fromStr, to: toStr, windowHours }, 'Fetching upcoming fixtures')

  try {
    // api-sports.io requires league+season OR date alone — cannot combine from/to/status freely
    const [fixturesRaw, oddsRaw] = await Promise.all([
      apiFetchRaw(`/fixtures?date=${fromStr}`),
      apiFetchRaw(`/odds?date=${fromStr}&bookmaker=6`),
    ])

    // ── Full raw response logs ────────────────────────────────────────────────
    logger.info({
      results: fixturesRaw.results,
      errors: fixturesRaw.errors,
      paging: fixturesRaw.paging,
      firstRecord: fixturesRaw.response?.[0] ?? 'EMPTY',
    }, '=== RAW FIXTURES RESPONSE ===')

    logger.info({
      results: oddsRaw.results,
      errors: oddsRaw.errors,
      paging: oddsRaw.paging,
      firstRecord: oddsRaw.response?.[0] ?? 'EMPTY',
    }, '=== RAW ODDS RESPONSE ===')

    const fixtures: ApiFixture[] = fixturesRaw.response ?? []
    const oddsData: ApiOdds[] = oddsRaw.response ?? []

    logger.info({ totalFixtures: fixtures.length, totalOdds: oddsData.length }, 'API counts')

    const oddsMap = new Map<number, ApiOdds>()
    oddsData.forEach(o => oddsMap.set(o.fixture.id, o))

    const now = new Date()
    const processed: ProcessedFixture[] = []
    let skippedStarted = 0
    let skippedNoOdds = 0

    for (const f of fixtures) {
      const kickoffTime = new Date(f.fixture.date)

      // Only include fixtures that haven't kicked off yet
      if (kickoffTime <= now) { skippedStarted++; continue }
      if (kickoffTime > to) { continue }

      const fixtureOdds = oddsMap.get(f.fixture.id)
      const extractedOdds = extractOdds(fixtureOdds)

      if (!extractedOdds.home || !extractedOdds.away) { skippedNoOdds++; continue }

      processed.push({
        fixtureId: String(f.fixture.id), homeTeam: f.teams.home.name, awayTeam: f.teams.away.name,
        homeTeamId: f.teams.home.id, awayTeamId: f.teams.away.id, league: f.league.name,
        kickoffTime, odds: extractedOdds,
      })
    }

    logger.info({ totalFixtures: fixtures.length, skippedStarted, skippedNoOdds, withOdds: processed.length, sample: processed[0] ?? 'none' }, 'Processing complete')
    return processed

  } catch (err) {
    logger.error({ err }, 'Failed to fetch fixtures')
    throw err
  }
}

// ─── Fetch team form ──────────────────────────────────────────────────────────
export async function fetchTeamForm(teamId: number, last = 5): Promise<ApiTeamForm | null> {
  try {
    const data = await apiFetch<ApiTeamForm>(`/teams/statistics?team=${teamId}&season=${getCurrentSeason()}&last=${last}`)
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

// ─── Fetch fixture result ─────────────────────────────────────────────────────
export async function fetchFixtureResult(fixtureId: string): Promise<{ finished: boolean; homeGoals: number | null; awayGoals: number | null; score: string } | null> {
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
      await FixtureCache.findOneAndUpdate({ externalFixtureId: fixtureId }, { data: result, fetchedAt: new Date() }, { upsert: true })
    }
    return result
  } catch (err) {
    logger.warn({ err, fixtureId }, 'Could not fetch fixture result')
    return null
  }
}

// ─── Evaluate prediction ──────────────────────────────────────────────────────
export function evaluatePrediction(prediction: string, predictionType: PredictionType, homeGoals: number, awayGoals: number): boolean {
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
function extractOdds(data?: ApiOdds): ProcessedFixture['odds'] {
  const empty = { home: 0, draw: 0, away: 0, bttsYes: 0, bttsNo: 0, over25: 0, under25: 0 }
  if (!data?.bookmakers?.length) return empty
  const bookmaker = data.bookmakers[0]
  const result = { ...empty }
  for (const bet of bookmaker.bets) {
    if (bet.name === 'Match Winner') {
      bet.values.forEach(v => {
        if (v.value === 'Home') result.home = parseFloat(v.odd)
        if (v.value === 'Draw') result.draw = parseFloat(v.odd)
        if (v.value === 'Away') result.away = parseFloat(v.odd)
      })
    }
    if (bet.name === 'Both Teams Score') {
      bet.values.forEach(v => {
        if (v.value === 'Yes') result.bttsYes = parseFloat(v.odd)
        if (v.value === 'No') result.bttsNo = parseFloat(v.odd)
      })
    }
    if (bet.name === 'Goals Over/Under') {
      bet.values.forEach(v => {
        if (v.value === 'Over 2.5') result.over25 = parseFloat(v.odd)
        if (v.value === 'Under 2.5') result.under25 = parseFloat(v.odd)
      })
    }
  }
  return result
}

function getCurrentSeason(): number {
  const now = new Date()
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1
}