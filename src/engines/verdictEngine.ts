import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { Temperament } from "../types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VerdictResult = "bet" | "skip" | "reduce";

/** Providers the verdict engine can route a slip to. */
export type VerdictProvider = "gemini" | "gpt-4o" | "groq" | "claude";

/** What gets stamped on a slip — a provider, or 'none' when no LLM analysed it. */
export type VerdictModel = VerdictProvider | "none";

export interface SlipVerdict {
  verdict: VerdictResult;
  confidence: number; // 0–100
  reasoning: string; // 2–3 sentence summary (short, for badge tooltip)
  analysis: SlipAnalysis; // full structured analysis for the dashboard
  model: VerdictModel; // which provider produced this verdict
  modelId: string; // exact model that ran, e.g. 'claude-opus-5'
  modelLabel: string; // display name for the dashboard, e.g. 'Claude'
}

export interface SlipAnalysis {
  overview: string; // 2–3 sentence overall take
  oddsAssessment: string; // are the odds fair value?
  combinationRisk: string; // risk of the multi-game combination
  leagueInsight: string; // comment on league(s) reliability
  recommendation: string; // specific actionable recommendation
  keyRisks: string[]; // bullet point risks
  keyStrengths: string[]; // bullet point strengths
  flags: string[]; // machine-readable concern tags
}

export interface TrackContext {
  budget: number;
  remainingBudget: number;
  target: number;
  totalPnL: number;
  sessionCount: number;
}

export interface SlipForVerdict {
  slipIndex: number;
  combinedOdds: number;
  stake: number;
  potentialReturn: number;
  confidenceScore: number;
  games: Array<{
    homeTeam: string;
    awayTeam: string;
    league: string;
    kickoffTime: Date;
    prediction: string;
    predictionType: string;
    odds: number;
    confidenceScore: number;
  }>;
}

// ─── Provider registry ───────────────────────────────────────────────

type ProviderCall = (
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: TrackContext,
) => Promise<SlipVerdict>;

interface ProviderSpec {
  label: string; // shown on the dashboard
  apiKey: () => string; // '' when unconfigured
  modelId: () => string; // exact model string sent to the provider
  call: ProviderCall;
}

const PROVIDERS: Record<VerdictProvider, ProviderSpec> = {
  gemini: {
    label: "Gemini",
    apiKey: () => env.GEMINI_API_KEY,
    modelId: () => env.GEMINI_MODEL,
    call: callGemini,
  },
  "gpt-4o": {
    label: "GPT-4o",
    apiKey: () => env.OPENAI_API_KEY,
    modelId: () => env.OPENAI_MODEL,
    call: callOpenAI,
  },
  groq: {
    label: "Groq",
    apiKey: () => env.GROQ_API_KEY,
    modelId: () => env.GROQ_MODEL,
    call: callGroq,
  },
  claude: {
    label: "Claude",
    apiKey: () => env.ANTHROPIC_API_KEY,
    modelId: () => env.ANTHROPIC_MODEL,
    call: callClaude,
  },
};

/** Fallback order when the requested provider has no key — Gemini is the house default. */
const PROVIDER_FALLBACK_ORDER: VerdictProvider[] = [
  "gemini",
  "claude",
  "groq",
  "gpt-4o",
];

export const VERDICT_PROVIDERS = Object.keys(PROVIDERS) as VerdictProvider[];

function isConfigured(provider: VerdictProvider): boolean {
  return !!PROVIDERS[provider].apiKey();
}

