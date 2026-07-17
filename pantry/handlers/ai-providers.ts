// ── AI receipt-scan provider clients ─────────────────────────────────────────
//
// Calls one of three external, vision-capable AI APIs to parse a photographed
// receipt into a list of suggested pantry items (name, quantity, unit, a best-
// guess category). normalizeResult() is the single place that turns whatever
// came back into the shared ScannedItem[] shape (or throws), so callers
// (index.ts) never branch on provider again after the fetch.
//
// DeepSeek is deliberately not included here (unlike recipes' four-provider
// text-only nutrition estimate) - its current models don't have reliable
// vision support, and this call always sends an image. See manifest.yaml's
// egress_allowlist comment.
//
// Model names are stored per-provider in ai_pantry_providers.model (free
// text, admin-editable in Settings) rather than hardcoded here - AI model
// names change too fast to bake into this file (project convention: always
// use the current stable model, and that changes independently of module
// releases).
//
// Hosts are fixed and listed in manifest.yaml's egress_allowlist - no runtime
// host discovery needed.

export type AiProviderName = "openai" | "google" | "anthropic";

export interface ScannedItem {
  name: string;
  quantity: number | null;
  unit: string | null;
  category: string | null;
}

const REQUEST_TIMEOUT_MS = 55_000; // headroom under manifest resources.timeout (60s, see manifest.yaml)
const MODELS_LIST_TIMEOUT_MS = 15_000; // GET .../models is cheap/fast - no reason to wait as long as a vision call

const SYSTEM_PROMPT =
  "You are a receipt-parsing assistant for a household pantry app. Given a " +
  "photo of a grocery store receipt, extract every purchased grocery/" +
  "household item as a separate entry. For each item, give your best guess " +
  "for: name (short, human-readable, not the receipt's abbreviated code), " +
  "quantity (a number - assume 1 if the receipt doesn't show a count), unit " +
  "(e.g. \"pcs\", \"kg\", \"l\" - your best guess, can be null if unclear), and " +
  "category (a short grocery category like \"Dairy\", \"Canned goods\", " +
  "\"Produce\", \"Spices\", \"Beverages\", \"Household\" - your best guess). " +
  "Skip non-item lines (subtotal, tax, payment method, loyalty points, store " +
  "address). Never refuse - if the image is blurry or partially unreadable, " +
  "do your best with what's legible and omit only the lines you truly cannot " +
  "make out at all.";

const USER_PROMPT = "Parse this receipt into a list of pantry items.";

// The JSON Schema shared (with minor per-provider dialect tweaks) across
// OpenAI's json_schema response_format, Gemini's responseSchema, and
// Claude's tool input_schema. Wrapped in a top-level object (not a bare
// array) - same reasoning as recipes' NUTRITION_SCHEMA, some providers'
// structured-output modes require an object at the root.
const ITEMS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          unit: { type: "string" },
          category: { type: "string" },
        },
        required: ["name", "quantity", "unit", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

// Bugfix pattern carried over from recipes/handlers/ai-providers.ts: Gemini's
// responseSchema is only a subset of OpenAPI 3.0's schema object and does not
// recognize "additionalProperties" at all - sending it is a hard 400, not a
// no-op. Strip it recursively for the Gemini variant.
function stripAdditionalProperties(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripAdditionalProperties);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === "additionalProperties") continue;
      out[k] = stripAdditionalProperties(v);
    }
    return out;
  }
  return schema;
}
const GEMINI_ITEMS_SCHEMA = stripAdditionalProperties(ITEMS_SCHEMA);

