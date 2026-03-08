import { logger } from '../config/logger'
import { env } from '../config/env'
import { Temperament } from '../types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type VerdictResult = 'bet' | 'skip' | 'reduce'
export type VerdictModel = 'gemini' | 'gpt-4o'

export interface SlipVerdict {
  verdict: VerdictResult
  confidence: number        // 0–100
  reasoning: string        // 2–3 sentence summary (short, for badge tooltip)
  analysis: SlipAnalysis  // full structured analysis for the dashboard
  model: VerdictModel  // which model produced this verdict
}

export interface SlipAnalysis {
  overview: string        // 2–3 sentence overall take
  oddsAssessment: string        // are the odds fair value?
  combinationRisk: string        // risk of the multi-game combination
  leagueInsight: string        // comment on league(s) reliability
  recommendation: string        // specific actionable recommendation
  keyRisks: string[]      // bullet point risks
  keyStrengths: string[]      // bullet point strengths
  flags: string[]      // machine-readable concern tags
}

export interface SlipForVerdict {
  slipIndex: number
  combinedOdds: number
  stake: number
  potentialReturn: number
  confidenceScore: number
  games: Array<{
    homeTeam: string
    awayTeam: string
    league: string
    kickoffTime: Date
    prediction: string
    predictionType: string
    odds: number
    confidenceScore: number
  }>
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runVerdictEngine(
  slips: SlipForVerdict[],
  temperament: Temperament,
  trackContext: {
    budget: number
    remainingBudget: number
    target: number
    totalPnL: number
    sessionCount: number
  },
  model: VerdictModel = 'gemini',
): Promise<Map<number, SlipVerdict>> {
  const verdicts = new Map<number, SlipVerdict>()

  const hasGemini = !!env.GEMINI_API_KEY
  const hasOpenAI = !!env.OPENAI_API_KEY

  // Graceful fallback if no keys configured
  if (!hasGemini && !hasOpenAI) {
    logger.warn('No LLM API keys configured — verdict engine disabled, all slips approved')
    slips.forEach(s => verdicts.set(s.slipIndex, buildFallbackVerdict(s.slipIndex)))
    return verdicts
  }

  // Pick model — fall back to whichever key is available
  const selectedModel: VerdictModel =
    model === 'gemini' && hasGemini ? 'gemini' :
      model === 'gpt-4o' && hasOpenAI ? 'gpt-4o' :
        hasGemini ? 'gemini' : 'gpt-4o'

  logger.info({ slipCount: slips.length, temperament, model: selectedModel }, 'Verdict engine starting')

  // Process in batches of 3 to respect rate limits
  const BATCH = 3
  for (let i = 0; i < slips.length; i += BATCH) {
    const batch = slips.slice(i, i + BATCH)
    await Promise.all(batch.map(async slip => {
      try {
        const verdict = selectedModel === 'gemini'
          ? await callGemini(slip, temperament, trackContext)
          : await callOpenAI(slip, temperament, trackContext)

        verdict.model = selectedModel
        verdicts.set(slip.slipIndex, verdict)

        logger.info({
          slipIndex: slip.slipIndex,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reasoning: verdict.reasoning,
          model: selectedModel,
        }, 'Verdict received')

      } catch (err) {
        logger.warn({ err, slipIndex: slip.slipIndex }, 'Verdict failed — defaulting to bet')
        verdicts.set(slip.slipIndex, buildFallbackVerdict(slip.slipIndex))
      }
    }))
  }

  const summary = {
    bet: [...verdicts.values()].filter(v => v.verdict === 'bet').length,
    reduce: [...verdicts.values()].filter(v => v.verdict === 'reduce').length,
    skip: [...verdicts.values()].filter(v => v.verdict === 'skip').length,
    model: selectedModel,
  }
  logger.info({ summary }, 'Verdict engine complete')

  return verdicts
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

async function callGemini(
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: { budget: number; remainingBudget: number; target: number; totalPnL: number; sessionCount: number },
): Promise<SlipVerdict> {
  // Use @google/genai SDK — same pattern as confirmed working projects
  const { GoogleGenAI } = await import('@google/genai')
  const genAI = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
    contents: [{ role: 'user', parts: [{ text: buildPrompt(slip, temperament, ctx) }] }],
  })

  const content = result.text
  if (!content) throw new Error('Empty Gemini response')

  return parseVerdictResponse(content, 'gemini')
}

// ─── OpenAI call ──────────────────────────────────────────────────────────────

