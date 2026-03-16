import type { ProcessedFixture } from './sportsApi'

export function buildSyntheticFixtures(leagues: string[], windowHours = 48): ProcessedFixture[] {
  const selected = leagues.length > 0 ? leagues : ['Premier League', 'UEFA Champions League', 'Serie A']
  const now = Date.now()

  return selected.flatMap((league, index) => {
    const templates = syntheticTeamsForLeague(league)
    return templates.slice(0, 3).map((pair, pairIndex) => {
      const kickoff = new Date(now + (index * 3 + pairIndex + 1) * Math.max(4, Math.floor(windowHours / 3)) * 60 * 60 * 1000)
      const home = Number((1.65 + ((index + pairIndex) % 4) * 0.18).toFixed(2))
      const draw = Number((3.2 + ((index + pairIndex) % 3) * 0.15).toFixed(2))
      const away = Number((4.1 + ((index + pairIndex) % 4) * 0.25).toFixed(2))

      return {
        fixtureId: `synthetic-${league.toLowerCase().replace(/\s+/g, '-')}-${pairIndex + 1}`,
        homeTeam: pair[0],
        awayTeam: pair[1],
        homeTeamId: 0,
        awayTeamId: 0,
        league,
        kickoffTime: kickoff,
        odds: {
          home,
          draw,
          away,
          bttsYes: Number((1.72 + pairIndex * 0.07).toFixed(2)),
          bttsNo: Number((1.88 + pairIndex * 0.06).toFixed(2)),
          over25: Number((1.8 + pairIndex * 0.05).toFixed(2)),
          under25: Number((1.95 + pairIndex * 0.05).toFixed(2)),
        },
      }
    })
  })
}

function syntheticTeamsForLeague(league: string): Array<[string, string]> {
  switch (league) {
    case 'Premier League':
      return [['Arsenal', 'Brighton'], ['Chelsea', 'Everton'], ['Liverpool', 'Brentford']]
    case 'UEFA Champions League':
      return [['Real Madrid', 'Inter'], ['Bayern Munich', 'PSG'], ['Arsenal', 'Barcelona']]
    case 'Serie A':
      return [['Inter', 'Torino'], ['Juventus', 'Atalanta'], ['Milan', 'Roma']]
    case 'Bundesliga':
      return [['Bayern Munich', 'Mainz'], ['Leverkusen', 'Freiburg'], ['Dortmund', 'Augsburg']]
    case 'La Liga':
      return [['Barcelona', 'Betis'], ['Real Madrid', 'Valencia'], ['Atletico Madrid', 'Sevilla']]
    default:
      return [['Team Alpha', 'Team Beta'], ['Team Gamma', 'Team Delta'], ['Team Epsilon', 'Team Zeta']]
  }
}
