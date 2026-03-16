# BetClaw Server

Backend API and worker service for BetClaw, an autonomous football betting intelligence system built with Node.js, TypeScript, Express, MongoDB, and Redis.

## What it does

- Authenticates users with JWT
- Creates and manages autonomous betting tracks
- Generates sessions and slips from football fixtures
- Runs settlement and pulse jobs with BullMQ
- Exposes Swagger API docs for manual testing

## Stack

- Node.js 20+
- TypeScript
- Express
- MongoDB
- Redis
- BullMQ
- Swagger

## Prerequisites

Make sure these are installed before starting:

- Node.js 20 or newer
- npm
- MongoDB
- Redis

If you do not want to install MongoDB and Redis locally, use Docker Compose instead.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env`

Create a `.env` file in the project root:

```env
PORT=3000
NODE_ENV=development

DEPLOY_BRANCH=
DEPLOY_COMMIT=

MONGODB_URI=mongodb://localhost:27017/betclaw
REDIS_URL=redis://localhost:6379

JWT_SECRET=replace-with-a-strong-secret-at-least-16-chars
JWT_EXPIRES_IN=24h

SPORTS_API_KEY=your-api-football-key
SPORTS_API_HOST=v3.football.api-sports.io

ODDS_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=

MIN_STAKE=500
FIXTURE_WINDOW_HOURS=48
USE_SYNTHETIC_FIXTURES=true
RUN_WORKERS_IN_API=true
```

### 3. Start the API

```bash
npm run dev
```

The server will start on `http://localhost:3000`.

### 4. Check that it is running

- Health check: `http://localhost:3000/health`
- Swagger docs: `http://localhost:3000/docs`
- Raw OpenAPI spec: `http://localhost:3000/docs.json`

## Running Workers

By default, the API process also starts workers because `RUN_WORKERS_IN_API=true`.

If you want the API and workers to run separately:

1. Set `RUN_WORKERS_IN_API=false` in `.env`
2. Start the API:

```bash
npm run dev
```

3. Start workers in another terminal:

```bash
npm run worker
```

## Docker Compose

This project includes `docker-compose.yml` for the API, MongoDB, and Redis.

### Start with Docker

1. Create `.env` in the project root
2. Run:

```bash
docker compose up --build
```

Services:

- API: `http://localhost:3000`
- MongoDB: `mongodb://localhost:27017`
- Redis: `redis://localhost:6379`

Inside Docker Compose, the API uses:

- `MONGODB_URI=mongodb://mongo:27017/betclaw`
- `REDIS_URL=redis://redis:6379`

## Available Scripts

- `npm run dev` - start the API in development mode
- `npm run build` - compile TypeScript to `dist/`
- `npm start` - run the compiled production build
- `npm run worker` - start BullMQ workers in development mode
- `npm test` - run tests

## Basic API Flow

Once the server is running, a typical flow is:

1. Register a user with `POST /v1/auth/register`
2. Log in with `POST /v1/auth/login`
3. Use the returned Bearer token for protected routes
4. Create a betting track with `POST /v1/tracks`
5. Monitor sessions, slips, and pulses from the `/v1` endpoints

## Important Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No | API port, defaults to `3000` |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `JWT_SECRET` | Yes | JWT signing secret, minimum 16 characters |
| `SPORTS_API_KEY` | Yes | API-Football key for fixture data |
| `SPORTS_API_HOST` | No | API-Football host, defaults to `v3.football.api-sports.io` |
| `ODDS_API_KEY` | No | Odds provider key |
| `OPENAI_API_KEY` | No | Optional OpenAI integration key |
| `GEMINI_API_KEY` | No | Optional Gemini integration key |
| `MIN_STAKE` | No | Minimum stake amount |
| `FIXTURE_WINDOW_HOURS` | No | Fixture lookahead window |
| `USE_SYNTHETIC_FIXTURES` | No | Set to `true` for development-friendly synthetic fixture flow |
| `RUN_WORKERS_IN_API` | No | Set to `false` to run workers separately |

## Production

For production:

```bash
npm run build
npm start
```

The compiled entrypoint is `dist/index.js`.

## Notes

- Swagger is available at `/docs`
- Most endpoints require a Bearer token
- MongoDB and Redis must be reachable before the app can start
- If environment validation fails, the process exits immediately with the missing variable list