function normalizeResult(raw: unknown): ScannedItem[] {
  const o = raw as { items?: unknown } | null | undefined;
  if (!o || typeof o !== "object" || !Array.isArray(o.items)) {
    throw new AiProviderError("provider returned no usable item list");
  }
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "string" ? parseFloat(v) : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  return (o.items as unknown[])
    .map((it): ScannedItem | null => {
      const rec = it as Record<string, unknown>;
      const name = str(rec.name);
      if (!name) return null;
      return { name, quantity: num(rec.quantity), unit: str(rec.unit), category: str(rec.category) };
    })
    .filter((x): x is ScannedItem => x !== null);
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

async function callOpenAi(apiKey: string, model: string, imageB64: string, mimeType: string): Promise<ScannedItem[]> {
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: USER_PROMPT },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageB64}` } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "scanned_items", strict: true, schema: ITEMS_SCHEMA },
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

async function callGoogle(apiKey: string, model: string, imageB64: string, mimeType: string): Promise<ScannedItem[]> {
  return withTimeout(async (signal) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [{ text: USER_PROMPT }, { inlineData: { mimeType, data: imageB64 } }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: GEMINI_ITEMS_SCHEMA,
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

async function callAnthropic(apiKey: string, model: string, imageB64: string, mimeType: string): Promise<ScannedItem[]> {
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
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: imageB64 } },
              { type: "text", text: USER_PROMPT },
            ],
          },
        ],
        tools: [
          {
            name: "report_scanned_items",
            description: "Reports the list of items parsed from the receipt photo.",
            input_schema: ITEMS_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "report_scanned_items" },
      }),
    });
    await assertOk(res, "Anthropic Claude");
    const data = await res.json();
    const toolUse = (data?.content ?? []).find((b: { type?: string }) => b?.type === "tool_use");
    if (!toolUse?.input) throw new AiProviderError("Claude response had no tool_use block");
    return normalizeResult(toolUse.input);
  });
}

export async function scanReceiptWithAi(
  provider: AiProviderName,
  apiKey: string,
  model: string,
  imageB64: string,
  mimeType: string,
): Promise<ScannedItem[]> {
  switch (provider) {
    case "openai":
      return callOpenAi(apiKey, model, imageB64, mimeType);
    case "google":
      return callGoogle(apiKey, model, imageB64, mimeType);
    case "anthropic":
      return callAnthropic(apiKey, model, imageB64, mimeType);
  }
}

// ── Available-models lookup ───────────────────────────────────────────────────
//
// Ported from recipes/handlers/ai-providers.ts, itself ported 1:1 from Core's
// admin/system/ai settings page (backend/internal/ai/ai.go). Same behavior:
//  - Anthropic hits its own native https://api.anthropic.com/v1/models with
//    x-api-key + anthropic-version.
//  - openai/google both go through an OpenAI-compatible {base}/models
//    endpoint with a Bearer token - including Google, via Gemini's
//    OpenAI-compat shim.
//  - Result is a flat, deduped, sorted string[].
//  - Requires an already-stored key (see listAiProviderModels() in
//    index.ts) - this module has no "unsaved key" fast path, same as Core.

function defaultModelsBaseUrl(provider: AiProviderName): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "anthropic":
      return ""; // unused - anthropic branch below is hardcoded, same as Core
  }
}

function normalizeModelId(provider: AiProviderName, id: string): string {
  if (provider === "google") return id.replace(/^models\//, "");
  if (provider === "anthropic") {
    const m = id.match(/^(.*)-(\d{8})$/);
    if (m) return m[1];
  }
  return id;
}

// Only Gemini needs filtering - its /models list includes live/embedding/aqa
// entries, and this feature specifically needs vision-capable chat models,
// so image-generation-only entries are filtered too.
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

export const AI_PROVIDER_NAMES: AiProviderName[] = ["openai", "google", "anthropic"];

// Defaults picked for multimodal/vision support at each provider, not
// necessarily the same default model recipes uses for its text-only call.
export const AI_PROVIDER_DEFAULT_MODELS: Record<AiProviderName, string> = {
  openai: "gpt-5.6",
  google: "gemini-3.1-flash",
  anthropic: "claude-haiku-4-5",
};
