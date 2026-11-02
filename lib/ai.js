// lib/ai.js — 3-Tier Gemini Gateway, Dynamic ESM Singleton & Audio Transcription
"use strict";

const U = require("./util");
const { estimateCostUsd } = require("../config");
const Db = require("./db");
const Billing = require("../services/billing");
const Switches = require("../services/aiSwitches");

// Model chains (ARCHITECTURE_MANIFEST.md §AI routing, model eval 2026-10-25):
// text-only calls start on Flash-Lite (same accuracy, ~45% cheaper, price fixed in 2027);
// audio and image calls start on 3.6 Flash (Flash-Lite misses fields on voice notes).
const TEXT_TIERS = [
  "gemini-3.5-flash-lite", // Tier 1 (Primary)
  "gemini-3.6-flash", // Tier 2 (Fallback 1)
  "gemini-3.8-flash" // Tier 3 (Fallback 2)
];
const MEDIA_TIERS = [
  "gemini-3.6-flash", // Tier 1 (Primary)
  "gemini-3.8-flash", // Tier 2 (Fallback 1)
  "gemini-3.5-flash-lite" // Tier 3 (Fallback 2)
];
// Kept for callers that need "the default text model" (eval script, search telemetry).
const TIERS = TEXT_TIERS;

/** True when any part of the request carries audio, image or video bytes. */
function hasMedia(contents) {
  const list = Array.isArray(contents) ? contents : [contents];
  return list.some((c) =>
    (c?.parts || []).some((p) => /^(audio|image|video)\//.test(p?.inlineData?.mimeType || "") || p?.fileData)
  );
}

/** Whether a request carries a voice note (it counts against the plan's voice allowance, not the text one). */
function hasAudio(contents) {
  const list = Array.isArray(contents) ? contents : [contents];
  const audio = (p) => /^audio\//.test(p?.inlineData?.mimeType || p?.fileData?.mimeType || "");
  return list.some((c) => audio(c) || (c?.parts || []).some(audio));
}

/** The model chain for one request: a route may pin its own, otherwise media decides. */
function tiersFor(route, contents) {
  if (route.tiers) return route.tiers;
  return hasMedia(contents) ? MEDIA_TIERS : TEXT_TIERS;
}

// Retries on a temporary error per model (not on quota), with a short wait before each retry (100 ms, then 200 ms).
const RETRIES = 2;
const BACKOFF_MS = 100;
const TEMPORARY = new Set(["overloaded", "timeout", "other"]);
const sleep = (ms, cap) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, cap))));

// In-process rate gate (60 RPM ceiling per container)
const rateGate = U.createRateGate(60);

// Cached GoogleGenAI SDK instance (Dynamic ESM singleton)
let genAIInstance = null;

/**
 * Dynamically loads @google/genai as an ESM module to avoid CommonJS require crashes.
 * Returns the resolved GoogleGenAI singleton instance.
 */
async function getGenAI() {
  if (genAIInstance) return genAIInstance;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }
  const { GoogleGenAI } = await import("@google/genai");
  genAIInstance = new GoogleGenAI({ apiKey });
  return genAIInstance;
}

/**
 * Thinking setting per model for latency-sensitive tasks. Settings are not portable:
 * gemini-3.8-flash rejects MINIMAL and flash-lite rejects thinkingBudget 0 (probed 2026-10-24).
 */
const FAST_THINKING = {
  "gemini-3.8-flash": { thinkingLevel: "LOW" },
  "gemini-3.6-flash": { thinkingLevel: "MINIMAL" },
  "gemini-3.5-flash-lite": { thinkingLevel: "MINIMAL" }
};

/**
 * Per-task routing. deadlineMs bounds the whole call; models are tried in turn (see generateWithCascade). thinking: "fast" uses FAST_THINKING,
 * "default" keeps the model's own setting (draft extraction stays here until the quality eval decides).
 */
