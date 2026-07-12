// ── AI nutrition provider clients ────────────────────────────────────────────
//
// Calls one of four external AI APIs to estimate a recipe's nutrition
// (kcal/protein/fat/carbs/fiber per serving) from its title + ingredient
// list. Each provider has its own request shape and its own way of forcing
// structured/JSON output; normalizeResult() below is the single place that
// turns whatever came back into the shared NutritionEstimate shape (or
// throws), so callers (index.ts) never branch on provider again after the
// fetch.
//
// Model names are stored per-provider in ai_nutrition_providers.model (free
// text, admin-editable in Settings) rather than hardcoded here — AI model
// names change too fast to bake into this file (project convention: always
// use the current stable model, and that changes independently of module
// releases).
//
// Hosts are fixed and listed in manifest.yaml's egress_allowlist — no
// runtime host discovery, no isPrivateHost()-style check needed (unlike
// unifi-network's user-supplied gateway URLs).

export type AiProviderName = "openai" | "google" | "anthropic" | "deepseek";

export interface NutritionEstimate {
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
}

interface IngredientForPrompt {
  name: string;
  amount: number | null;
  unit: string | null;
}

const REQUEST_TIMEOUT_MS = 55_000; // headroom under manifest resources.timeout (60s, see manifest.yaml)
const MODELS_LIST_TIMEOUT_MS = 15_000; // GET .../models is cheap/fast — no reason to wait as long as a completion call

const SYSTEM_PROMPT =
  "You are a nutrition estimation assistant. Given a recipe title, its total " +
  "number of servings, and its ingredient list (name, amount, unit — amount/unit " +
  "may be missing for \"to taste\" items), estimate the TOTAL nutrition PER SERVING " +
  "for the finished dish. Base this on typical nutritional values for the named " +
  "ingredients and the given amounts. Respond with your best numeric estimate even " +
  "if some ingredients are vague — never refuse. All five values are required " +
  "non-negative numbers (grams, except kcal): kcal, protein_g, fat_g, carbs_g, fiber_g.";

function buildUserPrompt(title: string, servings: number, ingredients: IngredientForPrompt[]): string {
  const lines = ingredients.map((i) => {
    const amt = i.amount != null ? `${i.amount}${i.unit ? " " + i.unit : ""}` : "nach Geschmack";
    return `- ${i.name}: ${amt}`;
  });
  return `Recipe: ${title}\nServings: ${servings}\nIngredients:\n${lines.join("\n")}`;
}

// Coerces/validates whatever JSON-ish object a provider returned into a
// NutritionEstimate. Throws AiProviderError (caught by callNutritionAi) on
// anything that isn't at least a usable kcal figure — better to surface "AI
// call failed" than to silently store zeros/NaNs as if they were a real
// estimate.
function normalizeResult(raw: unknown): NutritionEstimate {
  const o = raw as Record<string, unknown> | null | undefined;
  const num = (v: unknown): number => {
    const n = typeof v === "string" ? parseFloat(v) : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  if (!o || typeof o !== "object" || o.kcal == null || !Number.isFinite(Number(o.kcal))) {
    throw new AiProviderError("provider returned no usable nutrition data");
  }
  return {
    kcal: num(o.kcal),
    protein_g: num(o.protein_g),
    fat_g: num(o.fat_g),
    carbs_g: num(o.carbs_g),
    fiber_g: num(o.fiber_g),
  };
}

export class AiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderError";
  }
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function assertOk(res: Response, provider: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AiProviderError(`${provider} API error ${res.status}: ${text.slice(0, 500)}`);
  }
}

// The JSON Schema shared (with minor per-provider dialect tweaks) across
// OpenAI's json_schema response_format, Gemini's responseSchema, and
// Claude's tool input_schema.
const NUTRITION_SCHEMA = {
  type: "object",
  properties: {
    kcal: { type: "number" },
    protein_g: { type: "number" },
    fat_g: { type: "number" },
    carbs_g: { type: "number" },
    fiber_g: { type: "number" },
  },
  required: ["kcal", "protein_g", "fat_g", "carbs_g", "fiber_g"],
  additionalProperties: false,
};

async function callOpenAi(apiKey: string, model: string, userPrompt: string): Promise<NutritionEstimate> {
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "nutrition_estimate", strict: true, schema: NUTRITION_SCHEMA },
        },
      }),
    });
    await assertOk(res, "OpenAI");
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new AiProviderError("OpenAI response had no message content");
    return normalizeResult(JSON.parse(content));
  });
}

async function callGoogle(apiKey: string, model: string, userPrompt: string): Promise<NutritionEstimate> {
  return withTimeout(async (signal) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: NUTRITION_SCHEMA,
        },
      }),
    });
    await assertOk(res, "Google Gemini");
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") throw new AiProviderError("Gemini response had no candidate text");
    return normalizeResult(JSON.parse(text));
  });
}

async function callAnthropic(apiKey: string, model: string, userPrompt: string): Promise<NutritionEstimate> {
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        tools: [
          {
            name: "report_nutrition_estimate",
            description: "Reports the estimated per-serving nutrition for the recipe.",
            input_schema: NUTRITION_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "report_nutrition_estimate" },
      }),
    });
    await assertOk(res, "Anthropic Claude");
    const data = await res.json();
    const toolUse = (data?.content ?? []).find((b: { type?: string }) => b?.type === "tool_use");
    if (!toolUse?.input) throw new AiProviderError("Claude response had no tool_use block");
    return normalizeResult(toolUse.input);
  });
}

