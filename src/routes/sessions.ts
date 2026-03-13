import { Router, Request, Response, NextFunction } from 'express'
import { BetSession } from '../models/BetSession'
import { BetSlip } from '../models/BetSlip'
import { SlipGame } from '../models/SlipGame'
import { PulseJob } from '../models/PulseJob'
import { BetTrack } from '../models/BetTrack'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { SessionStatus, PulseStatus, GameResult, SlipStatus } from '../types'
import { getQueue } from '../workers/queues'

// ─── Sessions ─────────────────────────────────────────────────────────────────
export const sessionsRouter = Router()
sessionsRouter.use(authenticate)

// GET /tracks/:id/sessions
sessionsRouter.get('/tracks/:trackId/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const track = await BetTrack.findOne({ _id: req.params.trackId, userId: req.user!.userId })
    if (!track) throw new AppError(404, 'Track not found')

    const sessions = await BetSession.find({ trackId: track._id }).sort({ sessionNumber: -1 })
    res.json({ success: true, data: sessions, count: sessions.length })
  } catch (err) {
    next(err)
  }
})

// GET /sessions/:id
sessionsRouter.get('/sessions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await BetSession.findOne({ _id: req.params.id, userId: req.user!.userId })
    if (!session) throw new AppError(404, 'Session not found')

    const slips = await BetSlip.find({ sessionId: session._id })
    const games = await SlipGame.find({ sessionId: session._id })

    // Nest games under their slip
    const slipsWithGames = slips.map(slip => ({
      ...slip.toJSON(),
      games: games.filter(g => g.slipId.toString() === slip._id.toString()),
    }))

    res.json({ success: true, data: { ...session.toJSON(), slips: slipsWithGames } })
  } catch (err) {
    next(err)
  }
})

// POST /sessions/:id/cancel
sessionsRouter.post('/sessions/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await BetSession.findOne({ _id: req.params.id, userId: req.user!.userId })
    if (!session) throw new AppError(404, 'Session not found')

    if (![SessionStatus.ACTIVE, SessionStatus.SETTLING].includes(session.status)) {
      throw new AppError(400, 'Only active or settling sessions can be cancelled')
    }

    session.status = SessionStatus.CANCELLED
    await session.save()

    const settlementQueue = getQueue('settlement')
    for (const jobId of [session.settlementJobId, session.retryJobId].filter(Boolean) as string[]) {
      try {
        const job = await settlementQueue.getJob(jobId)
        if (job) {
          await job.remove()
        }
      } catch { /* job may already be gone */ }
    }

    // Cancel all active pulse jobs for this session
    await PulseJob.updateMany(
      { sessionId: session._id, status: PulseStatus.ACTIVE },
      { status: PulseStatus.CANCELLED }
    )

    res.json({ success: true, data: session })
  } catch (err) {
    next(err)
  }
})

// ─── Slips ────────────────────────────────────────────────────────────────────
export const slipsRouter = Router()
slipsRouter.use(authenticate)

// GET /sessions/:id/slips
slipsRouter.get('/sessions/:sessionId/slips', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await BetSession.findOne({ _id: req.params.sessionId, userId: req.user!.userId })
    if (!session) throw new AppError(404, 'Session not found')

    const slips = await BetSlip.find({ sessionId: session._id })
    res.json({ success: true, data: slips, count: slips.length })
  } catch (err) {
    next(err)
  }
})

// GET /slips/:id
slipsRouter.get('/slips/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slip = await BetSlip.findOne({ _id: req.params.id, userId: req.user!.userId })
    if (!slip) throw new AppError(404, 'Slip not found')

    const games = await SlipGame.find({ slipId: slip._id })
    res.json({ success: true, data: { ...slip.toJSON(), games } })
  } catch (err) {
    next(err)
  }
})

// GET /slips/:id/games
slipsRouter.get('/slips/:id/games', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slip = await BetSlip.findOne({ _id: req.params.id, userId: req.user!.userId })
    if (!slip) throw new AppError(404, 'Slip not found')

    const games = await SlipGame.find({ slipId: slip._id })
    res.json({ success: true, data: games, count: games.length })
  } catch (err) {
    next(err)
  }
})

// ─── Pulses ───────────────────────────────────────────────────────────────────
export const pulsesRouter = Router()
pulsesRouter.use(authenticate)

// GET /sessions/:id/pulses
pulsesRouter.get('/sessions/:sessionId/pulses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await BetSession.findOne({ _id: req.params.sessionId, userId: req.user!.userId })
    if (!session) throw new AppError(404, 'Session not found')

    const pulses = await PulseJob.find({ sessionId: session._id }).sort({ createdAt: -1 })
    res.json({ success: true, data: pulses, count: pulses.length })
  } catch (err) {
    next(err)
  }
})

// POST /pulses/:id/cancel — cancel a pulse, mark game as void, let session proceed
pulsesRouter.post('/pulses/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pulse = await PulseJob.findById(req.params.id)
    if (!pulse) throw new AppError(404, 'Pulse job not found')

    if (pulse.status !== PulseStatus.ACTIVE) {
      throw new AppError(400, 'Pulse is not active')
    }

    // Verify ownership via session
    const session = await BetSession.findOne({ _id: pulse.sessionId, userId: req.user!.userId })
    if (!session) throw new AppError(403, 'Forbidden')

    // Mark pulse cancelled
    pulse.status    = PulseStatus.CANCELLED
    pulse.resolvedAt = new Date()
    await pulse.save()

    // Mark the associated game as void
    await SlipGame.findByIdAndUpdate(pulse.slipGameId, {
      result:    GameResult.VOID,
      settledAt: new Date(),
    })

    // Check if session can now be fully settled
    const { tryFinaliseSession } = await import('../engines/settlementEngine')
    await tryFinaliseSession(session._id.toString())

    res.json({ success: true, message: 'Pulse cancelled — game marked void' })
  } catch (err) {
    next(err)
  }
})