const ROUTES = {
  search_parse: { deadlineMs: 8000, thinking: "fast" },
  vision_curation: { deadlineMs: 45000, thinking: "fast" },
  audio_transcription: { deadlineMs: 25000, thinking: "fast" },
  lead_extraction: { deadlineMs: 15000, thinking: "fast" },
  lead_update: { deadlineMs: 15000, thinking: "fast" },
  catalogue_update: { deadlineMs: 15000, thinking: "fast" },
  // A PDF page or photo of a price table (C5): media models; the agency's monthly page allowance gates it instead
  // of the text allowance and daily quota (services/priceReading.js).
  price_list_read: { deadlineMs: 60000, thinking: "fast", tiers: MEDIA_TIERS, ownAllowance: true },
  brochure_read: { deadlineMs: 60000, thinking: "fast", tiers: MEDIA_TIERS, ownAllowance: true },
  brochure_highlights: { deadlineMs: 20000, thinking: "fast" },
  // C10: grounded answers from the agency's data; the web answer (owner switch) uses Google Search grounding.
  assistant: { deadlineMs: 20000, thinking: "fast" },
  // N2: the next WhatsApp message to a client after a call or viewing, from the lead's own record only.
  follow_up_draft: { deadlineMs: 20000, thinking: "fast" },
  // Eval 2026-10-25: MINIMAL (LOW on 3.8) matched default thinking on text and voice drafts.
  listing_extraction: { deadlineMs: 40000, thinking: "fast" },
  default: { deadlineMs: 40000, thinking: "default" }
};

/** Classifies an SDK error for telemetry: aborted, timeout, quota, overloaded, invalid or other. */
function classifyError(err) {
  const status = err?.status || err?.statusCode || 0;
  const msg = String(err?.message || "").toLowerCase();
  if (err?.name === "AbortError" || msg.includes("abort")) return "aborted";
  if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
  if (status === 429 || msg.includes("resource_exhausted") || msg.includes("quota")) return "quota";
  if (
    status === 503 ||
    status === 500 ||
    msg.includes("unavailable") ||
    msg.includes("high demand") ||
    msg.includes("overloaded")
  ) {
    return "overloaded";
  }
  if (status === 400 || msg.includes("invalid")) return "invalid";
  return "other";
}

let testClient = null;
/** Test hook: replaces the Gemini SDK client (pass null to restore). */
function _setClientForTests(client) {
  testClient = client;
}

/**
 * Runs one Gemini request across the model tiers with hedging and a hard deadline,
 * and writes one operation_logs row (success or failure) with per-attempt detail.
 *
 * @param {Object} params
 * @param {Array|string} params.contents - Prompt or multimodal parts
 * @param {Object} [params.config] - Generation config (temperature, responseMimeType, etc.)
 * @param {string} [params.operationType] - Route and telemetry label (search_parse, vision_curation, ...)
 * @param {Object} [params.ctx] - { pool, broker } for telemetry
 * @returns {Promise<{text, modelUsed, usage, totalDurationMs, attempts}>}
 */
