import { Router, Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { User } from '../models/User'
import { validate } from '../middleware/validate'
import { env } from '../config/env'
import { AppError } from '../middleware/errorHandler'

const router = Router()

const registerSchema = z.object({
  email:       z.string().email(),
  password:    z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(50),
})

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})

function signToken(userId: string, email: string): string {
  return jwt.sign({ userId, email }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions)
}

// POST /auth/register
router.post('/register', validate(registerSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, displayName } = req.body

    const existing = await User.findOne({ email })
    if (existing) throw new AppError(409, 'Email already registered')

    const user = await User.create({ email, passwordHash: password, displayName })
    const token = signToken(user._id.toString(), user.email)

    res.status(201).json({
      success: true,
      data: { token, user },
    })
  } catch (err) {
    next(err)
  }
})

// POST /auth/login
router.post('/login', validate(loginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body

    const user = await User.findOne({ email })
    if (!user) throw new AppError(401, 'Invalid credentials')

    const valid = await user.comparePassword(password)
    if (!valid) throw new AppError(401, 'Invalid credentials')

    const token = signToken(user._id.toString(), user.email)

    res.json({
      success: true,
      data: { token, user },
    })
  } catch (err) {
    next(err)
  }
})

export default router
