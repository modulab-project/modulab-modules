/**
 * Pantry module — Deno Tier 3 handler
 *
 * Routes (all under /v1/modules/pantry/api/):
 *
 * Items
 *   GET    /items                 list all (+ filter by category, location, search, low_stock, expiring_soon)
 *   GET    /items/:id             detail
 *   POST   /items                 create
 *   PATCH  /items/:id             update
 *   DELETE /items/:id             delete
 *   POST   /items/bulk            create many at once (used to confirm AI scan suggestions)
 *
 * Item photo
 *   POST   /items/:id/image       attach uploaded photo (Core writes file, sends path)
 *   DELETE /items/:id/image       remove photo
 *
 * Categories
 *   GET    /categories            list
 *   POST   /categories            create
 *   PATCH  /categories/:id        update
 *   DELETE /categories/:id        delete
 *
 * AI provider settings — Admin only (mirrors recipes' /ai-providers)
 *   GET    /ai-providers                    list configured providers (keys never returned)
 *   PUT    /ai-providers/:provider          upsert one provider's config
 *   DELETE /ai-providers/:provider          remove one provider's config
 *   GET    /ai-providers/:provider/models   list available models via the provider's own /models API
 *                                            (requires the key to already be saved)
 *
 * Receipt scan
 *   POST   /scan                  body: { file_base64, file_mime_type, provider? } — a multipart
 *                                  upload to this same route (fd.append("file", photo)). Core's
 *                                  ModuleProxyHandler (router.go) writes the file to this module's
 *                                  storage dir AND base64-encodes the same bytes into the JSON body
 *                                  it forwards here (2026-07-18 change - see router.go's
 *                                  saveUploadedFile/uploadedFile) — this handler never touches the
 *                                  filesystem itself, it just reads file_base64 straight off the
 *                                  request. Sends the image to the configured (or requested) AI
 *                                  provider and returns suggested items WITHOUT persisting them —
 *                                  the UI shows them for review, then calls POST /items/bulk once
 *                                  the user confirms/edits.
 */

import type { HandlerRequest, HandlerResponse, ModuleDbClient, ModuleAuthContext, ModulePiiCrypto } from "./types.ts";
import { encrypt, decrypt } from "./crypto.ts";
import {
  scanReceiptWithAi,
  listAvailableModels,
  AiProviderError,
  AI_PROVIDER_NAMES,
  AI_PROVIDER_DEFAULT_MODELS,
  type AiProviderName,
} from "./ai-providers.ts";