async function generateWithCascade({
  contents,
  config = {},
  operationType = "ai_generation",
  ctx = {}
}) {
  const route = ROUTES[operationType] || ROUTES.default;
  const tiers = tiersFor(route, contents);
  // Daily per-broker / per-agency AI quota (config.ai.quotas); throws QUOTA_EXCEEDED codes.
  const audio = hasAudio(contents);
  // The agency owner's switches (services/aiSwitches.js): a feature switched off never reaches the AI or the credits.
  if (ctx?.pool && ctx?.broker?.agency_id) {
    const feature = Switches.featureFor(operationType, { audio, feature: ctx.feature });
    await Switches.assertOn(ctx.pool, ctx.broker.agency_id, feature, { tab: feature ? null : audio || operationType === "audio_transcription" ? "voice" : null });
  }
  if (ctx?.pool && ctx?.broker?.agency_id && !route.ownAllowance) {
    await Db.checkAiQuota(ctx.pool, ctx.broker.agency_id, ctx.broker.id);
    // The plan's monthly text / voice allowance (services/billing.js); throws PLAN_QUOTA_EXCEEDED.
    await Billing.checkAllowance(ctx.pool, ctx.broker.agency_id, { audio });
  }
  await rateGate();
  const ai = testClient || (await getGenAI());
  const startTime = Date.now();
  const attempts = [];
  const controllers = [];

  // One try on one model, with its own time limit. Every try is recorded (retries included).
  const runAttempt = (model, timeoutMs) => {
    const controller = new AbortController();
    controllers.push(controller);
    const attempt = { model, startedMs: Date.now() - startTime };
    attempts.push(attempt);
    const thinking = route.thinking === "fast" ? FAST_THINKING[model] : null;
    const t0 = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    return ai.models
      .generateContent({
        model,
        contents,
        config: {
          ...config,
          ...(thinking ? { thinkingConfig: thinking } : {}),
          abortSignal: controller.signal
        }
      })
      .then((response) => {
        attempt.ms = Date.now() - t0;
        attempt.outcome = "ok";
        return { response, model, latencyMs: attempt.ms };
      })
      .catch((err) => {
        attempt.ms = Date.now() - t0;
        attempt.outcome = timedOut ? "timeout" : controller.signal.aborted ? "aborted" : classifyError(err);
        attempt.error = String(err?.message || err).slice(0, 200);
        if (err && typeof err === "object") err.outcome = attempt.outcome;
        throw err;
      })
      .finally(() => clearTimeout(timer));
  };

  // Sequential: each model in turn, up to RETRIES more tries on temporary errors (overload, server error, timeout),
  // none on quota or invalid requests, then the next model. The task's total limit bounds the whole call.
  const tierCount = tiers.length;
  const perTry = Math.max(50, Math.floor(route.deadlineMs / tierCount));
  let winner = null;
  let lastError = null;
  const tryTiers = async () => {
        for (const model of tiers) {
          for (let tryNo = 0; tryNo <= RETRIES; tryNo++) {
            const left = route.deadlineMs - (Date.now() - startTime);
            if (left <= 0) throw Object.assign(new Error("deadline"), { code: "AI_DEADLINE" });
            try {
              return await runAttempt(model, Math.min(perTry, left));
            } catch (err) {
              lastError = err;
              const kind = err?.outcome || classifyError(err);
              if (!TEMPORARY.has(kind)) break; // quota, invalid or other: the next model, no retry here
              if (tryNo < RETRIES) await sleep(BACKOFF_MS * (tryNo + 1), route.deadlineMs - (Date.now() - startTime));
            }
          }
        }
        return null;
  };
  let deadlineTimer = null;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      const err = new Error(`AI deadline of ${route.deadlineMs}ms exceeded (${operationType})`);
      err.code = "AI_DEADLINE";
      reject(err);
    }, route.deadlineMs);
  });
  deadline.catch(() => {});
  try {
    winner = await Promise.race([tryTiers(), deadline]);
  } catch (err) {
    lastError = err.code === "AI_DEADLINE" ? err : lastError || err;
  } finally {
    clearTimeout(deadlineTimer);
    controllers.forEach((c) => c.abort());
  }

  const totalDurationMs = Date.now() - startTime;
  const usage = winner?.response?.usageMetadata || {};
  logAiCall(ctx, {
    operationType,
    status: winner ? "success" : "failed",
    errorCode: winner ? null : lastError?.code || classifyError(lastError),
    totalDurationMs,
    geminiMs: winner?.latencyMs || 0,
    usage,
    model: winner?.model || null,
    attempts,
    media: audio ? "audio" : hasMedia(contents) ? "image" : null
  });

  if (!winner) {
    console.error(
      `[AI_GATEWAY] ${operationType} failed after ${attempts.length} attempt(s):`,
      lastError?.message
    );
    throw lastError;
  }
  return {
    text: winner.response.text || "",
    // Web-grounded answers (assistant_web) carry their sources here.
    grounding: winner.response.candidates?.[0]?.groundingMetadata || null,
    modelUsed: winner.model,
    usage,
    totalDurationMs,
    attempts
  };
}

