import mongoose, { Document, Schema, Types } from 'mongoose'
import { PredictionType, GameResult } from '../types'

export interface ISlipGame extends Document {
  slipId:             Types.ObjectId
  sessionId:          Types.ObjectId
  externalFixtureId:  string
  league:             string
  homeTeam:           string
  awayTeam:           string
  kickoffTime:        Date
  predictionType:     PredictionType
  prediction:         string
  odds:               number
  confidenceScore:    number
  settlementTime:     Date
  result:             GameResult
  score?:             string
  settledAt?:         Date
  createdAt:          Date
  updatedAt:          Date
}

const SlipGameSchema = new Schema<ISlipGame>(
  {
    slipId:    { type: Schema.Types.ObjectId, ref: 'BetSlip',   required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'BetSession', required: true },

    externalFixtureId: { type: String, required: true },
    league:            { type: String, required: true },
    homeTeam:          { type: String, required: true },
    awayTeam:          { type: String, required: true },
    kickoffTime:       { type: Date,   required: true },

    predictionType: { type: String, enum: Object.values(PredictionType), required: true },
    prediction:     { type: String, required: true },
    odds:           { type: Number, required: true, min: 1 },
    confidenceScore:{ type: Number, required: true, min: 0, max: 100 },

    // Settlement time = kickoffTime + 110 minutes (standard match duration buffer)
    settlementTime: { type: Date, required: true },
    result:         { type: String, enum: Object.values(GameResult), default: GameResult.PENDING },
    score:          { type: String },
    settledAt:      { type: Date },
  },
  { timestamps: true }
)

SlipGameSchema.index({ slipId: 1, result: 1 })
SlipGameSchema.index({ sessionId: 1, result: 1 })
// Prevent same fixture appearing in multiple slips in the same session
SlipGameSchema.index({ sessionId: 1, externalFixtureId: 1 }, { unique: true })

export const SlipGame = mongoose.model<ISlipGame>('SlipGame', SlipGameSchema)