export default async function handler(req: HandlerRequest): Promise<HandlerResponse> {
  const { method, path, body, auth, db, crypto: piiCrypto } = req;

  const qIdx = path.indexOf("?");
  const pathname = qIdx === -1 ? path : path.slice(0, qIdx);
  const route = `${method} ${pathname}`;

  // ── Items ─────────────────────────────────────────────────────────────────

  if (route === "GET /items") {
    return listItems(db, path);
  }
  if (method === "GET" && pathname.match(/^\/items\/[^/]+$/)) {
    return getItem(db, segId(pathname));
  }
  if (route === "POST /items") {
    return createItem(db, body as ItemInput, auth.userId, "manual");
  }
  if (route === "POST /items/bulk") {
    return createItemsBulk(db, body as { items: ItemInput[] }, auth.userId);
  }
  if (method === "PATCH" && pathname.match(/^\/items\/[^/]+$/)) {
    return updateItem(db, segId(pathname), body as Partial<ItemInput>);
  }
  if (method === "DELETE" && pathname.match(/^\/items\/[^/]+$/)) {
    return deleteItem(db, segId(pathname));
  }

  // ── Item photo ────────────────────────────────────────────────────────────

  if (method === "POST" && pathname.match(/^\/items\/[^/]+\/image$/)) {
    const id = pathname.split("/")[2];
    const { file_path } = body as { file_path: string };
    if (!isSafeFilePath(file_path)) return badRequest("invalid file_path");
    const rows = await db.query(
      `UPDATE pantry_items SET image_path = $1, updated_at = now() WHERE id = $2 RETURNING id`,
      [file_path, id],
    );
    if (rows.length === 0) return notFound("item");
    return ok({ image_path: file_path });
  }
  if (method === "DELETE" && pathname.match(/^\/items\/[^/]+\/image$/)) {
    const id = pathname.split("/")[2];
    await db.query(`UPDATE pantry_items SET image_path = NULL, updated_at = now() WHERE id = $1`, [id]);
    return noContent();
  }

  // ── Categories ────────────────────────────────────────────────────────────

  if (route === "GET /categories") {
    const rows = await db.query(`SELECT * FROM categories ORDER BY sort_order ASC, name ASC`);
    return ok(rows);
  }
  if (route === "POST /categories") {
    const { name, sort_order } = body as { name: string; sort_order?: number };
    if (!name || !name.trim()) return badRequest("name is required");
    const [row] = await db.query(
      `INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING *`,
      [name.trim(), sort_order ?? 0],
    );
    return created(row);
  }
  if (method === "PATCH" && pathname.match(/^\/categories\/[^/]+$/)) {
    const { name, sort_order } = body as { name?: string; sort_order?: number };
    const [row] = await db.query(
      `UPDATE categories SET
        name       = COALESCE($2, name),
        sort_order = COALESCE($3, sort_order)
       WHERE id = $1 RETURNING *`,
      [segId(pathname), name, sort_order],
    );
    if (!row) return notFound("category");
    return ok(row);
  }
  if (method === "DELETE" && pathname.match(/^\/categories\/[^/]+$/)) {
    await db.query(`DELETE FROM categories WHERE id = $1`, [segId(pathname)]);
    return noContent();
  }

  // ── AI provider settings (Admin only) ───────────────────────────────────

  if (route === "GET /ai-providers") {
    return listAiProviders(db, auth);
  }
  if (method === "PUT" && pathname.match(/^\/ai-providers\/[^/]+$/)) {
    return upsertAiProvider(db, auth, segId(pathname), body, piiCrypto);
  }
  if (method === "DELETE" && pathname.match(/^\/ai-providers\/[^/]+$/)) {
    return deleteAiProvider(db, auth, segId(pathname));
  }
  if (method === "GET" && pathname.match(/^\/ai-providers\/[^/]+\/models$/)) {
    const provider = pathname.split("/")[2];
    return listAiProviderModels(db, auth, provider, piiCrypto);
  }

  // ── Receipt scan ──────────────────────────────────────────────────────────

  if (route === "POST /scan") {
    return scanReceipt(db, body as { file_base64?: string; file_mime_type?: string; provider?: string } | undefined, piiCrypto);
  }

  return { status: 404, body: { error: "not found" } };
}

// ── Item helpers ──────────────────────────────────────────────────────────────

async function listItems(db: ModuleDbClient, path: string): Promise<HandlerResponse> {
  const params = new URL("http://x" + path).searchParams;
  const search = params.get("search") ?? "";
  const category = params.get("category") ?? "";
  const location = params.get("location") ?? "";
  const lowStockOnly = params.get("low_stock") === "true";
  const expiringSoonOnly = params.get("expiring_soon") === "true";
  const limit = Math.min(parseInt(params.get("limit") ?? "100"), 500);
  const offset = parseInt(params.get("offset") ?? "0");

  const conditions: string[] = [];
  const args: unknown[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`i.name ILIKE $${idx}`);
    args.push(`%${search}%`);
    idx++;
  }
  if (category) {
    conditions.push(`i.category_id = $${idx}`);
    args.push(category);
    idx++;
  }
  if (location) {
    conditions.push(`i.location = $${idx}`);
    args.push(location);
    idx++;
  }
  if (lowStockOnly) {
    conditions.push(`i.min_stock IS NOT NULL AND i.quantity <= i.min_stock`);
  }
  if (expiringSoonOnly) {
    // "Soon" = within 3 days, including already-expired items - matches the
    // AISettingsView-adjacent "expires in N days" badge in the UI.
    conditions.push(`i.expiry_date IS NOT NULL AND i.expiry_date <= (CURRENT_DATE + INTERVAL '3 days')`);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  args.push(limit, offset);

  const rows = await db.query(
    `SELECT i.*,
            c.name AS category_name,
            (i.min_stock IS NOT NULL AND i.quantity <= i.min_stock) AS is_low_stock,
            (i.expiry_date IS NOT NULL AND i.expiry_date <= CURRENT_DATE) AS is_expired,
            (i.expiry_date - CURRENT_DATE) AS days_until_expiry
     FROM pantry_items i
     LEFT JOIN categories c ON c.id = i.category_id
     ${where}
     ORDER BY i.updated_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    args,
  );

  const [countRow] = await db.query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM pantry_items i ${where}`,
    args.slice(0, -2),
  );

  return ok({ items: rows, total: parseInt(countRow?.total ?? "0") });
}

