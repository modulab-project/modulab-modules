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
// Mirrors Core's admin/system/ai settings page (backend/internal/ai/ai.go):
// the Settings UI lets an Admin fetch the live list of models for the key
// they just typed, instead of hand-typing a model id that may be stale,
// misspelled, or no longer available on that account. Called with the
// api_key straight from the (not-yet-saved) form input — see
// listAiProviderModels() in index.ts — so this works before the key is
// ever persisted, same as Core's flow.

export interface AiModelOption {
  id: string;
  label: string;
}

async function listOpenAiModels(apiKey: string): Promise<AiModelOption[]> {
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.openai.com/v1/models", {
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    await assertOk(res, "OpenAI");
    const data = await res.json();
    const ids: string[] = (data?.data ?? []).map((m: { id?: string }) => m.id).filter(Boolean);
    // Chat-completions is the only capability this module needs — filter
    // out the obviously-unrelated model families (embeddings, audio,
    // image, moderation) rather than trying to positively allowlist every
    // current gpt-* name, which would go stale immediately.
    const excluded = /embedding|whisper|tts|dall-e|moderation|davinci|babbage|ada\b/i;
    return ids
      .filter((id) => !excluded.test(id))
      .sort()
      .map((id) => ({ id, label: id }));
  }, MODELS_LIST_TIMEOUT_MS);
}

async function listAnthropicModels(apiKey: string): Promise<AiModelOption[]> {
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      signal,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    await assertOk(res, "Anthropic Claude");
    const data = await res.json();
    const models: { id?: string; display_name?: string }[] = data?.data ?? [];
    return models
      .filter((m) => m.id)
      .map((m) => ({ id: m.id!, label: m.display_name ? `${m.display_name} (${m.id})` : m.id! }));
  }, MODELS_LIST_TIMEOUT_MS);
}

async function listGoogleModels(apiKey: string): Promise<AiModelOption[]> {
  return withTimeout(async (signal) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal },
    );
    await assertOk(res, "Google Gemini");
    const data = await res.json();
    const models: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[] = data?.models ?? [];
    return models
      .filter((m) => m.name && (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => {
        const id = m.name!.replace(/^models\//, "");
        return { id, label: m.displayName ? `${m.displayName} (${id})` : id };
      });
  }, MODELS_LIST_TIMEOUT_MS);
}

async function listDeepSeekModels(apiKey: string): Promise<AiModelOption[]> {
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.deepseek.com/models", {
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    await assertOk(res, "DeepSeek");
    const data = await res.json();
    const ids: string[] = (data?.data ?? []).map((m: { id?: string }) => m.id).filter(Boolean);
    return ids.sort().map((id) => ({ id, label: id }));
  }, MODELS_LIST_TIMEOUT_MS);
}

export async function listAvailableModels(provider: AiProviderName, apiKey: string): Promise<AiModelOption[]> {
  switch (provider) {
    case "openai":
      return listOpenAiModels(apiKey);
    case "anthropic":
      return listAnthropicModels(apiKey);
    case "google":
      return listGoogleModels(apiKey);
    case "deepseek":
      return listDeepSeekModels(apiKey);
  }
}

export const AI_PROVIDER_NAMES: AiProviderName[] = ["openai", "google", "anthropic", "deepseek"];

export const AI_PROVIDER_DEFAULT_MODELS: Record<AiProviderName, string> = {
  openai: "gpt-5.6",
  google: "gemini-3.1-flash-lite",
  anthropic: "claude-haiku-4-5",
  deepseek: "deepseek-v4-flash",
};
