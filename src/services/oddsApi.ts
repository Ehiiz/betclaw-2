import { env } from '../config/env'
import { logger } from '../config/logger'

const BASE_URL = 'https://api.the-odds-api.com/v4'

// Sport-specific keys required by The Odds API — generic 'soccer' is NOT valid
const SOCCER_SPORT_KEYS = [
  'soccer_epl',
  'soccer_england_efl_champ',
  'soccer_germany_bundesliga',
  'soccer_italy_serie_a',
  'soccer_spain_la_liga',
  'soccer_france_ligue_one',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
]

export interface OddsGame {
  id: string
  sport_key: string
  commence_time: string
  home_team: string
  away_team: string
  bookmakers: Array<{
    key: string
    title: string
    markets: Array<{
      key: string
      outcomes: Array<{ name: string; price: number }>
    }>
  }>
}

export interface ExtractedOdds {
  home: number; draw: number; away: number
  bttsYes: number; bttsNo: number; over25: number; under25: number
}

export async function fetchOddsForDate(): Promise<Map<string, ExtractedOdds>> {
  const oddsMap = new Map<string, ExtractedOdds>()

  if (!env.ODDS_API_KEY) {
    logger.warn('ODDS_API_KEY not set — skipping real odds')
    return oddsMap
  }

  logger.info({ leagues: SOCCER_SPORT_KEYS.length }, 'Fetching real odds from The Odds API')

  let totalMapped = 0
  let creditsUsed = 0

  const BATCH = 3
  for (let i = 0; i < SOCCER_SPORT_KEYS.length; i += BATCH) {
    const batch = SOCCER_SPORT_KEYS.slice(i, i + BATCH)
    await Promise.all(batch.map(async (sportKey) => {
      try {
        const url1 = `${BASE_URL}/sports/${sportKey}/odds/?apiKey=${env.ODDS_API_KEY}&regions=uk&markets=h2h,totals&oddsFormat=decimal`
        const url2 = `${BASE_URL}/sports/${sportKey}/odds/?apiKey=${env.ODDS_API_KEY}&regions=uk&markets=btts&oddsFormat=decimal`

        const [res1, res2] = await Promise.all([fetch(url1), fetch(url2)])

        const used = res1.headers.get('x-requests-used')
        if (used) creditsUsed = parseInt(used)

        if (res1.status === 404) return // Not in season

        if (!res1.ok) {
          const body = await res1.text()
          logger.warn({ sportKey, status: res1.status, body }, 'Odds API error for league — skipping')
          return
        }

        const games1: OddsGame[] = await res1.json() as OddsGame[]

        // Build btts lookup from second response (best effort — not all leagues support it)
        const bttsLookup = new Map<string, { bttsYes: number; bttsNo: number }>()
        if (res2.ok) {
          const games2: OddsGame[] = await res2.json() as OddsGame[]
          for (const game of games2) {
            const bookmaker = game.bookmakers.find(b => b.key === 'bet365') ?? game.bookmakers[0]
            if (!bookmaker) continue
            const bttsMarket = bookmaker.markets.find(m => m.key === 'btts')
            if (!bttsMarket) continue
            const yes = bttsMarket.outcomes.find(o => o.name === 'Yes')?.price ?? 0
            const no = bttsMarket.outcomes.find(o => o.name === 'No')?.price ?? 0
            bttsLookup.set(normaliseTeamKey(game.home_team, game.away_team), { bttsYes: yes, bttsNo: no })
          }
          logger.debug({ sportKey, bttsFixtures: bttsLookup.size }, 'BTTS odds fetched')
        } else {
          logger.debug({ sportKey, status: res2.status }, 'BTTS not available for league — skipping btts odds')
        }

        // Merge h2h/totals with btts
        for (const game of games1) {
          const extracted = extractOddsFromGame(game)
          if (!extracted.home || !extracted.away) continue
          const key = normaliseTeamKey(game.home_team, game.away_team)
          const btts = bttsLookup.get(key)
          if (btts) {
            extracted.bttsYes = btts.bttsYes
            extracted.bttsNo = btts.bttsNo
          }
          oddsMap.set(key, extracted)
          totalMapped++
        }

        logger.debug({ sportKey, fixtures: games1.length }, 'League odds fetched')
      } catch (err) {
        logger.warn({ err, sportKey }, 'Failed odds fetch for league — skipping')
      }
    }))

    // Wait between batches to avoid rate limiting
    await new Promise(r => setTimeout(r, 500))
  }

  logger.info({
    totalWithRealOdds: totalMapped,
    creditsUsed,
    remaining: 500 - creditsUsed,
  }, 'Odds API complete')

  return oddsMap
}

function extractOddsFromGame(game: OddsGame): ExtractedOdds {
  const result: ExtractedOdds = { home: 0, draw: 0, away: 0, bttsYes: 0, bttsNo: 0, over25: 0, under25: 0 }
  const bookmaker = game.bookmakers.find(b => b.key === 'bet365') ?? game.bookmakers[0]
  if (!bookmaker) return result

  for (const market of bookmaker.markets) {
    if (market.key === 'h2h') {
      for (const o of market.outcomes) {
        if (o.name === game.home_team) result.home = o.price
        if (o.name === game.away_team) result.away = o.price
        if (o.name === 'Draw') result.draw = o.price
      }
    }
    if (market.key === 'btts') {
      for (const o of market.outcomes) {
        if (o.name === 'Yes') result.bttsYes = o.price
        if (o.name === 'No') result.bttsNo = o.price
      }
    }
    if (market.key === 'totals') {
      for (const o of market.outcomes) {
        if (o.name === 'Over') result.over25 = o.price
        if (o.name === 'Under') result.under25 = o.price
      }
    }
  }
  return result
}

export function normaliseTeamKey(home: string, away: string): string {
  return `${home.toLowerCase().trim()}|${away.toLowerCase().trim()}`
}

export function generateSyntheticOdds(league: string): ExtractedOdds {
  const TOP = new Set(['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'UEFA Champions League', 'Europa League', 'Championship', 'Eredivisie', 'Primeira Liga'])
  const r = () => 0.88 + Math.random() * 0.24
  const isTop = TOP.has(league)
  const f = (n: number) => +Math.max(1.10, n).toFixed(2)
  return {
    home: f((isTop ? 1.80 : 2.10) * r()),
    draw: f(3.30 * r()),
    away: f((isTop ? 4.00 : 3.60) * r()),
    bttsYes: f(1.75 * r()),
    bttsNo: f(2.05 * r()),
    over25: f(1.85 * r()),
    under25: f(1.95 * r()),
  }
}
