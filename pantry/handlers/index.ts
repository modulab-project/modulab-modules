/**
 * Pantry module — Deno Tier 3 handler
 *
 * Routes (all under /v1/modules/pantry/api/):
 *
 * Items (= products, one row per distinct product - see migrations/
 * 0001_initial.sql's doc comment. quantity/expiry_date/location live on
 * batches instead, see below)
 *   GET    /items                 list all (+ filter by category, location, search, low_stock, expiring_soon)
 *                                  each row includes aggregated quantity (SUM of its batches) and
 *                                  the nearest (soonest) expiry_date across its batches
 *   GET    /items/:id             detail, including its batches array
 *   POST   /items                 create an item, optionally with one initial batch
 *   PATCH  /items/:id             update item-level fields (name/category/unit/min_stock/notes)
 *   DELETE /items/:id             delete (cascades to its batches)
 *   POST   /items/bulk            confirm AI scan suggestions: for each, adds a batch to an
 *                                  existing item with a matching name (case-insensitive), or
 *                                  creates a new item + first batch if none matches
 *   POST   /items/:id/consume     body: { quantity? } (default 1) - take stock OUT (used it
 *                                  up / threw it away), the "how do I remove an item from
 *                                  stock" action (2026-07-19). FEFO: decrements whichever
 *                                  batch expires soonest first, deleting a batch once it
 *                                  hits zero; spills over into the next-soonest batch if the
 *                                  requested amount exceeds the first one found.
 *
 * Batches (one physical lot of an item - quantity, expiry date, storage location)
 *   POST   /items/:id/batches               add a batch to an existing item
 *   PATCH  /items/:id/batches/:batchId       update a batch
 *   DELETE /items/:id/batches/:batchId       remove a batch (e.g. fully used up)
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
 * Locations (storage spots within the one household - cellar, fridge, ...)
 *   GET    /locations              list
 *   POST   /locations              create
 *   PATCH  /locations/:id          update
 *   DELETE /locations/:id          delete
 *
 * AI provider settings — Admin only (mirrors recipes' /ai-providers)
 *   GET    /ai-providers                    list configured providers (keys never returned)
 *   PUT    /ai-providers/:provider          upsert one provider's config
 *   DELETE /ai-providers/:provider          remove one provider's config
 *   GET    /ai-providers/:provider/models   list available models via the provider's own /models API
 *                                            (requires the key to already be saved)
 *   GET    /ai-providers/status             {available: boolean} — NOT admin-gated (unlike the
 *                                            routes above): lets every user's frontend decide
 *                                            whether to show the "Scan receipt" tab at all, without
 *                                            exposing which provider or any key material.
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
    return createItem(db, body as ItemInput, auth.userId);
  }
  if (route === "POST /items/bulk") {
    return createItemsBulk(db, body as { items: ScanConfirmInput[] }, auth.userId);
  }
  if (method === "POST" && pathname.match(/^\/items\/[^/]+\/consume$/)) {
    return consumeItem(db, segId(pathname), body as { quantity?: number } | undefined);
  }
  if (method === "PATCH" && pathname.match(/^\/items\/[^/]+$/)) {
    return updateItem(db, segId(pathname), body as Partial<ItemInput>);
  }
  if (method === "DELETE" && pathname.match(/^\/items\/[^/]+$/)) {
    return deleteItem(db, segId(pathname));
  }

  // ── Batches ───────────────────────────────────────────────────────────────

  if (method === "POST" && pathname.match(/^\/items\/[^/]+\/batches$/)) {
    const itemId = pathname.split("/")[2];
    return createBatch(db, itemId, body as BatchInput, auth.userId, "manual");
  }
  if (method === "PATCH" && pathname.match(/^\/items\/[^/]+\/batches\/[^/]+$/)) {
    const parts = pathname.split("/");
    return updateBatch(db, parts[2], parts[4], body as Partial<BatchInput>);
  }
  if (method === "DELETE" && pathname.match(/^\/items\/[^/]+\/batches\/[^/]+$/)) {
    const parts = pathname.split("/");
    return deleteBatch(db, parts[2], parts[4]);
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

  // ── Locations ─────────────────────────────────────────────────────────────

  if (route === "GET /locations") {
    const rows = await db.query(`SELECT * FROM locations ORDER BY sort_order ASC, name ASC`);
    return ok(rows);
  }
  if (route === "POST /locations") {
    const { name, sort_order } = body as { name: string; sort_order?: number };
    if (!name || !name.trim()) return badRequest("name is required");
    const [row] = await db.query(
      `INSERT INTO locations (name, sort_order) VALUES ($1, $2) RETURNING *`,
      [name.trim(), sort_order ?? 0],
    );
    return created(row);
  }
  if (method === "PATCH" && pathname.match(/^\/locations\/[^/]+$/)) {
    const { name, sort_order } = body as { name?: string; sort_order?: number };
    const [row] = await db.query(
      `UPDATE locations SET
        name       = COALESCE($2, name),
        sort_order = COALESCE($3, sort_order)
       WHERE id = $1 RETURNING *`,
      [segId(pathname), name, sort_order],
    );
    if (!row) return notFound("location");
    return ok(row);
  }
  if (method === "DELETE" && pathname.match(/^\/locations\/[^/]+$/)) {
    await db.query(`DELETE FROM locations WHERE id = $1`, [segId(pathname)]);
    return noContent();
  }

  // ── AI provider settings ─────────────────────────────────────────────────

  // Not admin-gated (unlike every other /ai-providers route below) - lets
  // any user's frontend decide whether to show the "Scan receipt" tab.
  if (route === "GET /ai-providers/status") {
    return aiProviderStatus(db);
  }
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
//
// "Item" = product (pantry_items); quantity/expiry_date/location are always
// aggregated from its batches (pantry_item_batches) here, never stored
// directly on the item - see migrations/0001_initial.sql's doc comment for
// why (2026-07-18 redesign, prompted by "two steaks batches shouldn't be two
// list rows").

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
    // "This item has at least one batch stored at this location" - an item
    // can legitimately have batches spread across several locations.
    conditions.push(`EXISTS (SELECT 1 FROM pantry_item_batches pb WHERE pb.item_id = i.id AND pb.location_id = $${idx})`);
    args.push(location);
    idx++;
  }
  if (lowStockOnly) {
    conditions.push(`i.min_stock IS NOT NULL AND COALESCE(agg.total_quantity, 0) <= i.min_stock`);
  }
  if (expiringSoonOnly) {
    // "Soon" = within 3 days, including already-expired batches.
    conditions.push(`agg.nearest_expiry_date IS NOT NULL AND agg.nearest_expiry_date <= (CURRENT_DATE + INTERVAL '3 days')`);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  args.push(limit, offset);

  const rows = await db.query(
    `SELECT i.*,
            c.name AS category_name,
            COALESCE(agg.total_quantity, 0) AS quantity,
            agg.nearest_expiry_date AS expiry_date,
            COALESCE(agg.batch_count, 0) AS batch_count,
            COALESCE(agg.has_ai_scan_batch, false) AS added_via_ai_scan,
            (i.min_stock IS NOT NULL AND COALESCE(agg.total_quantity, 0) <= i.min_stock) AS is_low_stock,
            (agg.nearest_expiry_date IS NOT NULL AND agg.nearest_expiry_date <= CURRENT_DATE) AS is_expired,
            (agg.nearest_expiry_date - CURRENT_DATE) AS days_until_expiry
     FROM pantry_items i
     LEFT JOIN categories c ON c.id = i.category_id
     LEFT JOIN LATERAL (
       SELECT SUM(quantity) AS total_quantity,
              MIN(expiry_date) AS nearest_expiry_date,
              COUNT(*) AS batch_count,
              bool_or(added_via = 'ai_scan') AS has_ai_scan_batch
       FROM pantry_item_batches
       WHERE item_id = i.id
     ) agg ON true
     ${where}
     ORDER BY i.updated_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    args,
  );

  const [countRow] = await db.query<{ total: string }>(
    `SELECT COUNT(*) AS total
     FROM pantry_items i
     LEFT JOIN LATERAL (
       SELECT SUM(quantity) AS total_quantity, MIN(expiry_date) AS nearest_expiry_date
       FROM pantry_item_batches WHERE item_id = i.id
     ) agg ON true
     ${where}`,
    args.slice(0, -2),
  );

  // See num()'s doc comment - quantity/min_stock arrive as NUMERIC strings.
  const items = rows.map((r: any) => ({ ...r, quantity: num(r.quantity) ?? 0, min_stock: num(r.min_stock) }));

  return ok({ items, total: parseInt(countRow?.total ?? "0") });
}

async function getItem(db: ModuleDbClient, id: string): Promise<HandlerResponse> {
  const [item] = await db.query(
    `SELECT i.*, c.name AS category_name FROM pantry_items i LEFT JOIN categories c ON c.id = i.category_id WHERE i.id = $1`,
    [id],
  );
  if (!item) return notFound("item");

  const batches = await db.query(
    `SELECT b.*, l.name AS location_name
     FROM pantry_item_batches b
     LEFT JOIN locations l ON l.id = b.location_id
     WHERE b.item_id = $1
     ORDER BY b.expiry_date ASC NULLS LAST, b.created_at ASC`,
    [id],
  );

  // See num()'s doc comment - quantity/min_stock arrive as NUMERIC strings.
  return ok({
    ...item,
    min_stock: num((item as any).min_stock),
    batches: batches.map((b: any) => ({ ...b, quantity: num(b.quantity) ?? 0 })),
  });
}

async function createItem(db: ModuleDbClient, input: ItemInput, userId: string): Promise<HandlerResponse> {
  if (!input.name || !input.name.trim()) return badRequest("name is required");

  const [existing] = await db.query<{ id: string }>(`SELECT id FROM pantry_items WHERE lower(name) = lower($1)`, [input.name.trim()]);
  if (existing) return badRequest(`an item named "${input.name.trim()}" already exists - add a batch to it instead of creating a duplicate`);

  const [item] = await db.query(
    `INSERT INTO pantry_items (name, category_id, unit, min_stock, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [input.name.trim(), input.category_id ?? null, input.unit ?? null, input.min_stock ?? null, input.notes ?? null, userId],
  );

  // An initial batch is optional (e.g. adding a bare product definition with
  // nothing in stock yet) but the common case - the frontend's "New item"
  // form always includes one, matching the old single-table UX.
  if (input.batch && (input.batch.quantity != null || input.batch.expiry_date || input.batch.location_id)) {
    await db.query(
      `INSERT INTO pantry_item_batches (item_id, quantity, expiry_date, location_id, added_via, created_by)
       VALUES ($1,$2,$3,$4,'manual',$5)`,
      [item.id, input.batch.quantity ?? 0, input.batch.expiry_date ?? null, input.batch.location_id ?? null, userId],
    );
  }

  return created(await getItem(db, item.id).then((r) => r.body));
}

async function updateItem(db: ModuleDbClient, id: string, input: Partial<ItemInput>): Promise<HandlerResponse> {
  const n = (v: unknown) => (v === undefined || v === "" ? null : v);

  if (input.name !== undefined && !input.name.trim()) return badRequest("name cannot be empty");
  if (input.name !== undefined) {
    const [dup] = await db.query<{ id: string }>(`SELECT id FROM pantry_items WHERE lower(name) = lower($1) AND id != $2`, [input.name.trim(), id]);
    if (dup) return badRequest(`an item named "${input.name.trim()}" already exists`);
  }

  const [row] = await db.query(
    `UPDATE pantry_items SET
       name        = COALESCE($2, name),
       category_id = $3,
       unit        = $4,
       min_stock   = $5,
       notes       = $6,
       updated_at  = now()
     WHERE id = $1 RETURNING *`,
    [id, n(input.name), n(input.category_id), n(input.unit), n(input.min_stock), n(input.notes)],
  );
  if (!row) return notFound("item");
  return ok(await getItem(db, id).then((r) => r.body));
}

async function deleteItem(db: ModuleDbClient, id: string): Promise<HandlerResponse> {
  const rows = await db.query<{ id: string }>(`DELETE FROM pantry_items WHERE id = $1 RETURNING id`, [id]);
  if (rows.length === 0) return notFound("item");
  return noContent();
}

// ── Batch helpers ─────────────────────────────────────────────────────────────

async function createBatch(
  db: ModuleDbClient,
  itemId: string,
  input: BatchInput,
  userId: string,
  addedVia: "manual" | "ai_scan",
): Promise<HandlerResponse> {
  const [item] = await db.query<{ id: string }>(`SELECT id FROM pantry_items WHERE id = $1`, [itemId]);
  if (!item) return notFound("item");

  const [row] = await db.query(
    `INSERT INTO pantry_item_batches (item_id, quantity, expiry_date, location_id, added_via, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [itemId, input.quantity ?? 0, input.expiry_date ?? null, input.location_id ?? null, addedVia, userId],
  );
  return created({ ...row, quantity: num((row as any).quantity) ?? 0 });
}

async function updateBatch(db: ModuleDbClient, itemId: string, batchId: string, input: Partial<BatchInput>): Promise<HandlerResponse> {
  const n = (v: unknown) => (v === undefined || v === "" ? null : v);
  const [row] = await db.query(
    `UPDATE pantry_item_batches SET
       quantity    = COALESCE($3, quantity),
       expiry_date = $4,
       location_id = $5,
       updated_at  = now()
     WHERE id = $1 AND item_id = $2 RETURNING *`,
    [batchId, itemId, n(input.quantity), n(input.expiry_date), n(input.location_id)],
  );
  if (!row) return notFound("batch");
  return ok({ ...row, quantity: num((row as any).quantity) ?? 0 });
}

async function deleteBatch(db: ModuleDbClient, itemId: string, batchId: string): Promise<HandlerResponse> {
  const rows = await db.query<{ id: string }>(`DELETE FROM pantry_item_batches WHERE id = $1 AND item_id = $2 RETURNING id`, [batchId, itemId]);
  if (rows.length === 0) return notFound("batch");
  return noContent();
}

async function createItemsBulk(
  db: ModuleDbClient,
  input: { items: ScanConfirmInput[] } | undefined,
  userId: string,
): Promise<HandlerResponse> {
  const items = input?.items ?? [];
  if (items.length === 0) return badRequest("items must be a non-empty array");

  const results = [];
  for (const it of items) {
    if (!it.name || !it.name.trim()) continue; // skip rows the user cleared entirely before confirming
    const name = it.name.trim();

    // Match-or-create by name (case-insensitive) - this is the whole point
    // of the redesign: scanning the same product twice adds a second batch
    // to the existing item instead of creating a duplicate item row.
    const [existing] = await db.query<{ id: string }>(`SELECT id FROM pantry_items WHERE lower(name) = lower($1)`, [name]);

    let itemId: string;
    if (existing) {
      itemId = existing.id;
    } else {
      const [newItem] = await db.query<{ id: string }>(
        `INSERT INTO pantry_items (name, category_id, unit, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [name, it.category_id ?? null, it.unit ?? null, userId],
      );
      itemId = newItem.id;
    }

    const [batch] = await db.query(
      `INSERT INTO pantry_item_batches (item_id, quantity, expiry_date, location_id, added_via, created_by)
       VALUES ($1,$2,$3,$4,'ai_scan',$5)
       RETURNING *`,
      [itemId, it.quantity ?? 1, it.expiry_date ?? null, it.location_id ?? null, userId],
    );
    results.push({ item_id: itemId, matched_existing_item: !!existing, batch: { ...batch, quantity: num((batch as any).quantity) ?? 0 } });
  }
  return created(results);
}

// "How do I take an item out of stock?" (2026-07-19 user question) - there
// was no dedicated action for this before; the only way to reduce stock was
// editing/deleting a batch by hand. This is the one-tap version: FEFO
// (first-expiry-first-out), so using up whatever's closest to its best-before
// date happens automatically instead of the user having to pick a batch.
async function consumeItem(db: ModuleDbClient, itemId: string, input: { quantity?: number } | undefined): Promise<HandlerResponse> {
  const amount = input?.quantity && input.quantity > 0 ? input.quantity : 1;

  const [item] = await db.query<{ id: string }>(`SELECT id FROM pantry_items WHERE id = $1`, [itemId]);
  if (!item) return notFound("item");

  const batches = await db.query<{ id: string; quantity: unknown }>(
    `SELECT id, quantity FROM pantry_item_batches
     WHERE item_id = $1 AND quantity > 0
     ORDER BY expiry_date ASC NULLS LAST, created_at ASC`,
    [itemId],
  );

  let remaining = amount;
  for (const b of batches) {
    if (remaining <= 0) break;
    const q = num(b.quantity) ?? 0;
    if (q <= remaining) {
      // This batch is fully used up by the request - remove it rather than
      // leaving a zero-quantity row behind.
      await db.query(`DELETE FROM pantry_item_batches WHERE id = $1`, [b.id]);
      remaining -= q;
    } else {
      await db.query(`UPDATE pantry_item_batches SET quantity = quantity - $2, updated_at = now() WHERE id = $1`, [b.id, remaining]);
      remaining = 0;
    }
  }

  return ok(await getItem(db, itemId).then((r) => r.body));
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

async function aiProviderStatus(db: ModuleDbClient): Promise<HandlerResponse> {
  const rows = await db.query<{ exists: number }>(`SELECT 1 AS exists FROM ai_pantry_providers WHERE enabled = true LIMIT 1`);
  return ok({ available: rows.length > 0 });
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

const MAX_SCAN_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB - a phone photo needs ~8MB headroom, a scanned multi-page PDF can run larger

// PDF added 2026-07-19 ("Bon geht nur als Foto? nicht als PDF?") - Gemini and
// Claude both take a PDF through the same code path as an image (see
// ai-providers.ts), just with a different mimeType/content-block shape.
// OpenAI has no PDF input path here and rejects it itself in callOpenAi with
// a clear error, rather than this allowlist silently blocking it earlier for
// every provider regardless of which one is actually configured.
const SUPPORTED_SCAN_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

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

// Postgres NUMERIC(10,3) columns (quantity, min_stock) come back from the
// driver as fixed-scale strings, e.g. "80.000" - passed straight through to
// JSON and displayed as-is, that reads to a user as "80.000" (eighty
// thousand) rather than "80" (2026-07-19 bug report). Every numeric field
// that reaches the frontend must go through this first, so it serializes as
// a plain JS number (80, not "80.000") and trailing zeros disappear.
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
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
  unit?: string | null;
  min_stock?: number | null;
  notes?: string | null;
  batch?: BatchInput; // only read by createItem, for the "new item + first batch" combined form
}

interface BatchInput {
  quantity?: number;
  expiry_date?: string | null;
  location_id?: string | null;
}

// One suggested row from a receipt scan, as confirmed/edited by the user in
// POST /items/bulk's request body.
interface ScanConfirmInput {
  name: string;
  category_id?: string | null;
  unit?: string | null;
  quantity?: number;
  expiry_date?: string | null;
  location_id?: string | null;
}