async function getItem(db: ModuleDbClient, id: string): Promise<HandlerResponse> {
  const [row] = await db.query(
    `SELECT i.*,
            c.name AS category_name,
            (i.min_stock IS NOT NULL AND i.quantity <= i.min_stock) AS is_low_stock,
            (i.expiry_date IS NOT NULL AND i.expiry_date <= CURRENT_DATE) AS is_expired,
            (i.expiry_date - CURRENT_DATE) AS days_until_expiry
     FROM pantry_items i
     LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.id = $1`,
    [id],
  );
  if (!row) return notFound("item");
  return ok(row);
}

async function createItem(
  db: ModuleDbClient,
  input: ItemInput,
  userId: string,
  addedVia: "manual" | "ai_scan",
): Promise<HandlerResponse> {
  if (!input.name || !input.name.trim()) return badRequest("name is required");
  const [row] = await db.query(
    `INSERT INTO pantry_items
       (name, category_id, quantity, unit, location, expiry_date, min_stock, notes, added_via, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      input.name.trim(),
      input.category_id ?? null,
      input.quantity ?? 0,
      input.unit ?? null,
      input.location ?? null,
      input.expiry_date ?? null,
      input.min_stock ?? null,
      input.notes ?? null,
      addedVia,
      userId,
    ],
  );
  return created(row);
}

async function createItemsBulk(
  db: ModuleDbClient,
  input: { items: ItemInput[] } | undefined,
  userId: string,
): Promise<HandlerResponse> {
  const items = input?.items ?? [];
  if (items.length === 0) return badRequest("items must be a non-empty array");
  const saved = [];
  for (const it of items) {
    if (!it.name || !it.name.trim()) continue; // skip rows the user cleared entirely before confirming
    const [row] = await db.query(
      `INSERT INTO pantry_items
         (name, category_id, quantity, unit, location, expiry_date, min_stock, notes, added_via, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ai_scan',$9)
       RETURNING *`,
      [
        it.name.trim(),
        it.category_id ?? null,
        it.quantity ?? 0,
        it.unit ?? null,
        it.location ?? null,
        it.expiry_date ?? null,
        it.min_stock ?? null,
        it.notes ?? null,
        userId,
      ],
    );
    saved.push(row);
  }
  return created(saved);
}

async function updateItem(db: ModuleDbClient, id: string, input: Partial<ItemInput>): Promise<HandlerResponse> {
  const n = (v: unknown) => (v === undefined || v === "" ? null : v);

  if (input.name !== undefined && !input.name.trim()) return badRequest("name cannot be empty");

  const [row] = await db.query(
    `UPDATE pantry_items SET
       name        = COALESCE($2, name),
       category_id = $3,
       quantity    = COALESCE($4, quantity),
       unit        = $5,
       location    = $6,
       expiry_date = $7,
       min_stock   = $8,
       notes       = $9,
       updated_at  = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      n(input.name),
      n(input.category_id),
      n(input.quantity),
      n(input.unit),
      n(input.location),
      n(input.expiry_date),
      n(input.min_stock),
      n(input.notes),
    ],
  );
  if (!row) return notFound("item");
  return ok(row);
}

async function deleteItem(db: ModuleDbClient, id: string): Promise<HandlerResponse> {
  const rows = await db.query<{ id: string }>(`DELETE FROM pantry_items WHERE id = $1 RETURNING id`, [id]);
  if (rows.length === 0) return notFound("item");
  return noContent();
}

// ── AI provider settings ─────────────────────────────────────────────────────
//
// Same reasoning as recipes: managing the API keys is Admin-only (shared,
// billable credentials for the whole household, not per-user data). Actually
// *using* a configured provider to scan a receipt (scanReceipt below) is not
// gated - any user who can add items can trigger a scan.

const ADMIN_ROLES = ["super-admin", "org-admin"];

function isAdmin(auth: ModuleAuthContext): boolean {
  return auth.roles.some((r) => ADMIN_ROLES.includes(r));
}

function forbidden(): HandlerResponse {
  return { status: 403, body: { error: "Forbidden" } };
}

interface AiProviderRow {
  id: string;
  provider: AiProviderName;
  api_key_enc: string;
  model: string;
  enabled: boolean;
  is_default: boolean;
  created_by_enc: string;
  created_at: string;
  updated_at: string;
}

async function listAiProviders(db: ModuleDbClient, auth: ModuleAuthContext): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  const rows = await db.query<AiProviderRow>(`SELECT * FROM ai_pantry_providers ORDER BY provider ASC`);
  return ok(
    rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      enabled: r.enabled,
      is_default: r.is_default,
      has_key: true,
      updated_at: r.updated_at,
    })),
  );
}

