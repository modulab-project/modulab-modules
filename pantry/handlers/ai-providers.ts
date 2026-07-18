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
// PDF receipts (2026-07-19, "Bon geht nur als Foto? nicht als PDF?"):
// Gemini accepts application/pdf through the same inlineData field used for
// images - no code branch needed, it's handled purely by mimeType. Claude
// needs a "document" content block instead of "image" for a PDF (see
// callAnthropic below) - this is GA on the standard 2023-06-01 API version,
// no beta header required, and works on every current Claude model
// (confirmed against docs.claude.com/.../pdf-support, 2026-07-19). OpenAI's
// Chat Completions vision endpoint (used here) has no PDF input path at all -
// callOpenAi rejects a PDF upfront with a clear error rather than silently
// sending a data URI the API would just fail to parse as an image.
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

// 2026-07-19 user feedback round:
//  1. "Pfand soll nicht berücksichtigt werden" - deposit lines (bottle/crate
//     deposit and its refund) were being parsed as grocery items. Now
//     explicitly excluded, same bucket as tax/subtotal/payment lines.
//  2. "wird das den [existing item] hinzugefügt?" - matching an existing
//     item was already exact-name-based server-side (see index.ts's
//     createItemsBulk), but the AI had no way to know what spelling an
//     existing item already uses, so e.g. "Mutti Tomaten" on the receipt vs.
//     "Mutti Tomaten stückig" already in stock wouldn't match and would
//     silently become a second item. buildSystemPrompt() now includes the
//     current pantry's item names so the AI can reuse the exact existing
//     spelling when it recognizes the same product, making the automatic
//     match in createItemsBulk actually fire.
//  3. "Ablaufdatum fehlt" - a receipt never prints a best-before date. An
//     AI-guessed shelf-life estimate was tried and explicitly rejected by
//     the user ("ich möchte das das MHD nicht geschätzt wird, sondern das
//     ich es vor dem Import eintragen kann") - the expiry date field on the
//     confirm screen is simply left blank, the user fills it in by hand
//     where they know it before importing. No estimation logic here at all.
//  4. "woher kommen die Kategorien beim Import?" - category used to be a
//     free-text guess from a hardcoded generic English example list
//     ("Dairy", "Canned goods", ...), which almost never matched the
//     household's own (real, often non-English, self-defined) category
//     names, so nearly every scanned item came back uncategorized.
//     buildSystemPrompt() now includes the household's actual category
//     names, same pattern as the known-item-names fix above: use one of
//     these exactly if it fits, otherwise leave category as an empty string
//     rather than inventing a new category name outside the app's own list
//     (normalizeResult's str() already turns "" into null). The frontend
//     lets the user create a genuinely new category inline when none fits,
//     which then becomes selectable for the rest of that scan's rows too.
//  5. "Coke Zero 6x1,25l ... anstatt 1 pcs, ... 6 pcs" / "JT Eier 10er ...
//     anstatt 1 pcs, 10 pcs" (2026-07-19) - multi-pack retail units ("6x1,25l",
//     "4er Pack", "10er", "Sixpack", crates/"Kasten") were defaulting to
//     quantity 1 (the "assume 1 if no count shown" fallback firing even
//     though a count WAS shown, just not as a plain standalone number). The
//     prompt now explicitly calls out this pattern: quantity becomes the
//     pack count, unit becomes the per-unit size/descriptor. Applies
//     generally to any such multi-pack line, not just soda/eggs - crates of
//     water or beer, yogurt 4-packs, toilet paper/kitchen roll packs,
//     battery packs, diapers, etc. all follow the same "Nx..." or "N-er"
//     notation on a German receipt.
function buildSystemPrompt(knownItemNames: string[], knownCategoryNames: string[]): string {
  let prompt =
    "You are a receipt-parsing assistant for a household pantry app. Given a " +
    "photo or PDF of a grocery store receipt, extract every purchased " +
    "grocery/household item as a separate entry. For each item, give your " +
    "best guess for: name (short, human-readable, not the receipt's " +
    "abbreviated code), quantity (a number), unit, and category. For unit, " +
    "prefer one of these exact codes whenever it fits the product: \"pcs\" " +
    "(individually counted items, e.g. eggs, fruit), \"kg\"/\"g\" (weighed " +
    "goods), \"l\"/\"ml\" (loose liquid volume), \"pack\" (a generic multi-" +
    "item pack with no more specific container), \"can\" (tinned/canned " +
    "goods), \"bottle\" (a single bottle), \"crate\" (a crate/case of " +
    "bottles, German \"Kasten\"/\"Kiste\"), \"bag\" (a bag or net, German " +
    "\"Beutel\"/\"Netz\" - potatoes, onions, chips), \"jar\" (German " +
    "\"Glas\" - jam, pickles, honey), \"box\" (German \"Karton\"/\"Schachtel\" " +
    "- cereal, tea bags, tissues), \"roll\" (German \"Rolle\" - toilet " +
    "paper, kitchen roll, cling film). Use plain lowercase English for " +
    "these codes exactly as spelled here, not a translated or capitalized " +
    "variant, and not the receipt's own language - the app translates them " +
    "for display itself. If truly none of these fit (e.g. a multi-pack's " +
    "per-unit size like \"1,25l\" from a 6-pack, see below), give your own " +
    "short best-guess text instead. Can be null if genuinely unclear. " +
    "Pay close attention to multi-pack retail units, which are extremely " +
    "common on German receipts and must NOT default to quantity 1: a " +
    "notation like \"6x1,25l\" or \"6 x 1.5L\" means quantity 6 and unit " +
    "\"1,25l\" (the per-bottle size becomes the unit, the pack count becomes " +
    "the quantity) - e.g. \"Coke Zero 6x1,25l\" is quantity 6, unit " +
    "\"1,25l\", name \"Coke Zero\", NOT quantity 1 with unit \"pcs\". A " +
    "notation like \"10er\", \"4er Pack\", \"Sixpack\", or \"8-Pack\" (a pure " +
    "count multipack with no separate per-unit measurement, e.g. a carton " +
    "of eggs or a pack of toilet paper rolls) means quantity equals that " +
    "count and unit \"pcs\" - e.g. \"JT Eier 10er\" is quantity 10, unit " +
    "\"pcs\", name \"Eier\", NOT quantity 1. The same applies to crates " +
    "(\"Kasten\"/\"Kiste\") of bottled drinks - use the crate's stated " +
    "bottle count as quantity and \"crate\" as the unit if no per-bottle " +
    "size is legible, or the per-bottle size (e.g. \"0,5l\") as the unit if " +
    "it is. Only fall back to quantity 1 when the receipt genuinely shows " +
    "no count or multi-pack notation for that line at all. Skip " +
    "every line that is not an actual purchased grocery/household product, " +
    "including but not limited to: subtotal/total/sum lines, tax/VAT lines, " +
    "payment method and change given, loyalty/rewards points, store name/" +
    "address/opening hours/receipt footer text, deposit charges and deposit " +
    "refunds (\"Pfand\", bottle/crate deposit, \"Pfandrückgabe\"/\"Leergut\" " +
    "or similar), discounts/coupons/vouchers applied (\"Rabatt\", " +
    "\"Coupon\", \"Gutschein\" or similar - these modify a price, they are " +
    "not a product), carrier bag fees (\"Tüte\", \"Tragetasche\"), tips or " +
    "service charges, gift cards, delivery/shipping fees, and any rounding " +
    "adjustment line. If in doubt whether a line is a real product versus " +
    "one of these, prefer to skip it. Never refuse - if the image is blurry " +
    "or partially unreadable, do your best with what's legible and omit " +
    "only the lines you truly cannot make out at all.";

  if (knownItemNames.length > 0) {
    prompt +=
      " The household's pantry already tracks these existing item names: " +
      knownItemNames.map((n) => `"${n}"`).join(", ") +
      ". If a purchased item is clearly the same product as one of these, " +
      "use that exact existing name (same spelling) instead of inventing a " +
      "new one, so it's recognized as a restock of the existing item rather " +
      "than a duplicate.";
  }

  if (knownCategoryNames.length > 0) {
    prompt +=
      " For the category field, choose the single best-fitting name from " +
      "this exact list of the household's existing categories (use the " +
      "exact spelling, do not translate or rephrase it): " +
      knownCategoryNames.map((n) => `"${n}"`).join(", ") +
      ". Do not invent a category name that is not in this list. If truly " +
      "none of them fit this item, return an empty string for category " +
      "instead of making one up.";
  } else {
    prompt +=
      " The household has not defined any categories yet, so leave category " +
      "as an empty string for every item.";
  }

  return prompt;
}

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

