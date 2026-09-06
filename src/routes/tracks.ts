import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { BetTrack } from "../models/BetTrack";
import { BetSession } from "../models/BetSession";
import { authenticate } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import {
  Temperament,
  TrackStatus,
  DurationType,
  SessionStatus,
} from "../types";
import { logger } from "../config/logger";
import { cancelSessionJobs, purgeTrack } from "../engines/trackCleanup";

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

      // Drain every queued job for this track's live sessions. The sessions
      // themselves stay put — they can resume.
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

      const cancelledJobs = await cancelSessionJobs(activeSessions);

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

// DELETE /tracks/:id — remove the track and everything derived from it
router.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const track = await BetTrack.findOne({
        _id: req.params.id,
        userId: req.user!.userId,
      });
      if (!track) throw new AppError(404, "Track not found");

      // Halt the autonomous loop before tearing anything down — it re-reads the
      // track between steps and stops as soon as the status is not active.
      if (track.status === TrackStatus.ACTIVE) {
        track.status = TrackStatus.PAUSED;
        await track.save();
      }

      const summary = await purgeTrack(track._id);

      logger.info(
        { trackId: req.params.id, userId: req.user!.userId, ...summary },
        "Track deleted",
      );

      res.json({
        success: true,
        data: { _id: req.params.id, name: track.name, deleted: summary },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
