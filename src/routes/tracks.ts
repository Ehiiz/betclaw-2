import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { BetTrack } from "../models/BetTrack";
import { BetSession } from "../models/BetSession";
import { PulseJob } from "../models/PulseJob";
import { authenticate } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import {
  Temperament,
  TrackStatus,
  DurationType,
  SessionStatus,
  PulseStatus,
} from "../types";
import { logger } from "../config/logger";

const router = Router();
router.use(authenticate);

const createTrackSchema = z.object({
  name: z.string().min(1).max(100),
  budget: z.number().positive("Budget must be positive"),
  target: z.number().positive("Target must be positive"),
  temperament: z.enum([
    Temperament.CONSERVATIVE,
    Temperament.MODERATE,
    Temperament.AGGRESSIVE,
  ]),
  verdictModel: z.enum(["gemini", "gpt-4o", "groq", "claude"]).default("groq"),
  duration: z.object({
    type: z.enum([DurationType.DAYS, DurationType.SESSIONS]),
    value: z.number().int().positive(),
  }),
});

// POST /tracks — create track and immediately start the autonomous loop
router.post(
  "/",
  validate(createTrackSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { name, budget, target, temperament, verdictModel, duration } =
        req.body;

      if (target <= budget) {
        throw new AppError(400, "Target must be greater than initial budget");
      }

      // Calculate endsAt from duration
      const endsAt = new Date();
      if (duration.type === DurationType.DAYS) {
        endsAt.setDate(endsAt.getDate() + duration.value);
      } else {
        // For session-based duration, set a far-future date — engine closes on session count
        endsAt.setFullYear(endsAt.getFullYear() + 10);
      }

      const track = await BetTrack.create({
        userId: new Types.ObjectId(userId),
        name,
        budget,
        remainingBudget: budget,
        target,
        startingTemperament: temperament,
        currentTemperament: temperament,
        verdictModel: verdictModel ?? "gemini",
        duration,
        endsAt,
      });

      // Kick off the autonomous loop asynchronously
      // The loop module is imported lazily to avoid circular deps at startup
      setImmediate(async () => {
        try {
          const { startTrackLoop } = await import("../engines/trackLoop");
          await startTrackLoop(track._id.toString());
        } catch (err) {
          const { logger } = await import("../config/logger");
          logger.error(
            { err, trackId: track._id },
            "Failed to start track loop",
          );
        }
      });

      res.status(201).json({ success: true, data: track });
    } catch (err) {
      next(err);
    }
  },
);

// GET /tracks — list all tracks for user
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracks = await BetTrack.find({ userId: req.user!.userId }).sort({
      createdAt: -1,
    });
    res.json({ success: true, data: tracks, count: tracks.length });
  } catch (err) {
    next(err);
  }
});

// GET /tracks/:id — full track state
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const track = await BetTrack.findOne({
      _id: req.params.id,
      userId: req.user!.userId,
    });
    if (!track) throw new AppError(404, "Track not found");
    res.json({ success: true, data: track });
  } catch (err) {
    next(err);
  }
});

// GET /tracks/:id/summary — dashboard snapshot
router.get(
  "/:id/summary",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const track = await BetTrack.findOne({
        _id: req.params.id,
        userId: req.user!.userId,
      });
      if (!track) throw new AppError(404, "Track not found");

      const progressToTarget =
        ((track.budget + track.totalPnL) / track.target) * 100;
      const budgetUsed = track.budget - track.remainingBudget;

      res.json({
        success: true,
        data: {
          trackId: track._id,
          name: track.name,
          status: track.status,
          currentTemperament: track.currentTemperament,
          budget: track.budget,
          remainingBudget: track.remainingBudget,
          target: track.target,
          totalPnL: track.totalPnL,
          progressToTarget: Math.min(progressToTarget, 100).toFixed(2) + "%",
          budgetUsed,
          sessionCount: track.sessionCount,
          startedAt: track.startedAt,
          endsAt: track.endsAt,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /tracks/:id/history — all sessions with P&L
router.get(
  "/:id/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const track = await BetTrack.findOne({
        _id: req.params.id,
        userId: req.user!.userId,
      });
      if (!track) throw new AppError(404, "Track not found");

      const sessions = await BetSession.find({ trackId: track._id }).sort({
        sessionNumber: 1,
      });

      res.json({
        success: true,
        data: {
          track: {
            _id: track._id,
            name: track.name,
            totalPnL: track.totalPnL,
            sessionCount: track.sessionCount,
          },
          sessions,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /tracks/:id/pause
router.patch(
  "/:id/pause",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const track = await BetTrack.findOne({
        _id: req.params.id,
        userId: req.user!.userId,
      });
      if (!track) throw new AppError(404, "Track not found");
      if (track.status !== TrackStatus.ACTIVE)
        throw new AppError(400, "Only active tracks can be paused");

      track.status = TrackStatus.PAUSED;
      await track.save();

      // Cancel all active BullMQ settlement jobs for this track's sessions
      const { getQueue } = await import("../workers/queues");
      const settlementQueue = getQueue("settlement");
      const pulseQueue = getQueue("pulse");

      // Find all active/settling sessions for this track
      const activeSessions = await BetSession.find({
        trackId: track._id,
        status: {
          $in: [
            SessionStatus.ACTIVE,
            SessionStatus.SETTLING,
            SessionStatus.PULSING,
          ],
        },
      });

      let cancelledJobs = 0;
      for (const session of activeSessions) {
        // Cancel settlement job
        if (session.settlementJobId) {
          try {
            const job = await settlementQueue.getJob(session.settlementJobId);
            if (job) {
              await job.remove();
              cancelledJobs++;
            }
          } catch {
            /* job may already be gone */
          }
        }

        if (session.retryJobId) {
          try {
            const retryJob = await settlementQueue.getJob(session.retryJobId);
            if (retryJob) {
              await retryJob.remove();
              cancelledJobs++;
            }
          } catch {
            /* job may already be gone */
          }
        }

        // Cancel all active pulse jobs for this session
        const pulseJobs = await PulseJob.find({
          sessionId: session._id,
          status: PulseStatus.ACTIVE,
        });
        for (const pulse of pulseJobs) {
          try {
            const job = await pulseQueue.getJob(pulse.bullJobId);
            if (job) {
              await job.remove();
              cancelledJobs++;
            }
          } catch {
            /* job may already be gone */
          }
          pulse.status = PulseStatus.CANCELLED;
          await pulse.save();
        }

        // Mark session as paused-state (keep as active but note track is paused)
        // We don't cancel the session itself — it can resume
      }

      logger.info(
        { trackId: track._id, cancelledJobs, sessions: activeSessions.length },
        "Track paused — jobs cancelled",
      );

      res.json({ success: true, data: track, meta: { cancelledJobs } });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /tracks/:id/resume
router.patch(
  "/:id/resume",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const track = await BetTrack.findOne({
        _id: req.params.id,
        userId: req.user!.userId,
      });
      if (!track) throw new AppError(404, "Track not found");
      if (track.status !== TrackStatus.PAUSED)
        throw new AppError(400, "Only paused tracks can be resumed");

      track.status = TrackStatus.ACTIVE;
      await track.save();

      // Restart the loop
      setImmediate(async () => {
        try {
          const { startTrackLoop } = await import("../engines/trackLoop");
          await startTrackLoop(track._id.toString());
        } catch (err) {
          const { logger } = await import("../config/logger");
          logger.error(
            { err, trackId: track._id },
            "Failed to restart track loop on resume",
          );
        }
      });

      res.json({ success: true, data: track });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
