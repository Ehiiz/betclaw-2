import { Types } from 'mongoose'
import { BetTrack } from '../models/BetTrack'
import { BetSession, IBetSession } from '../models/BetSession'
import { BetSlip } from '../models/BetSlip'
import { SlipGame } from '../models/SlipGame'
import { PulseJob } from '../models/PulseJob'
import { getQueue } from '../workers/queues'
import { logger } from '../config/logger'
import { PulseStatus } from '../types'

export interface PurgeSummary {
  cancelledJobs: number
  sessions:      number
  slips:         number
  games:         number
  pulseJobs:     number
}

/**
 * Removes every queued BullMQ job attached to the given sessions and marks their
 * active pulse records cancelled.
 *
 * Shared by track pause (which keeps the documents) and track delete (which does
 * not) — the queue must be drained either way, or a worker will later fire on a
 * session that is paused or gone.
 */
export async function cancelSessionJobs(sessions: IBetSession[]): Promise<number> {
  if (sessions.length === 0) return 0

  const settlementQueue = getQueue('settlement')
  const pulseQueue      = getQueue('pulse')

  let cancelled = 0

  const removeJob = async (queue: ReturnType<typeof getQueue>, jobId?: string) => {
    if (!jobId) return
    try {
      const job = await queue.getJob(jobId)
      if (job) {
        await job.remove()
        cancelled++
      }
    } catch {
      /* job may already be gone */
    }
  }

  for (const session of sessions) {
    await removeJob(settlementQueue, session.settlementJobId)
    await removeJob(settlementQueue, session.retryJobId)

    const pulseJobs = await PulseJob.find({
      sessionId: session._id,
      status:    PulseStatus.ACTIVE,
    })

    for (const pulse of pulseJobs) {
      await removeJob(pulseQueue, pulse.bullJobId)
      pulse.status = PulseStatus.CANCELLED
      await pulse.save()
    }
  }

  return cancelled
}

/**
 * Permanently removes a track and everything hanging off it: sessions, slips,
 * slip games, pulse records, and any still-queued settlement/pulse jobs.
 *
 * Queue jobs are drained *before* the documents disappear so no worker wakes up
 * to a dangling session id. The track document goes last — an in-flight track
 * loop reads it on every step, so its absence is what stops the loop.
 */
export async function purgeTrack(trackId: Types.ObjectId): Promise<PurgeSummary> {
  const sessions   = await BetSession.find({ trackId })
  const sessionIds = sessions.map(session => session._id)

  const cancelledJobs = await cancelSessionJobs(sessions)

  // SlipGame is only reachable through its slip/session, so collect ids first.
  const slips   = await BetSlip.find({ trackId }, { _id: 1 })
  const slipIds = slips.map(slip => slip._id)

  const games = await SlipGame.deleteMany({
    $or: [{ slipId: { $in: slipIds } }, { sessionId: { $in: sessionIds } }],
  })
  const pulseJobs   = await PulseJob.deleteMany({ sessionId: { $in: sessionIds } })
  const deletedSlips = await BetSlip.deleteMany({ trackId })
  const deletedSessions = await BetSession.deleteMany({ trackId })

  await BetTrack.deleteOne({ _id: trackId })

  const summary: PurgeSummary = {
    cancelledJobs,
    sessions:  deletedSessions.deletedCount ?? 0,
    slips:     deletedSlips.deletedCount ?? 0,
    games:     games.deletedCount ?? 0,
    pulseJobs: pulseJobs.deletedCount ?? 0,
  }

  logger.info({ trackId, ...summary }, 'Track purged')

  return summary
}