/** Use the requested provider when it has a key, otherwise the first configured fallback. */
function resolveProvider(requested: VerdictProvider): VerdictProvider | null {
  if (isConfigured(requested)) return requested;

  const fallback = PROVIDER_FALLBACK_ORDER.find(isConfigured) ?? null;
  if (fallback) {
    logger.warn(
      { requested, fallback },
      "Requested verdict provider has no API key — falling back",
    );
  }
  return fallback;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runVerdictEngine(
  slips: SlipForVerdict[],
  temperament: Temperament,
  trackContext: TrackContext,
  model: VerdictProvider = "groq",
): Promise<Map<number, SlipVerdict>> {
  const verdicts = new Map<number, SlipVerdict>();

  const provider = resolveProvider(model);

  // Graceful fallback if no provider is configured at all
  if (!provider) {
    logger.warn(
      "No LLM API keys configured — verdict engine disabled, all slips approved",
    );
    slips.forEach((s) =>
      verdicts.set(s.slipIndex, buildFallbackVerdict(s.slipIndex)),
    );
    return verdicts;
  }

  const spec = PROVIDERS[provider];
  const modelId = spec.modelId();

  logger.info(
    { slipCount: slips.length, temperament, provider, modelId },
    "Verdict engine starting",
  );

  // Process in batches of 3 to respect rate limits
  const BATCH = 3;
  for (let i = 0; i < slips.length; i += BATCH) {
    const batch = slips.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (slip) => {
        try {
          const verdict = await spec.call(slip, temperament, trackContext);
          verdicts.set(slip.slipIndex, verdict);

          logger.info(
            {
              slipIndex: slip.slipIndex,
              verdict: verdict.verdict,
              confidence: verdict.confidence,
              reasoning: verdict.reasoning,
              provider,
              modelId: verdict.modelId,
            },
            "Verdict received",
          );
        } catch (err) {
          logger.warn(
            { err, slipIndex: slip.slipIndex, provider },
            "Verdict failed — defaulting to bet",
          );
          verdicts.set(slip.slipIndex, buildFallbackVerdict(slip.slipIndex));
        }
      }),
    );
  }

  const summary = {
    bet: [...verdicts.values()].filter((v) => v.verdict === "bet").length,
    reduce: [...verdicts.values()].filter((v) => v.verdict === "reduce").length,
    skip: [...verdicts.values()].filter((v) => v.verdict === "skip").length,
    provider,
    modelId,
  };
  logger.info({ summary }, "Verdict engine complete");

  return verdicts;
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

async function callGemini(
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: TrackContext,
): Promise<SlipVerdict> {
  // Use @google/genai SDK — same pattern as confirmed working projects
  const { GoogleGenAI } = await import("@google/genai");
  const genAI = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const modelId = env.GEMINI_MODEL;

  const result = await genAI.models.generateContent({
    model: modelId,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
    contents: [
      { role: "user", parts: [{ text: buildPrompt(slip, temperament, ctx) }] },
    ],
  });

  const content = result.text;
  if (!content) throw new Error("Empty Gemini response");

  return parseVerdictResponse(content, "gemini", modelId);
}

// ─── OpenAI call ──────────────────────────────────────────────────────────────

async function callOpenAI(
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: TrackContext,
): Promise<SlipVerdict> {
  return callOpenAICompatible({
    provider: "gpt-4o",
    url: "https://api.openai.com/v1/chat/completions",
    apiKey: env.OPENAI_API_KEY,
    modelId: env.OPENAI_MODEL,
    slip,
    temperament,
    ctx,
  });
}

// ─── Groq call ────────────────────────────────────────────────────────────────

async function callGroq(
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: TrackContext,
): Promise<SlipVerdict> {
  // Groq exposes an OpenAI-compatible chat completions endpoint
  return callOpenAICompatible({
    provider: "groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    apiKey: env.GROQ_API_KEY,
    modelId: env.GROQ_MODEL,
    slip,
    temperament,
    ctx,
  });
}

/** Shared transport for the OpenAI-shaped providers (OpenAI, Groq). */
async function callOpenAICompatible(opts: {
  provider: VerdictProvider;
  url: string;
  apiKey: string;
  modelId: string;
  slip: SlipForVerdict;
  temperament: Temperament;
  ctx: TrackContext;
}): Promise<SlipVerdict> {
  const { provider, url, apiKey, modelId, slip, temperament, ctx } = opts;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(slip, temperament, ctx) },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `${PROVIDERS[provider].label} error: ${res.status} — ${err}`,
    );
  }

  const data: any = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) throw new Error(`Empty ${PROVIDERS[provider].label} response`);

  return parseVerdictResponse(content, provider, modelId);
}

