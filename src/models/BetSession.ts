import mongoose, { Document, Schema, Types } from 'mongoose'
import { Temperament, SessionStatus } from '../types'

export interface IBetSession extends Document {
  trackId:              Types.ObjectId
  userId:               Types.ObjectId
  sessionNumber:        number
  allocation:           number
  totalStaked:          number
  totalReturn:          number
  pnl:                  number
  temperamentSnapshot:  Temperament
  status:               SessionStatus
  settlementJobId?:     string
  retryJobId?:          string
  lastSettlementAttempt?: Date
  settledAt?:           Date
  createdAt:            Date
  updatedAt:            Date
}

const BetSessionSchema = new Schema<IBetSession>(
  {
    trackId:  { type: Schema.Types.ObjectId, ref: 'BetTrack',  required: true, index: true },
    userId:   { type: Schema.Types.ObjectId, ref: 'User',      required: true, index: true },

    sessionNumber: { type: Number, required: true },
    allocation:    { type: Number, required: true, min: 0 },
    totalStaked:   { type: Number, default: 0 },
    totalReturn:   { type: Number, default: 0 },
    pnl:           { type: Number, default: 0 },

    temperamentSnapshot: { type: String, enum: Object.values(Temperament), required: true },
    status:              { type: String, enum: Object.values(SessionStatus), default: SessionStatus.ACTIVE },

    settlementJobId:       { type: String },
    retryJobId:            { type: String },
    lastSettlementAttempt: { type: Date },
    settledAt:             { type: Date },
  },
  { timestamps: true }
)

BetSessionSchema.index({ trackId: 1, sessionNumber: 1 })
BetSessionSchema.index({ trackId: 1, status: 1 })

export const BetSession = mongoose.model<IBetSession>('BetSession', BetSessionSchema)
