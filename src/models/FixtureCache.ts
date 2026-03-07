import mongoose, { Document, Schema } from 'mongoose'

export interface IFixtureCache extends Document {
  externalFixtureId: string
  data:              Record<string, unknown>
  fetchedAt:         Date
}

const FixtureCacheSchema = new Schema<IFixtureCache>({
  externalFixtureId: { type: String, required: true, unique: true, index: true },
  data:              { type: Schema.Types.Mixed, required: true },
  fetchedAt:         { type: Date, default: Date.now },
})

// TTL index — documents auto-expire after 2 hours
FixtureCacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 7200 })

export const FixtureCache = mongoose.model<IFixtureCache>('FixtureCache', FixtureCacheSchema)