// ─── Claude call ──────────────────────────────────────────────────────────────

async function callClaude(
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: TrackContext,
): Promise<SlipVerdict> {
  const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
  const client = new AnthropicSDK({ apiKey: env.ANTHROPIC_API_KEY });
  const modelId = env.ANTHROPIC_MODEL;

  const response = await client.beta.messages.create({
    model: modelId,
    max_tokens: 4096,
    // Betting analysis is a short, well-specified task — low effort keeps latency
    // and cost down while adaptive thinking stays on by default.
    output_config: { effort: "low" },
    // Route around safety refusals instead of losing the slip's verdict entirely.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(slip, temperament, ctx) }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Claude declined this slip (${response.stop_details?.category ?? "unspecified"})`,
    );
  }

  // content is a discriminated union — thinking blocks are skipped
  const content = response.content
    .filter(
      (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!content) throw new Error("Empty Claude response");

  // The model that actually answered may differ from the one requested when a
  // fallback fired — report what ran.
  return parseVerdictResponse(content, "claude", response.model || modelId);
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are BetClaw's analytical engine — an expert football betting analyst.
You evaluate bet slips and return structured JSON verdicts with detailed analysis.
Be analytical, concise, realistic, and data-driven.
Consider odds value, combination risk, league reliability, and bankroll health.
Always return valid JSON matching the exact schema requested. No markdown, no extra text.
CRITICAL: Keep every string value brief — the entire JSON response must fit within 500 tokens.`;
function buildPrompt(
  slip: SlipForVerdict,
  temperament: Temperament,
  ctx: {
    budget: number;
    remainingBudget: number;
    target: number;
    totalPnL: number;
    sessionCount: number;
  },
): string {
  const gamesText = slip.games
    .map(
      (g, i) =>
        `Game ${i + 1}: ${g.homeTeam} vs ${g.awayTeam}
  League: ${g.league}
  Kickoff: ${new Date(g.kickoffTime).toUTCString()}
  Prediction: ${g.predictionType} → "${g.prediction}" @ odds ${g.odds}
  Data confidence: ${g.confidenceScore}/100`,
    )
    .join("\n\n");

  const budgetPct = ((ctx.remainingBudget / ctx.budget) * 100).toFixed(1);
  const pnlStr =
    ctx.totalPnL >= 0
      ? `+₦${ctx.totalPnL} profit`
      : `-₦${Math.abs(ctx.totalPnL)} loss`;

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
- Whether the predicted outcome (${slip.games.map((g) => g.predictionType).join(", ")}) is consistent with recent form and historical patterns
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
- "skip" = do not place this bet`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseVerdictResponse(
  content: string,
  provider: VerdictProvider,
  modelId: string,
): SlipVerdict {
  let clean = content.replace(/```json|```/g, "").trim();

  // Log raw response for debugging
  logger.debug(
    { provider, modelId, raw: clean.slice(0, 200) },
    "Verdict raw response",
  );

  // Try to extract complete JSON object first
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    clean = jsonMatch[0];
  } else {
    // Response truncated — attempt to repair by closing open braces/brackets
    const openBraces = (clean.match(/\{/g) || []).length;
    const closeBraces = (clean.match(/\}/g) || []).length;
    const openBrackets = (clean.match(/\[/g) || []).length;
    const closeBrackets = (clean.match(/\]/g) || []).length;

    // Close any open arrays first, then objects
    clean += "]".repeat(Math.max(0, openBrackets - closeBrackets));
    clean += "}".repeat(Math.max(0, openBraces - closeBraces));

    logger.warn(
      { provider, repaired: clean.slice(-50) },
      "Verdict response truncated — attempted JSON repair",
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch {
    logger.warn(
      { provider, clean: clean.slice(0, 150) },
      "JSON parse failed — extracting fields manually",
    );
    const verdictMatch = clean.match(/"verdict"\s*:\s*"(bet|skip|reduce)"/);
    const confidenceMatch = clean.match(/"confidence"\s*:\s*(\d+)/);
    const reasoningMatch = clean.match(/"reasoning"\s*:\s*"([^"]{0,300})"/);

    // Also try to extract any analysis fields that made it through before truncation
    const overviewMatch = clean.match(/"overview"\s*:\s*"([^"]{0,300})"/);
    const oddsMatch = clean.match(/"oddsAssessment"\s*:\s*"([^"]{0,300})"/);
    const comboMatch = clean.match(/"combinationRisk"\s*:\s*"([^"]{0,300})"/);
    const leagueMatch = clean.match(/"leagueInsight"\s*:\s*"([^"]{0,300})"/);
    const recommendMatch = clean.match(
      /"recommendation"\s*:\s*"([^"]{0,300})"/,
    );

    const reasoning = reasoningMatch?.[1] ?? "";

    parsed = {
      verdict: verdictMatch?.[1] ?? "bet",
      confidence: confidenceMatch?.[1] ? parseInt(confidenceMatch[1]) : 50,
      reasoning,
      analysis: {
        overview: overviewMatch?.[1] ?? reasoning, // fall back to reasoning text
        oddsAssessment: oddsMatch?.[1] ?? "",
        combinationRisk: comboMatch?.[1] ?? "",
        leagueInsight: leagueMatch?.[1] ?? "",
        recommendation: recommendMatch?.[1] ?? "",
        keyRisks: [],
        keyStrengths: [],
        flags: [],
      },
    };
  }

  const verdict: VerdictResult = ["bet", "skip", "reduce"].includes(
    parsed.verdict,
  )
    ? parsed.verdict
    : "bet";

  const analysis: SlipAnalysis = {
    overview: String(
      parsed.analysis?.overview || "Analysis unavailable.",
    ).slice(0, 400),
    oddsAssessment: String(parsed.analysis?.oddsAssessment || "").slice(0, 300),
    combinationRisk: String(parsed.analysis?.combinationRisk || "").slice(
      0,
      300,
    ),
    leagueInsight: String(parsed.analysis?.leagueInsight || "").slice(0, 300),
    recommendation: String(parsed.analysis?.recommendation || "").slice(0, 200),
    keyRisks: (Array.isArray(parsed.analysis?.keyRisks)
      ? parsed.analysis.keyRisks
      : []
    ).slice(0, 5),
    keyStrengths: (Array.isArray(parsed.analysis?.keyStrengths)
      ? parsed.analysis.keyStrengths
      : []
    ).slice(0, 5),
    flags: (Array.isArray(parsed.analysis?.flags)
      ? parsed.analysis.flags
      : []
    ).slice(0, 5),
  };

  return {
    verdict,
    confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 50)),
    reasoning: String(parsed.reasoning || "").slice(0, 300),
    analysis,
    model: provider,
    modelId,
    modelLabel: PROVIDERS[provider].label,
  };
}

// ─── Fallback verdict (no LLM key) ───────────────────────────────────────────

function buildFallbackVerdict(slipIndex: number): SlipVerdict {
  return {
    verdict: "bet",
    confidence: 50,
    reasoning:
      "Verdict engine not configured — proceeding without LLM analysis.",
    model: "none",
    modelId: "",
    modelLabel: "System",
    analysis: {
      overview: "No LLM analysis available — verdict engine is disabled.",
      oddsAssessment:
        "Configure GEMINI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY or OPENAI_API_KEY to enable analysis.",
      combinationRisk: "Unknown — no analysis performed.",
      leagueInsight: "Unknown — no analysis performed.",
      recommendation: "Add an LLM API key to enable the verdict engine.",
      keyRisks: ["Verdict engine disabled"],
      keyStrengths: [],
      flags: ["no_llm_key"],
    },
  };
}
