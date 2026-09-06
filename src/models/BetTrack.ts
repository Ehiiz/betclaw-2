import mongoose, { Document, Schema, Types } from 'mongoose'
import { Temperament, TrackStatus, DurationType } from '../types'
import { VerdictProvider, VERDICT_PROVIDERS } from '../engines/verdictEngine'

export interface IBetTrack extends Document {
  userId:               Types.ObjectId
  name:                 string
  budget:               number
  remainingBudget:      number
  target:               number
  startingTemperament:  Temperament
  currentTemperament:   Temperament
  verdictModel:         VerdictProvider
  duration:             { type: DurationType; value: number }
  status:               TrackStatus
  sessionCount:         number
  totalPnL:             number
  startedAt:            Date
  endsAt:               Date
  closedAt?:            Date
  createdAt:            Date
  updatedAt:            Date
}

const BetTrackSchema = new Schema<IBetTrack>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name:   { type: String, required: true, trim: true },

    budget:          { type: Number, required: true, min: 0 },
    remainingBudget: { type: Number, required: true, min: 0 },
    target:          { type: Number, required: true, min: 0 },

    startingTemperament: {
      type: String,
      enum: Object.values(Temperament).filter(t => t !== Temperament.RESTORATIVE),
      required: true,
    },
    currentTemperament: {
      type: String,
      enum: Object.values(Temperament),
      required: true,
    },
    verdictModel: {
      type:    String,
      enum:    VERDICT_PROVIDERS,
      default: 'gemini',
    },

    duration: {
      type:  { type: String, enum: Object.values(DurationType), required: true },
      value: { type: Number, required: true, min: 1 },
    },

    status:       { type: String, enum: Object.values(TrackStatus), default: TrackStatus.ACTIVE },
    sessionCount: { type: Number, default: 0 },
    totalPnL:     { type: Number, default: 0 },

    startedAt: { type: Date, default: Date.now },
    endsAt:    { type: Date, required: true },
    closedAt:  { type: Date },
  },
  { timestamps: true }
)

// Compound index for user's active tracks
BetTrackSchema.index({ userId: 1, status: 1 })

export const BetTrack = mongoose.model<IBetTrack>('BetTrack', BetTrackSchema)