async function upsertAiProvider(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  provider: string,
  body: unknown,
  piiCrypto: ModulePiiCrypto,
): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  if (!AI_PROVIDER_NAMES.includes(provider as AiProviderName)) {
    return badRequest(`provider must be one of: ${AI_PROVIDER_NAMES.join(", ")}`);
  }
  const encKey = piiCrypto.key;
  if (!encKey) return { status: 500, body: { error: "MODULAB_MODULE_PII_KEY not configured on server" } };

  const { api_key, model, enabled, is_default } = body as {
    api_key?: string;
    model?: string;
    enabled?: boolean;
    is_default?: boolean;
  };

  const [existing] = await db.query<AiProviderRow>(`SELECT * FROM ai_pantry_providers WHERE provider = $1`, [provider]);
  if (!existing && !api_key) return badRequest("api_key is required when configuring a provider for the first time");

  const resolvedModel = (model && model.trim()) || existing?.model || AI_PROVIDER_DEFAULT_MODELS[provider as AiProviderName];
  const resolvedEnabled = enabled ?? existing?.enabled ?? true;
  const resolvedIsDefault = is_default ?? existing?.is_default ?? false;
  const createdByEnc = existing?.created_by_enc ?? (await encrypt(encKey, auth.userEmail));

  if (resolvedIsDefault) {
    await db.query(`UPDATE ai_pantry_providers SET is_default = false WHERE provider != $1`, [provider]);
  }

  if (api_key) {
    const apiKeyEnc = await encrypt(encKey, api_key);
    await db.query(
      `INSERT INTO ai_pantry_providers (provider, api_key_enc, model, enabled, is_default, created_by_enc)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider) DO UPDATE SET
         api_key_enc = EXCLUDED.api_key_enc, model = EXCLUDED.model,
         enabled = EXCLUDED.enabled, is_default = EXCLUDED.is_default, updated_at = now()`,
      [provider, apiKeyEnc, resolvedModel, resolvedEnabled, resolvedIsDefault, createdByEnc],
    );
  } else {
    await db.query(
      `UPDATE ai_pantry_providers SET model = $2, enabled = $3, is_default = $4, updated_at = now() WHERE provider = $1`,
      [provider, resolvedModel, resolvedEnabled, resolvedIsDefault],
    );
  }

  return ok({ provider, model: resolvedModel, enabled: resolvedEnabled, is_default: resolvedIsDefault, has_key: true });
}

async function deleteAiProvider(db: ModuleDbClient, auth: ModuleAuthContext, provider: string): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  const rows = await db.query<{ provider: string }>(`DELETE FROM ai_pantry_providers WHERE provider = $1 RETURNING provider`, [provider]);
  if (rows.length === 0) return notFound("provider config");
  return noContent();
}

async function listAiProviderModels(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  provider: string,
  piiCrypto: ModulePiiCrypto,
): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  if (!AI_PROVIDER_NAMES.includes(provider as AiProviderName)) {
    return badRequest(`provider must be one of: ${AI_PROVIDER_NAMES.join(", ")}`);
  }

  // Whole body in one try/catch (same hardening as recipes, 2026-07-12
  // postmortem: an escaped exception here surfaces as a bare, bodyless
  // error that the frontend can't extract a message from at all).
  try {
    const encKey = piiCrypto.key;
    if (!encKey) return { status: 500, body: { error: "MODULAB_MODULE_PII_KEY not configured on server" } };

    const [existing] = await db.query<AiProviderRow>(`SELECT * FROM ai_pantry_providers WHERE provider = $1`, [provider]);
    if (!existing) return { status: 503, body: { error: "no API key configured for this provider" } };

    const apiKey = await decrypt(encKey, existing.api_key_enc);
    const models = await listAvailableModels(provider as AiProviderName, apiKey);
    return ok({ models });
  } catch (err) {
    console.error(`[pantry] listAiProviderModels(${provider}) failed:`, err);
    const message = err instanceof AiProviderError ? err.message : String(err);
    return { status: 502, body: { error: `could not list models (${provider}): ${message}` } };
  }
}

// ── Receipt scan ──────────────────────────────────────────────────────────────

const MAX_SCAN_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB - generous for a phone photo of a receipt

