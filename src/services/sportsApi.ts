import { env } from '../config/env'
import { FixtureCache } from '../models/FixtureCache'
import { logger } from '../config/logger'
import { PredictionType } from '../types'
import { buildSyntheticFixtures } from './syntheticFixtures'

const BASE_URL = `https://${env.SPORTS_API_HOST}`

const headers: Record<string, string> = {
  'x-apisports-key': env.SPORTS_API_KEY,
  'Content-Type': 'application/json',
}

const teamFormCache = new Map<string, { expiresAt: number; value: ApiTeamForm | null }>()
const h2hCache = new Map<string, { expiresAt: number; value: ApiFixture[] }>()
const CACHE_TTL_MS = 15 * 60 * 1000

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



// ─── Fetch upcoming fixtures ──────────────────────────────────────────────────
export async function fetchUpcomingFixtures(windowHours = env.FIXTURE_WINDOW_HOURS): Promise<ProcessedFixture[]> {
  if (env.USE_SYNTHETIC_FIXTURES || env.NODE_ENV === 'development') {
    logger.info({ windowHours }, 'Using synthetic fixtures in non-production mode')
    return buildSyntheticFixtures([], windowHours)
  }

  const now = new Date()
  const to = new Date(Date.now() + windowHours * 60 * 60 * 1000)

  // Fetch today AND tomorrow to avoid missing late-evening fixtures
  const todayStr = now.toISOString().split('T')[0]
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split('T')[0]

  logger.info({ today: todayStr, tomorrow: tomorrowStr, windowHours }, 'Fetching upcoming fixtures')

  try {
    // Fetch both dates in parallel
    const [todayRaw, tomorrowRaw] = await Promise.all([
      apiFetchRaw(`/fixtures?date=${todayStr}`),
      apiFetchRaw(`/fixtures?date=${tomorrowStr}`),
    ])

    logger.info({
      todayResults: todayRaw.results,
      tomorrowResults: tomorrowRaw.results,
    }, '=== RAW FIXTURES RESPONSE ===')

    const allFixtures: ApiFixture[] = [
      ...(todayRaw.response ?? []),
      ...(tomorrowRaw.response ?? []),
    ]

    // Deduplicate by fixture ID (in case a fixture appears in both)
    const seen = new Set<number>()
    const fixtures = allFixtures.filter(f => {
      if (seen.has(f.fixture.id)) return false
      seen.add(f.fixture.id); return true
    })

    let skippedStarted = 0
    const processed: ProcessedFixture[] = []

    for (const f of fixtures) {
      const kickoffTime = new Date(f.fixture.date)

      // Only future fixtures within our window
      if (kickoffTime <= now) { skippedStarted++; continue }
      if (kickoffTime > to) { continue }

      processed.push({
        fixtureId: String(f.fixture.id),
        homeTeam: f.teams.home.name,
        awayTeam: f.teams.away.name,
        homeTeamId: f.teams.home.id,
        awayTeamId: f.teams.away.id,
        league: f.league.name,
        kickoffTime,
        odds: { home: 0, draw: 0, away: 0, bttsYes: 0, bttsNo: 0, over25: 0, under25: 0 },
      })
    }

    logger.info({
      totalFetched: fixtures.length,
      skippedStarted,
      upcoming: processed.length,
      leagues: [...new Set(processed.map(f => f.league))].slice(0, 10),
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
  const cacheKey = `${teamId}:${last}`
  const cached = teamFormCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const seasons = candidateSeasons()

  try {
    for (const season of seasons) {
      try {
        const data = await apiFetch<ApiTeamForm>(`/teams/statistics?team=${teamId}&season=${season}`)
        const value = data[0] ?? null
        teamFormCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value })
        return value
      } catch (err) {
        if (isPlanError(err) || isRateLimitError(err)) {
          logger.warn({ err, teamId, season }, 'Team form fallback attempt failed')
          continue
        }
        throw err
      }
    }
  } catch (err) {
    logger.warn({ err, teamId }, 'Could not fetch team form')
  }

  teamFormCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: null })
  return null
}

// ─── Fetch H2H ────────────────────────────────────────────────────────────────
export async function fetchH2H(homeId: number, awayId: number, last = 5): Promise<ApiFixture[]> {
  const cacheKey = `${homeId}:${awayId}:${last}`
  const cached = h2hCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  try {
    const fixtures = await apiFetch<ApiFixture>(`/fixtures/headtohead?h2h=${homeId}-${awayId}`)
    const value = fixtures.slice(0, last)
    h2hCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value })
    return value
  } catch (err) {
    logger.warn({ err, homeId, awayId }, 'Could not fetch H2H')
    h2hCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: [] })
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

function candidateSeasons(): number[] {
  const current = getCurrentSeason()
  return Array.from(new Set([current, 2024, 2023, 2022]))
}

function isPlanError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('"plan"')
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('"rateLimit"')
}