/** Non-blocking telemetry: one operation_logs row per AI call, success or failure. */
function logAiCall(
  ctx,
  { operationType, status, errorCode, totalDurationMs, geminiMs, usage, model, attempts, media = null }
) {
  if (!ctx?.pool) return;
  const tokensOut = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  setImmediate(() => {
    ctx.pool
      .query(
        `INSERT INTO operation_logs (
           agency_id, broker_id, operation_type, status, error_code, total_duration_ms,
           gemini_ms, tokens_input, tokens_output, model_used, estimated_cost_usd, metadata, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [
          ctx.broker?.agency_id || null,
          ctx.broker?.id || null,
          operationType,
          status,
          errorCode,
          totalDurationMs,
          geminiMs,
          usage.promptTokenCount || 0,
          // Thinking tokens are billed as output.
          tokensOut,
          model,
          model ? estimateCostUsd(model, usage.promptTokenCount || 0, tokensOut) : 0,
          JSON.stringify({ thoughts_tokens: usage.thoughtsTokenCount || 0, attempts, ...(media ? { media } : {}) })
        ]
      )
      .catch((logErr) =>
        console.warn("Operation telemetry log error:", logErr.message)
      );
  });
}

// Shared with scripts/eval-ai.js so the quality eval measures the production prompt.
const TRANSCRIPTION_PROMPT = `أنت مساعد ذكي متخصص في الاستماع للرسائل الصوتية لوسطاء العقارات في مصر.
مهمتك: تفريغ التسجيل الصوتي بدقة تامة وباللهجة المصرية الدارجة مع التركيز على المصطلحات العقارية:
(المناطق: التجمع، زايد، أكتوبر، الشروق، المستقبل، الساحل، العاصمة، مدينتي...
أنواع الوحدات: شقة، دوبلكس، بنتهاوس، تاون هاوس، توين هاوس، ستاند ألون، أرضي بحديقة...
التشطيب والماليات: استلام فوري، ريدي تو موف، نصف تشطيب، محارة وحلوق، الترا سوبر لوكس، أوفر، كاش، أقساط، وديعة صيانة).

تعليمات مهمة:
- اكتب الكلمات العقارية والأرقام بدقة.
- حول الأرقام الشفهية إلى صيغة رقمية واضحة.
- اكتب أكواد الوحدات بالحروف اللاتينية والأرقام كما تُنطق.
- لو التسجيل صامت، أو فيه ضوضاء بس، أو مفيش كلام واضح: أخرج سطر فاضي. ماتكتبش أي كلام من الأمثلة أو المفردات اللي فوق.
- أخرج النص المفرغ فقط بدون أي مقدمات أو تعليقات.`;

/**
 * Transcribes Egyptian Arabic real estate voice notes into normalized text.
 *
 * @param {Buffer} audioBuffer - Clean OGG/Opus or MP3 audio buffer
 * @param {string} mimeType - Clean audio MIME type
 * @param {Object} [ctx] - Context containing telemetry pool
 * @returns {Promise<string>} Clean transcribed text
 */
async function transcribeAudio(audioBuffer, mimeType, ctx = {}) {
  const base64Audio = audioBuffer.toString("base64");


  const contents = [
    {
      role: "user",
      parts: [
        { text: TRANSCRIPTION_PROMPT },
        {
          inlineData: {
            mimeType: mimeType || "audio/ogg",
            data: base64Audio
          }
        }
      ]
    }
  ];

  const result = await generateWithCascade({
    contents,
    config: {
      temperature: 0.1
    },
    operationType: "audio_transcription",
    ctx
  });

  return result.text.trim();
}

module.exports = {
  TIERS,
  TEXT_TIERS,
  MEDIA_TIERS,
  hasMedia,
  hasAudio,
  tiersFor,
  ROUTES,
  FAST_THINKING,
  TRANSCRIPTION_PROMPT,
  classifyError,
  _setClientForTests,
  getGenAI,
  generateWithCascade,
  transcribeAudio
};
