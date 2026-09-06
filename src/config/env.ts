import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  PORT:                  z.string().default('3000'),
  NODE_ENV:              z.enum(['development', 'production', 'test']).default('development'),
  DEPLOY_BRANCH:         z.string().optional().default(''),
  DEPLOY_COMMIT:         z.string().optional().default(''),
  MONGODB_URI:           z.string().min(1, 'MONGODB_URI is required'),
  REDIS_URL:             z.string().min(1, 'REDIS_URL is required'),
  JWT_SECRET:            z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN:        z.string().default('24h'),
  SPORTS_API_KEY:        z.string().min(1, 'SPORTS_API_KEY is required'),
  SPORTS_API_HOST:       z.string().default('v3.football.api-sports.io'),
  ODDS_API_KEY:          z.string().default(''),
  OPENAI_API_KEY:        z.string().default(''),
  GEMINI_API_KEY:        z.string().default(''),
  GROQ_API_KEY:          z.string().default(''),
  ANTHROPIC_API_KEY:     z.string().default(''),
  GEMINI_MODEL:          z.string().default('gemini-2.5-flash'),
  OPENAI_MODEL:          z.string().default('gpt-4o'),
  GROQ_MODEL:            z.string().default('llama-3.3-70b-versatile'),
  ANTHROPIC_MODEL:       z.string().default('claude-opus-5'),
  MIN_STAKE:             z.string().transform(Number).default('500'),
  FIXTURE_WINDOW_HOURS:  z.string().transform(Number).default('48'),
  USE_SYNTHETIC_FIXTURES: z.string().optional().transform((value) => value === 'true'),
  RUN_WORKERS_IN_API:    z.string().optional().transform((value) => value !== 'false'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌  Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