const SUPPORTED_SCAN_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function scanReceipt(
  db: ModuleDbClient,
  input: { file_base64?: string; file_mime_type?: string; provider?: string } | undefined,
  piiCrypto: ModulePiiCrypto,
): Promise<HandlerResponse> {
  // Whole body in one try/catch - same 2026-07-12 hardening rationale as
  // recipes' estimateNutritionWithAi: any unexpected failure here must
  // become a structured JSON response, never an uncaught exception.
  try {
    // file_base64/file_mime_type come straight from the multipart upload -
    // Core's ModuleProxyHandler (router.go) writes the file to this
    // module's storage dir itself AND includes the same bytes, base64-
    // encoded, in this request's JSON body (2026-07-18 change, see
    // saveUploadedFile/uploadedFile in router.go). This handler never reads
    // from the filesystem - no assumption about this worker's own storage
    // path or dataDir layout needed.
    const fileB64 = input?.file_base64;
    const mimeType = input?.file_mime_type;
    if (!fileB64 || !mimeType) return badRequest("a receipt photo upload (multipart field \"file\") is required");
    if (!SUPPORTED_SCAN_MIME_TYPES.has(mimeType)) {
      return badRequest(`unsupported image type ${mimeType} (expected jpg/png/webp)`);
    }
    // Rough byte-size check on the base64 string (4/3 expansion) rather than
    // decoding first - cheap rejection of an oversized upload before doing
    // any real work. Core's own MaxUploadBodyBytes already caps the multipart
    // upload itself; this is a second, receipt-scan-specific ceiling since a
    // huge image is mostly wasted provider tokens, not a security concern.
    if (fileB64.length * 0.75 > MAX_SCAN_IMAGE_BYTES) {
      return badRequest(`uploaded image is too large (max ${MAX_SCAN_IMAGE_BYTES} bytes)`);
    }

    const requestedProvider = input?.provider;
    if (requestedProvider && !AI_PROVIDER_NAMES.includes(requestedProvider as AiProviderName)) {
      return badRequest(`provider must be one of: ${AI_PROVIDER_NAMES.join(", ")}`);
    }

    const [row] = requestedProvider
      ? await db.query<AiProviderRow>(`SELECT * FROM ai_pantry_providers WHERE provider = $1 AND enabled = true`, [requestedProvider])
      : await db.query<AiProviderRow>(`SELECT * FROM ai_pantry_providers WHERE enabled = true ORDER BY is_default DESC, updated_at DESC LIMIT 1`);
    if (!row) {
      return badRequest(
        requestedProvider
          ? `provider "${requestedProvider}" is not configured or disabled - set it up under Settings first`
          : "no AI provider is configured - set one up under Settings first",
      );
    }

    const encKey = piiCrypto.key;
    if (!encKey) return { status: 500, body: { error: "MODULAB_MODULE_PII_KEY not configured on server" } };

    const apiKey = await decrypt(encKey, row.api_key_enc);
    const items = await scanReceiptWithAi(row.provider, apiKey, row.model, fileB64, mimeType);

    if (items.length === 0) {
      return badRequest("the AI provider could not identify any items on this receipt");
    }

    return ok({ items, ai_provider: row.provider, ai_model: row.model });
  } catch (err) {
    console.error(`[pantry] scanReceipt failed:`, err);
    const message = err instanceof AiProviderError ? err.message : String(err);
    return { status: 502, body: { error: `receipt scan failed: ${message}` } };
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function segId(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[1] ?? "";
}

function ok(body: unknown): HandlerResponse {
  return { status: 200, body };
}
function created(body: unknown): HandlerResponse {
  return { status: 201, body };
}
function noContent(): HandlerResponse {
  return { status: 204, body: null };
}
function notFound(what: string): HandlerResponse {
  return { status: 404, body: { error: `${what} not found` } };
}
function badRequest(message: string): HandlerResponse {
  return { status: 400, body: { error: message } };
}

// Same reasoning/implementation as recipes' isSafeFilePath: image_path/
// file_path is meant to be a relative path under this module's own storage
// directory, returned by a prior upload call - never a value the client is
// free to invent wholesale (path traversal / scheme-injection guard).
function isSafeFilePath(value: string): boolean {
  if (!value || value.includes("..") || value.includes("://") || value.startsWith("/")) return false;
  const slashIdx = value.indexOf("/");
  const colonIdx = value.indexOf(":");
  if (colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) return false;
  return true;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ItemInput {
  name: string;
  category_id?: string | null;
  quantity?: number;
  unit?: string | null;
  location?: string | null;
  expiry_date?: string | null;
  min_stock?: number | null;
  notes?: string | null;
}
