// ─── Enums ────────────────────────────────────────────────────────────────────

export enum Temperament {
  CONSERVATIVE = 'conservative',
  MODERATE = 'moderate',
  AGGRESSIVE = 'aggressive',
  RESTORATIVE = 'restorative',
}

export enum TrackStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  EXPIRED = 'expired',
}

export enum SessionStatus {
  ACTIVE = 'active',
  SETTLING = 'settling',
  PULSING = 'pulsing',
  SETTLED = 'settled',
  CANCELLED = 'cancelled',
}

export enum SlipStatus {
  PENDING = 'pending',
  WON = 'won',
  LOST = 'lost',
  VOID = 'void',
  PARTIAL = 'partial',
}

export enum GameResult {
  PENDING = 'pending',
  WON = 'won',
  LOST = 'lost',
  VOID = 'void',
}

export enum PredictionType {
  HOME_WIN = '1',
  DRAW = 'X',
  AWAY_WIN = '2',
  BTTS_YES = 'btts_yes',
  BTTS_NO = 'btts_no',
  OVER_25 = 'over_2.5',
  UNDER_25 = 'under_2.5',
  OVER_15 = 'over_1.5',
  UNDER_15 = 'under_1.5',
}

export enum PulseStatus {
  ACTIVE = 'active',
  RESOLVED = 'resolved',
  CANCELLED = 'cancelled',
}

export enum DurationType {
  DAYS = 'days',
  SESSIONS = 'sessions',
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface JwtPayload {
  userId: string
  email: string
  iat?: number
  exp?: number
}

export interface TemperamentConfig {
  slipsMin: number
  slipsMax: number
  gamesPerSlipMin: number
  gamesPerSlipMax: number
  oddsMin: number
  oddsMax: number
  minFixtureScore: number
  allocationMin: number   // percentage as decimal e.g. 0.10
  allocationMax: number
  maxSlipStakePct: number   // max % of session allocation on one slip
}

export interface FixtureScore {
  fixtureId: string
  homeTeam: string
  awayTeam: string
  league: string
  kickoffTime: Date
  confidenceScore: number
  bestPrediction: PredictionType
  odds: number
}

export interface SessionAllocation {
  amount: number
  percentage: number
  urgencyMultiplier: number
}

export interface SlipStake {
  slipIndex: number
  stake: number
  combinedOdds: number
}

export interface RecalibrationResult {
  newTemperament: Temperament
  shouldContinue: boolean
  closeReason?: TrackStatus
  pnlRating: 'big_win' | 'small_win' | 'small_loss' | 'big_loss'
}

// ─── Temperament configuration table ─────────────────────────────────────────

export const TEMPERAMENT_CONFIG: Record<Temperament, TemperamentConfig> = {
  [Temperament.CONSERVATIVE]: {
    slipsMin: 2, slipsMax: 4,
    gamesPerSlipMin: 4, gamesPerSlipMax: 6,
    oddsMin: 1.25, oddsMax: 3.6,
    minFixtureScore: 14,
    allocationMin: 0.10, allocationMax: 0.15,
    maxSlipStakePct: 0.34,
  },
  [Temperament.MODERATE]: {
    slipsMin: 2, slipsMax: 4,
    gamesPerSlipMin: 5, gamesPerSlipMax: 8,
    oddsMin: 1.6, oddsMax: 7.5,
    minFixtureScore: 13,
    allocationMin: 0.15, allocationMax: 0.25,
    maxSlipStakePct: 0.48,
  },
  [Temperament.AGGRESSIVE]: {
    slipsMin: 4, slipsMax: 6,
    gamesPerSlipMin: 6, gamesPerSlipMax: 10,
    oddsMin: 2.4, oddsMax: 20.0,
    minFixtureScore: 10,
    allocationMin: 0.25, allocationMax: 0.40,
    maxSlipStakePct: 0.60,
  },
  [Temperament.RESTORATIVE]: {
    slipsMin: 2, slipsMax: 2,
    gamesPerSlipMin: 3, gamesPerSlipMax: 5,
    oddsMin: 1.2, oddsMax: 2.4,
    minFixtureScore: 16,
    allocationMin: 0.08, allocationMax: 0.12,
    maxSlipStakePct: 0.25,
  },
}

// Temperament escalation ladder (user's startingTemperament is the ceiling)
export const TEMPERAMENT_LADDER: Temperament[] = [
  Temperament.RESTORATIVE,
  Temperament.CONSERVATIVE,
  Temperament.MODERATE,
  Temperament.AGGRESSIVE,
]