async function callDeepSeek(apiKey: string, model: string, userPrompt: string): Promise<NutritionEstimate> {
  return withTimeout(async (signal) => {
    // DeepSeek's json_object mode has no schema parameter (unlike OpenAI's
    // json_schema mode) — the key list has to be spelled out in the prompt
    // itself, since nothing else enforces shape here.
    const jsonInstruction =
      SYSTEM_PROMPT +
      ' Respond with ONLY a JSON object, no other text, with exactly these keys: ' +
      '{"kcal": number, "protein_g": number, "fat_g": number, "carbs_g": number, "fiber_g": number}.';
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: jsonInstruction },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      }),
    });
    await assertOk(res, "DeepSeek");
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new AiProviderError("DeepSeek response had no message content");
    return normalizeResult(JSON.parse(content));
  });
}

export async function callNutritionAi(
  provider: AiProviderName,
  apiKey: string,
  model: string,
  title: string,
  servings: number,
  ingredients: IngredientForPrompt[],
): Promise<NutritionEstimate> {
  const userPrompt = buildUserPrompt(title, servings, ingredients);
  switch (provider) {
    case "openai":
      return callOpenAi(apiKey, model, userPrompt);
    case "google":
      return callGoogle(apiKey, model, userPrompt);
    case "anthropic":
      return callAnthropic(apiKey, model, userPrompt);
    case "deepseek":
      return callDeepSeek(apiKey, model, userPrompt);
  }
}

// ── Available-models lookup ───────────────────────────────────────────────────
//
// Ported 1:1 from Core's admin/system/ai settings page
// (backend/internal/ai/ai.go: fetchModels/normalizeModelID/isCompatibleModel/
// defaultBaseURL — 2026-07-12 user request "genauso umsetzen wie in
// admin/system/ai"). Same behavior as Core:
//  - Anthropic hits its own native https://api.anthropic.com/v1/models with
//    x-api-key + anthropic-version.
//  - openai/google/deepseek all go through an OpenAI-compatible {base}/models
//    endpoint with a Bearer token — including Google, via Gemini's
//    OpenAI-compat shim (generativelanguage.googleapis.com/v1beta/openai),
//    NOT the native v1beta/models REST endpoint — so all three share one
//    request/response shape ({"data":[{"id": "..."}]}).
//  - Result is a flat, deduped, sorted string[] of model ids — no display
//    name/context-window/pricing metadata, matching Core exactly.
//  - Requires an already-stored key (see listAiProviderModels() in
//    index.ts) — this module has no "unsaved key" fast path, same as
//    Core's admin endpoint.

function defaultModelsBaseUrl(provider: AiProviderName): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "anthropic":
      return ""; // unused — anthropic branch below is hardcoded, same as Core
  }
}

// Strips provider-specific noise from a raw model id so the same id a user
// picks from the list is what gets stored/used later (Core: normalizeModelID).
function normalizeModelId(provider: AiProviderName, id: string): string {
  if (provider === "google") return id.replace(/^models\//, "");
  if (provider === "anthropic") {
    // Strip a trailing "-YYYYMMDD" date suffix (8 digits after the last hyphen).
    const m = id.match(/^(.*)-(\d{8})$/);
    if (m) return m[1];
  }
  return id;
}

// Only Gemini needs filtering (Core: isCompatibleModel) — its /models list
// includes live/embedding/aqa/imagen entries that aren't chat-completion
// models. OpenAI/Anthropic/DeepSeek lists are returned as-is, same as Core.
function isCompatibleModel(provider: AiProviderName, id: string): boolean {
  if (provider !== "google") return true;
  const lower = id.toLowerCase();
  return !["live", "embedding", "-aqa", "imagen"].some((s) => lower.includes(s));
}

export async function listAvailableModels(provider: AiProviderName, apiKey: string): Promise<string[]> {
  return withTimeout(async (signal) => {
    let res: Response;
    if (provider === "anthropic") {
      res = await fetch("https://api.anthropic.com/v1/models", {
        signal,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
    } else {
      res = await fetch(`${defaultModelsBaseUrl(provider)}/models`, {
        signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    }
    await assertOk(res, provider);
    const data = await res.json();
    const raw: { id?: string }[] = data?.data ?? [];
    const ids = raw
      .map((m) => m.id)
      .filter((id): id is string => !!id && isCompatibleModel(provider, id))
      .map((id) => normalizeModelId(provider, id));
    return Array.from(new Set(ids)).sort();
  }, MODELS_LIST_TIMEOUT_MS);
}

export const AI_PROVIDER_NAMES: AiProviderName[] = ["openai", "google", "anthropic", "deepseek"];

export const AI_PROVIDER_DEFAULT_MODELS: Record<AiProviderName, string> = {
  openai: "gpt-5.6",
  google: "gemini-3.1-flash-lite",
  anthropic: "claude-haiku-4-5",
  deepseek: "deepseek-v4-flash",
};