async function callOpenAi(apiKey: string, model: string, imageB64: string, mimeType: string, knownItemNames: string[], knownCategoryNames: string[]): Promise<ScannedItem[]> {
  if (mimeType === "application/pdf") {
    throw new AiProviderError(
      "OpenAI's receipt scan does not support PDF files here - please upload a photo instead, or switch to Google Gemini or Anthropic Claude for this receipt.",
    );
  }
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildSystemPrompt(knownItemNames, knownCategoryNames) },
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

async function callGoogle(apiKey: string, model: string, imageB64: string, mimeType: string, knownItemNames: string[], knownCategoryNames: string[]): Promise<ScannedItem[]> {
  return withTimeout(async (signal) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(knownItemNames, knownCategoryNames) }] },
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

async function callAnthropic(apiKey: string, model: string, imageB64: string, mimeType: string, knownItemNames: string[], knownCategoryNames: string[]): Promise<ScannedItem[]> {
  // PDF receipts use a "document" content block instead of "image" - GA on
  // the standard API version (no anthropic-beta header needed), supported on
  // every current Claude model. See file-header comment for the source.
  const fileBlock =
    mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageB64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType, data: imageB64 } };

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
        system: buildSystemPrompt(knownItemNames, knownCategoryNames),
        messages: [
          {
            role: "user",
            content: [
              fileBlock,
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
  // Existing pantry item/category names, so the AI can reuse an item's
  // exact spelling and pick from the household's real categories instead of
  // inventing generic ones - see buildSystemPrompt()'s doc comment
  // (2026-07-19).
  knownItemNames: string[] = [],
  knownCategoryNames: string[] = [],
): Promise<ScannedItem[]> {
  switch (provider) {
    case "openai":
      return callOpenAi(apiKey, model, imageB64, mimeType, knownItemNames, knownCategoryNames);
    case "google":
      return callGoogle(apiKey, model, imageB64, mimeType, knownItemNames, knownCategoryNames);
    case "anthropic":
      return callAnthropic(apiKey, model, imageB64, mimeType, knownItemNames, knownCategoryNames);
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
//
// google updated 2026-07-19: "gemini-3.1-flash" no longer appears in
// Google's current model lineup at all (checked ai.google.dev/gemini-api/
// docs/models live) - only gemini-3.1-flash-lite, gemini-3.5-flash (stable),
// gemini-3.1-pro-preview and gemini-3-flash-preview (both preview) remain.
// gemini-3.5-flash is the current stable, frontier-class model and the
// right pick for receipt OCR: preview models carry tighter rate limits and
// no stability guarantee, and 3.1 Pro's reasoning/agentic focus is
// unnecessary weight for straightforward document extraction.
export const AI_PROVIDER_DEFAULT_MODELS: Record<AiProviderName, string> = {
  openai: "gpt-5.6",
  google: "gemini-3.5-flash",
  anthropic: "claude-haiku-4-5",
};
