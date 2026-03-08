import mongoose, { Document, Schema, Types } from 'mongoose'
import { SlipStatus } from '../types'

export interface IBetSlip extends Document {
  sessionId:         Types.ObjectId
  trackId:           Types.ObjectId
  userId:            Types.ObjectId
  stake:             number
  combinedOdds:      number
  potentialReturn:   number
  actualReturn:      number
  confidenceScore:   number
  status:            SlipStatus
  lastSettlementTime: Date
  settledAt?:        Date
  // Verdict Engine fields
  verdict:           'bet' | 'skip' | 'reduce'
  verdictModel:      'gemini' | 'gpt-4o' | 'none'
  verdictConfidence: number
  verdictReasoning:  string
  verdictAnalysis: {
    overview:        string
    oddsAssessment:  string
    combinationRisk: string
    leagueInsight:   string
    recommendation:  string
    keyRisks:        string[]
    keyStrengths:    string[]
    flags:           string[]
  }
  createdAt:  Date
  updatedAt:  Date
}

const AnalysisSchema = new Schema({
  overview:        { type: String, default: '' },
  oddsAssessment:  { type: String, default: '' },
  combinationRisk: { type: String, default: '' },
  leagueInsight:   { type: String, default: '' },
  recommendation:  { type: String, default: '' },
  keyRisks:        { type: [String], default: [] },
  keyStrengths:    { type: [String], default: [] },
  flags:           { type: [String], default: [] },
}, { _id: false })

const BetSlipSchema = new Schema<IBetSlip>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'BetSession', required: true, index: true },
    trackId:   { type: Schema.Types.ObjectId, ref: 'BetTrack',   required: true },
    userId:    { type: Schema.Types.ObjectId, ref: 'User',       required: true },

    stake:           { type: Number, required: true, min: 0 },
    combinedOdds:    { type: Number, required: true, min: 1 },
    potentialReturn: { type: Number, required: true, min: 0 },
    actualReturn:    { type: Number, default: 0 },
    confidenceScore: { type: Number, required: true, min: 0, max: 100 },

    status:             { type: String, enum: Object.values(SlipStatus), default: SlipStatus.PENDING },
    lastSettlementTime: { type: Date, required: true },
    settledAt:          { type: Date },

    // Verdict Engine
    verdict:           { type: String, enum: ['bet', 'skip', 'reduce'], default: 'bet' },
    verdictModel:      { type: String, enum: ['gemini', 'gpt-4o', 'none'], default: 'none' },
    verdictConfidence: { type: Number, default: 50 },
    verdictReasoning:  { type: String, default: '' },
    verdictAnalysis:   { type: AnalysisSchema, default: () => ({}) },
  },
  { timestamps: true }
)

BetSlipSchema.index({ sessionId: 1, status: 1 })

export const BetSlip = mongoose.model<IBetSlip>('BetSlip', BetSlipSchema)
