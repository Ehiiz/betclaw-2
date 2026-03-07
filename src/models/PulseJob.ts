import mongoose, { Document, Schema, Types } from 'mongoose'
import { PulseStatus } from '../types'

export interface IPulseJob extends Document {
  sessionId:    Types.ObjectId
  slipGameId:   Types.ObjectId
  bullJobId:    string
  attemptNumber: number
  nextCheckAt:  Date
  status:       PulseStatus
  resolvedAt?:  Date
  createdAt:    Date
  updatedAt:    Date
}

const PulseJobSchema = new Schema<IPulseJob>(
  {
    sessionId:  { type: Schema.Types.ObjectId, ref: 'BetSession', required: true, index: true },
    slipGameId: { type: Schema.Types.ObjectId, ref: 'SlipGame',   required: true, index: true },
    bullJobId:  { type: String, required: true },

    attemptNumber: { type: Number, required: true, default: 1 },
    nextCheckAt:   { type: Date, required: true },
    status:        { type: String, enum: Object.values(PulseStatus), default: PulseStatus.ACTIVE },
    resolvedAt:    { type: Date },
  },
  { timestamps: true }
)

PulseJobSchema.index({ sessionId: 1, status: 1 })

export const PulseJob = mongoose.model<IPulseJob>('PulseJob', PulseJobSchema)
