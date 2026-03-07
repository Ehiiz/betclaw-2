import swaggerJsdoc from 'swagger-jsdoc'

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'BetClaw API',
      version: '1.0.0',
      description: `
## BetClaw — Autonomous Football Betting Intelligence System

BetClaw is a fully autonomous engine. Once you create a **BetTrack**, the system:
1. Fetches upcoming football fixtures from API-Football
2. Scores each fixture using odds attractiveness + team form + H2H data
3. Curates games into bet slips based on your temperament
4. Stakes intelligently across slips using odds-weighted distribution
5. Arms a settlement timer — checks results automatically when games end
6. Recalibrates temperament and starts the next session immediately

**You only need to create the track. Everything else is automatic.**

## Authentication
All endpoints (except \`/auth/*\`) require a Bearer JWT token:
\`\`\`
Authorization: Bearer <your_token>
\`\`\`
Get your token by calling \`POST /v1/auth/login\`.

## Temperament Levels
| Level | Slips/Session | Games/Slip | Combined Odds Target | Allocation |
|---|---|---|---|---|
| conservative | 2–3 | 2–3 | 1.5–2.5 | 10–15% |
| moderate | 3–4 | 3–4 | 2.5–6.0 | 15–25% |
| aggressive | 4–6 | 4–6 | 6.0–18.0 | 25–40% |
| restorative | 2 | 2 | 1.4–2.0 | 8–12% (auto, after big loss) |
      `,
      contact: {
        name: 'BetClaw Support',
      },
    },
    servers: [
      { url: 'http://localhost:3000/v1', description: 'Local development' },
      { url: 'https://api.betclaw.com/v1', description: 'Production' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        // ── Auth ──────────────────────────────────────────────────────────────
        RegisterRequest: {
          type: 'object',
          required: ['email', 'password', 'displayName'],
          properties: {
            email:       { type: 'string', format: 'email', example: 'john@example.com' },
            password:    { type: 'string', minLength: 8, example: 'SecurePass123' },
            displayName: { type: 'string', example: 'John Doe' },
          },
        },
        LoginRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email:    { type: 'string', format: 'email', example: 'john@example.com' },
            password: { type: 'string', example: 'SecurePass123' },
          },
        },
        AuthResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
                user: { $ref: '#/components/schemas/User' },
              },
            },
          },
        },
        User: {
          type: 'object',
          properties: {
            _id:         { type: 'string', example: '664a1f2e3c4d5e6f7a8b9c0d' },
            email:       { type: 'string', example: 'john@example.com' },
            displayName: { type: 'string', example: 'John Doe' },
            createdAt:   { type: 'string', format: 'date-time' },
          },
        },

        // ── BetTrack ──────────────────────────────────────────────────────────
        CreateTrackRequest: {
          type: 'object',
          required: ['name', 'budget', 'target', 'temperament', 'duration'],
          properties: {
            name: {
              type: 'string',
              example: 'Q2 Football Run',
              description: 'A friendly label for your track',
            },
            budget: {
              type: 'number',
              example: 50000,
              description: 'Your starting bankroll in ₦. This is the total capital BetClaw will manage.',
            },
            target: {
              type: 'number',
              example: 80000,
              description: 'Your profit target in ₦. Must be greater than budget. Track closes as COMPLETED when reached.',
            },
            temperament: {
              type: 'string',
              enum: ['conservative', 'moderate', 'aggressive'],
              example: 'moderate',
              description: `Your risk appetite. This sets the CEILING — BetClaw can go lower (e.g. restorative after a big loss) but never higher than your starting temperament.
              
- **conservative**: Low variance. Small stakes, short odds, 2–3 games per slip. Slow steady build.
- **moderate**: Balanced. Medium stakes and odds. 3–4 games per slip.
- **aggressive**: High variance. Larger stakes, longer odds, 4–6 games per slip. Faster target chase.`,
            },
            duration: {
              type: 'object',
              required: ['type', 'value'],
              properties: {
                type: {
                  type: 'string',
                  enum: ['days', 'sessions'],
                  example: 'sessions',
                  description: 'Whether the track runs for a number of calendar days or a fixed number of sessions.',
                },
                value: {
                  type: 'integer',
                  example: 10,
                  description: 'How many days or sessions the track should run before expiring.',
                },
              },
            },
          },
        },
        BetTrack: {
          type: 'object',
          properties: {
            _id:                  { type: 'string', example: '664a1f2e3c4d5e6f7a8b9c0d' },
            userId:               { type: 'string', example: '664a1f2e3c4d5e6f7a8b9c0e' },
            name:                 { type: 'string', example: 'Q2 Football Run' },
            budget:               { type: 'number', example: 50000 },
            remainingBudget:      { type: 'number', example: 42000 },
            target:               { type: 'number', example: 80000 },
            startingTemperament:  { type: 'string', example: 'moderate' },
            currentTemperament:   { type: 'string', example: 'conservative', description: 'Live state — may differ from starting after recalibration' },
            duration:             { type: 'object', properties: { type: { type: 'string' }, value: { type: 'integer' } } },
            status:               { type: 'string', enum: ['active', 'paused', 'completed', 'failed', 'expired'], example: 'active' },
            sessionCount:         { type: 'integer', example: 3 },
            totalPnL:             { type: 'number', example: -8000, description: 'Cumulative profit/loss across all settled sessions' },
            startedAt:            { type: 'string', format: 'date-time' },
            endsAt:               { type: 'string', format: 'date-time' },
          },
        },
        TrackSummary: {
          type: 'object',
          properties: {
            trackId:            { type: 'string' },
            name:               { type: 'string' },
            status:             { type: 'string' },
            currentTemperament: { type: 'string' },
            budget:             { type: 'number', example: 50000 },
            remainingBudget:    { type: 'number', example: 42000 },
            target:             { type: 'number', example: 80000 },
            totalPnL:           { type: 'number', example: -8000 },
            progressToTarget:   { type: 'string', example: '53.33%' },
            budgetUsed:         { type: 'number', example: 8000 },
            sessionCount:       { type: 'integer', example: 3 },
            startedAt:          { type: 'string', format: 'date-time' },
            endsAt:             { type: 'string', format: 'date-time' },
          },
        },

        // ── BetSession ────────────────────────────────────────────────────────
        BetSession: {
          type: 'object',
          properties: {
            _id:                   { type: 'string' },
            trackId:               { type: 'string' },
            sessionNumber:         { type: 'integer', example: 3 },
            allocation:            { type: 'number', example: 8400, description: 'Total budget assigned to this session by the Allocation Engine' },
            totalStaked:           { type: 'number', example: 8200 },
            totalReturn:           { type: 'number', example: 0 },
            pnl:                   { type: 'number', example: -8200 },
            temperamentSnapshot:   { type: 'string', example: 'moderate', description: 'Temperament at the time this session was created' },
            status:                { type: 'string', enum: ['active', 'settling', 'pulsing', 'settled', 'cancelled'], example: 'settled' },
            settledAt:             { type: 'string', format: 'date-time' },
            createdAt:             { type: 'string', format: 'date-time' },
          },
        },

        // ── BetSlip ───────────────────────────────────────────────────────────
        BetSlip: {
          type: 'object',
          properties: {
            _id:                { type: 'string' },
            sessionId:          { type: 'string' },
            stake:              { type: 'number', example: 3200, description: 'Amount staked — set by the Staking Engine using odds-weighted distribution' },
            combinedOdds:       { type: 'number', example: 3.45, description: 'Product of all game odds in this slip' },
            potentialReturn:    { type: 'number', example: 11040, description: 'stake × combinedOdds' },
            actualReturn:       { type: 'number', example: 0, description: 'Actual return after settlement. 0 if lost.' },
            confidenceScore:    { type: 'number', example: 72.4, description: '0–100 average confidence score of all games in this slip' },
            status:             { type: 'string', enum: ['pending', 'won', 'lost', 'void', 'partial'], example: 'lost' },
            lastSettlementTime: { type: 'string', format: 'date-time', description: 'Latest game end time — when settlement timer fires' },
            games:              { type: 'array', items: { $ref: '#/components/schemas/SlipGame' } },
          },
        },

        // ── SlipGame ──────────────────────────────────────────────────────────
        SlipGame: {
          type: 'object',
          properties: {
            _id:               { type: 'string' },
            slipId:            { type: 'string' },
            externalFixtureId: { type: 'string', example: '1035674', description: 'API-Football fixture ID — used to fetch live results' },
            league:            { type: 'string', example: 'Premier League' },
            homeTeam:          { type: 'string', example: 'Arsenal' },
            awayTeam:          { type: 'string', example: 'Chelsea' },
            kickoffTime:       { type: 'string', format: 'date-time' },
            predictionType:    { type: 'string', enum: ['1', 'X', '2', 'btts_yes', 'btts_no', 'over_2.5', 'under_2.5', 'over_1.5', 'under_1.5'] },
            prediction:        { type: 'string', example: '1', description: 'The specific selection made by the Curation Engine' },
            odds:              { type: 'number', example: 1.85 },
            confidenceScore:   { type: 'number', example: 74, description: '0–100 score from fixture scoring: odds attractiveness + form + H2H' },
            settlementTime:    { type: 'string', format: 'date-time', description: 'kickoffTime + 110 minutes' },
            result:            { type: 'string', enum: ['pending', 'won', 'lost', 'void'], example: 'lost' },
            score:             { type: 'string', example: '1-2', description: 'Final score once settled' },
          },
        },

        // ── PulseJob ──────────────────────────────────────────────────────────
        PulseJob: {
          type: 'object',
          properties: {
            _id:           { type: 'string' },
            sessionId:     { type: 'string' },
            slipGameId:    { type: 'string' },
            attemptNumber: { type: 'integer', example: 2 },
            nextCheckAt:   { type: 'string', format: 'date-time', description: 'When the next result check is scheduled' },
            status:        { type: 'string', enum: ['active', 'resolved', 'cancelled'], example: 'active' },
          },
        },

        // ── Errors ────────────────────────────────────────────────────────────
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'Invalid or expired token' },
          },
        },
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data:    { type: 'object' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],

    // ── Paths ─────────────────────────────────────────────────────────────────
    paths: {
      // AUTH
      '/auth/register': {
        post: {
          tags: ['Auth'],
          summary: 'Register a new user',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } } } },
          responses: {
            201: { description: 'User registered successfully', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
            409: { description: 'Email already registered', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login and receive JWT token',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
          responses: {
            200: { description: 'Login successful', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
            401: { description: 'Invalid credentials' },
          },
        },
      },

      // TRACKS
      '/tracks': {
        post: {
          tags: ['BetTracks'],
          summary: 'Create a BetTrack — starts the autonomous engine immediately',
          description: `Creates a new BetTrack and immediately triggers the autonomous loop:
1. Allocation Engine calculates session budget
2. Curation Engine fetches & scores fixtures, builds slips
3. Staking Engine distributes stakes across slips
4. Settlement timer armed for when games end
5. After settlement, Recalibration Engine adjusts temperament and starts next session automatically`,
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateTrackRequest' } } } },
          responses: {
            201: { description: 'Track created and autonomous loop started', content: { 'application/json': { schema: { $ref: '#/components/schemas/BetTrack' } } } },
            400: { description: 'Validation error (e.g. target must be greater than budget)' },
          },
        },
        get: {
          tags: ['BetTracks'],
          summary: 'List all your BetTracks',
          responses: {
            200: { description: 'List of tracks', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/BetTrack' } }, count: { type: 'integer' } } } } } },
          },
        },
      },
      '/tracks/{id}': {
        get: {
          tags: ['BetTracks'],
          summary: 'Get a single track with full state',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: '664a1f2e3c4d5e6f7a8b9c0d' }],
          responses: {
            200: { description: 'Track detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/BetTrack' } } } },
            404: { description: 'Track not found' },
          },
        },
      },
      '/tracks/{id}/summary': {
        get: {
          tags: ['BetTracks'],
          summary: 'Dashboard snapshot — progress, P&L, temperament',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Track summary', content: { 'application/json': { schema: { $ref: '#/components/schemas/TrackSummary' } } } },
          },
        },
      },
      '/tracks/{id}/history': {
        get: {
          tags: ['BetTracks'],
          summary: 'Full session history with P&L breakdown',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'All sessions for this track', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { track: { $ref: '#/components/schemas/BetTrack' }, sessions: { type: 'array', items: { $ref: '#/components/schemas/BetSession' } } } } } } } } },
          },
        },
      },
      '/tracks/{id}/pause': {
        patch: {
          tags: ['BetTracks'],
          summary: 'Pause an active track',
          description: 'Halts the autonomous loop after the current session settles. Resume at any time.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Track paused' },
            400: { description: 'Track is not active' },
          },
        },
      },
      '/tracks/{id}/resume': {
        patch: {
          tags: ['BetTracks'],
          summary: 'Resume a paused track',
          description: 'Restarts the autonomous loop immediately from the Curation Engine.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Track resumed — loop restarted' },
            400: { description: 'Track is not paused' },
          },
        },
      },

      // SESSIONS
      '/tracks/{trackId}/sessions': {
        get: {
          tags: ['BetSessions'],
          summary: 'List all sessions for a track',
          parameters: [{ name: 'trackId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Sessions list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/BetSession' } } } } } } },
          },
        },
      },
      '/sessions/{id}': {
        get: {
          tags: ['BetSessions'],
          summary: 'Get session detail with all slips and games nested',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Session with nested slips and games', content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/BetSession' }, { type: 'object', properties: { slips: { type: 'array', items: { $ref: '#/components/schemas/BetSlip' } } } }] } } } },
          },
        },
      },
      '/sessions/{id}/cancel': {
        post: {
          tags: ['BetSessions'],
          summary: 'Cancel an active or settling session',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Session cancelled' },
            400: { description: 'Session cannot be cancelled in its current state' },
          },
        },
      },

      // SLIPS
      '/sessions/{sessionId}/slips': {
        get: {
          tags: ['BetSlips'],
          summary: 'List all slips in a session',
          description: 'Slips are created automatically by the Curation Engine — no manual creation.',
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Slips list with confidence scores and stakes', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/BetSlip' } } } } } } },
          },
        },
      },
      '/slips/{id}': {
        get: {
          tags: ['BetSlips'],
          summary: 'Get slip detail with all constituent games',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Slip with nested games', content: { 'application/json': { schema: { $ref: '#/components/schemas/BetSlip' } } } },
          },
        },
      },
      '/slips/{id}/games': {
        get: {
          tags: ['BetSlips'],
          summary: 'List all games in a slip with odds, predictions and results',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Games list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/SlipGame' } } } } } } },
          },
        },
      },

      // PULSES
      '/sessions/{sessionId}/pulses': {
        get: {
          tags: ['Settlement & Pulses'],
          summary: 'List active pulse jobs for a session',
          description: 'Pulse jobs are created when a game result is unavailable at settlement time. They retry every 30min then hourly until resolved.',
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Active pulse jobs', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/PulseJob' } } } } } } },
          },
        },
      },
      '/pulses/{id}/cancel': {
        post: {
          tags: ['Settlement & Pulses'],
          summary: 'Cancel a pulse — marks the game as void and lets the session proceed',
          description: 'Use this if a game result is taking too long and you want the session to settle without it. The game will be marked VOID — won slips that contained this game will have their odds recalculated without it.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Pulse cancelled, game marked void, session proceeds' },
            400: { description: 'Pulse is not active' },
            403: { description: 'Forbidden — pulse does not belong to your account' },
          },
        },
      },
    },
  },
  apis: [],
}

export const swaggerSpec = swaggerJsdoc(options)