async function callOpenAI(
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: { budget: number; remainingBudget: number; target: number; totalPnL: number; sessionCount: number },
): Promise<SlipVerdict> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(slip, temperament, ctx) },
      ],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI error: ${res.status} — ${err}`)
  }

  const data: any = await res.json()
  const content = data.choices?.[0]?.message?.content

  if (!content) throw new Error('Empty OpenAI response')

  return parseVerdictResponse(content, 'gpt-4o')
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are BetClaw's analytical engine — an expert football betting analyst.
You evaluate bet slips and return structured JSON verdicts with detailed analysis.
Be analytical, concise, realistic, and data-driven.
Consider odds value, combination risk, league reliability, and bankroll health.
Always return valid JSON matching the exact schema requested. No markdown, no extra text.
CRITICAL: Keep every string value brief — the entire JSON response must fit within 500 tokens.`
function buildPrompt(
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: { budget: number; remainingBudget: number; target: number; totalPnL: number; sessionCount: number },
): string {
  const gamesText = slip.games.map((g, i) =>
    `Game ${i + 1}: ${g.homeTeam} vs ${g.awayTeam}
  League: ${g.league}
  Kickoff: ${new Date(g.kickoffTime).toUTCString()}
  Prediction: ${g.predictionType} → "${g.prediction}" @ odds ${g.odds}
  Data confidence: ${g.confidenceScore}/100`
  ).join('\n\n')

  const budgetPct = ((ctx.remainingBudget / ctx.budget) * 100).toFixed(1)
  const pnlStr = ctx.totalPnL >= 0 ? `+₦${ctx.totalPnL} profit` : `-₦${Math.abs(ctx.totalPnL)} loss`

  return `Analyse this football bet slip. IMPORTANT: Every string in your JSON must be short — reasoning max 2 sentences, all analysis fields max 1 sentence, keyRisks/keyStrengths max 5 words each, flags are single words. Total response must be under 500 tokens.

## SLIP
Combined odds: ${slip.combinedOdds}x
Proposed stake: ₦${slip.stake}
Potential return: ₦${slip.potentialReturn}
Avg confidence score: ${slip.confidenceScore}/100

## GAMES
${gamesText}

## TRACK CONTEXT
Temperament: ${temperament}
Budget remaining: ${budgetPct}% (₦${ctx.remainingBudget} of ₦${ctx.budget})
Overall P&L: ${pnlStr}
Sessions completed: ${ctx.sessionCount}
Target: ₦${ctx.target}

## ANALYSIS INSTRUCTIONS
For each game, draw on your knowledge of these specific teams to assess:
- Current form (last 5 matches), recent results, and momentum
- Head-to-head record between these two sides
- Key injuries or suspensions to important players if known
- Home/away performance trends for each team this season
- League position and what's at stake for each team (title race, relegation, European spots)
- Whether the predicted outcome (${slip.games.map(g => g.predictionType).join(', ')}) is consistent with recent form and historical patterns
Use this real team knowledge to validate or challenge the system's confidence score.
Be direct — if a team is in poor form or the prediction looks wrong based on what you know, say so.

## REQUIRED JSON RESPONSE
Return ONLY this JSON structure, no other text:
{
  "verdict": "bet" | "skip" | "reduce",
  "confidence": <integer 0-100>,
  "reasoning": "<2-3 sentence verdict summary>",
  "analysis": {
    "overview": "<2 sentences max>",
    "oddsAssessment": "<1 sentence>",
    "combinationRisk": "<1 sentence>",
    "leagueInsight": "<1 sentence>",
    "recommendation": "<1 sentence>",
    "keyRisks": ["<risk 1>", "<risk 2>"],
    "keyStrengths": ["<strength 1>", "<strength 2>"],
    "flags": ["<tag 1>", "<tag 2>"]
  }
}

verdict:
- "bet" = proceed as planned
- "reduce" = bet but with lower stake (engine will cap at 20% of session allocation)
- "skip" = do not place this bet`
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseVerdictResponse(content: string, model: VerdictModel): SlipVerdict {
  let clean = content.replace(/```json|```/g, '').trim()

  // Log raw response for debugging
  logger.debug({ raw: clean.slice(0, 200) }, 'Gemini raw response')

  // Try to extract complete JSON object first
  const jsonMatch = clean.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    clean = jsonMatch[0]
  } else {
    // Gemini truncated — attempt to repair by closing open braces/brackets
    const openBraces = (clean.match(/\{/g) || []).length
    const closeBraces = (clean.match(/\}/g) || []).length
    const openBrackets = (clean.match(/\[/g) || []).length
    const closeBrackets = (clean.match(/\]/g) || []).length

    // Close any open arrays first, then objects
    clean += ']'.repeat(Math.max(0, openBrackets - closeBrackets))
    clean += '}'.repeat(Math.max(0, openBraces - closeBraces))

    logger.warn({ repaired: clean.slice(-50) }, 'Gemini response truncated — attempted JSON repair')
  }

  let parsed: any
  try {
    parsed = JSON.parse(clean)
  } catch {
    logger.warn({ clean: clean.slice(0, 150) }, 'JSON parse failed — extracting fields manually')
    const verdictMatch = clean.match(/"verdict"\s*:\s*"(bet|skip|reduce)"/)
    const confidenceMatch = clean.match(/"confidence"\s*:\s*(\d+)/)
    const reasoningMatch = clean.match(/"reasoning"\s*:\s*"([^"]{0,300})"/)

    // Also try to extract any analysis fields that made it through before truncation
    const overviewMatch = clean.match(/"overview"\s*:\s*"([^"]{0,300})"/)
    const oddsMatch = clean.match(/"oddsAssessment"\s*:\s*"([^"]{0,300})"/)
    const comboMatch = clean.match(/"combinationRisk"\s*:\s*"([^"]{0,300})"/)
    const leagueMatch = clean.match(/"leagueInsight"\s*:\s*"([^"]{0,300})"/)
    const recommendMatch = clean.match(/"recommendation"\s*:\s*"([^"]{0,300})"/)

    const reasoning = reasoningMatch?.[1] ?? ''

    parsed = {
      verdict: verdictMatch?.[1] ?? 'bet',
      confidence: confidenceMatch?.[1] ? parseInt(confidenceMatch[1]) : 50,
      reasoning,
      analysis: {
        overview: overviewMatch?.[1] ?? reasoning,  // fall back to reasoning text
        oddsAssessment: oddsMatch?.[1] ?? '',
        combinationRisk: comboMatch?.[1] ?? '',
        leagueInsight: leagueMatch?.[1] ?? '',
        recommendation: recommendMatch?.[1] ?? '',
        keyRisks: [],
        keyStrengths: [],
        flags: [],
      }
    }
  }

  const verdict: VerdictResult = ['bet', 'skip', 'reduce'].includes(parsed.verdict)
    ? parsed.verdict : 'bet'

  const analysis: SlipAnalysis = {
    overview: String(parsed.analysis?.overview || 'Analysis unavailable.').slice(0, 400),
    oddsAssessment: String(parsed.analysis?.oddsAssessment || '').slice(0, 300),
    combinationRisk: String(parsed.analysis?.combinationRisk || '').slice(0, 300),
    leagueInsight: String(parsed.analysis?.leagueInsight || '').slice(0, 300),
    recommendation: String(parsed.analysis?.recommendation || '').slice(0, 200),
    keyRisks: (Array.isArray(parsed.analysis?.keyRisks) ? parsed.analysis.keyRisks : []).slice(0, 5),
    keyStrengths: (Array.isArray(parsed.analysis?.keyStrengths) ? parsed.analysis.keyStrengths : []).slice(0, 5),
    flags: (Array.isArray(parsed.analysis?.flags) ? parsed.analysis.flags : []).slice(0, 5),
  }

  return {
    verdict,
    confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 50)),
    reasoning: String(parsed.reasoning || '').slice(0, 300),
    analysis,
    model,
  }
}

// ─── Fallback verdict (no LLM key) ───────────────────────────────────────────

function buildFallbackVerdict(slipIndex: number): SlipVerdict {
  return {
    verdict: 'bet',
    confidence: 50,
    reasoning: 'Verdict engine not configured — proceeding without LLM analysis.',
    model: 'gemini',
    analysis: {
      overview: 'No LLM analysis available — verdict engine is disabled.',
      oddsAssessment: 'Configure GEMINI_API_KEY or OPENAI_API_KEY to enable analysis.',
      combinationRisk: 'Unknown — no analysis performed.',
      leagueInsight: 'Unknown — no analysis performed.',
      recommendation: 'Add an LLM API key to enable the verdict engine.',
      keyRisks: ['Verdict engine disabled'],
      keyStrengths: [],
      flags: ['no_llm_key'],
    },
  }
}
