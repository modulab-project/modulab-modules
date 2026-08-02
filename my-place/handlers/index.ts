/**
 * Vacation Spots module — Deno Tier 2 handler
 *
 * Routes (all under /v1/modules/my-places/api/):
 *
 * Spots
 *   GET    /spots                      list all (+ filter: ?trip=&category=)
 *   GET    /spots/:id                  detail with photos
 *   POST   /spots                      create
 *   PATCH  /spots/:id                  update (own only)
 *   DELETE /spots/:id                  delete (own only)
 *
 * Spot photos
 *   POST   /spots/:id/photos           attach uploaded photo (Core writes file, sends path)
 *   DELETE /spots/:id/photos/:photoId  remove photo (own spot only)
 *
 * Trips
 *   GET    /trips                      list all
 *   POST   /trips                      create
 *   PATCH  /trips/:id                  update (own only)
 *   DELETE /trips/:id                  delete (own only)
 *
 * Categories
 *   GET    /categories                 list all
 *   POST   /categories                 create
 *   PATCH  /categories/:id             update (own only, system categories protected)
 *   DELETE /categories/:id             delete (own only)
 */

import type { HandlerRequest, HandlerResponse, ModuleDbClient, ModuleAuthContext, ModulePiiCrypto } from "./types.ts";
import { encrypt, decrypt } from "./crypto.ts";

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: HandlerRequest): Promise<HandlerResponse> {
  const { method, path, body, auth, db, crypto: piiCrypto, legacyCrypto } = req;

  const encKey = piiCrypto.key;

  const qIdx = path.indexOf("?");
  const pathname = qIdx === -1 ? path : path.slice(0, qIdx);
  const route = `${method} ${pathname}`;

  // ── Settings (admin: GET + PUT, all users: GET /config) ──────────────────
  //
  // Core collapsed its role model from four roles to three on 2026-07-29
  // (super-admin/org-admin/user/pending -> admin/user/pending, see
  // backend/internal/auth/role.go's RoleAdmin/RoleUser/RolePending) - the
  // three admin checks below (here, PUT /settings, and migratePiiKey further
  // down) still checked the two old role names until found and fixed
  // 2026-08-02, which meant every admin-only action here silently rejected
  // every real admin for those four days.

  if (route === "GET /config") {
    const [row] = await db.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'maptiler_api_key'`,
    );
    let maptilerKey = "";
    if (row?.value && encKey) {
      maptilerKey = await decrypt(encKey, row.value).catch((err) => {
        // Logged (found 2026-07-05): a decrypt failure here previously just
        // silently reported map_configured: false with no trace of why —
        // indistinguishable from "never configured" in the logs.
        console.error("[my-place] GET /config: failed to decrypt maptiler_api_key:", err);
        return "";
      });
    }
    return ok({
      map_configured: maptilerKey.length > 0,
      map_style_url: maptilerKey
        ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${maptilerKey}`
        : null,
    });
  }

  if (route === "GET /settings") {
    if (!auth.roles.includes("admin")) {
      return forbidden();
    }
    const [row] = await db.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'maptiler_api_key'`,
    );
    return ok({ maptiler_api_key: row?.value ? "••••••••" : "" });
  }

  if (route === "PUT /settings") {
    try {
      if (!auth.roles.includes("admin")) {
        return forbidden();
      }
      if (!encKey) {
        return { status: 500, body: { error: "pii_key_not_configured" } };
      }
      const { maptiler_api_key } = body as { maptiler_api_key?: string };
      if (maptiler_api_key !== undefined) {
        const encrypted = await encrypt(encKey, maptiler_api_key);
        await db.query(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('maptiler_api_key', $1, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [encrypted],
        );
      }
      return ok({ ok: true });
    } catch (err) {
      return { status: 500, body: { error: String(err) } };
    }
  }

  // ── Spots ──────────────────────────────────────────────────────────────────

  if (route === "GET /spots")
    return listSpots(db, path, encKey);
  if (method === "GET" && pathname.match(/^\/spots\/[^/]+$/) && !pathname.endsWith("/photos"))
    return getSpot(db, segId(pathname), encKey);
  if (route === "POST /spots")
    return createSpot(db, body as SpotInput, auth.userId, encKey);
  if (method === "PATCH" && pathname.match(/^\/spots\/[^/]+$/))
    return updateSpot(db, segId(pathname), body as Partial<SpotInput>, body, auth.userId, encKey);
  if (method === "DELETE" && pathname.match(/^\/spots\/[^/]+$/))
    return deleteSpot(db, segId(pathname), auth.userId);

  // ── Spot photos ────────────────────────────────────────────────────────────

  if (method === "POST" && pathname.match(/^\/spots\/[^/]+\/photos$/)) {
    const spotId = pathname.split("/")[2];
    const { file_path, position } = body as { file_path: string; position?: number };
    if (!isSafeFilePath(file_path)) return badRequest("invalid_file_path");
    if (!(await ownerCheck(db, "spots", spotId, auth.userId))) return forbidden();
    // Cap on photos per spot (found 2026-07-05): nothing previously limited
    // how many photos could be attached to a single spot.
    const [{ count }] = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM spot_photos WHERE spot_id = $1`,
      [spotId],
    );
    if (parseInt(count, 10) >= MAX_PHOTOS_PER_SPOT) {
      return badRequest("max_photos_reached", { max: MAX_PHOTOS_PER_SPOT });
    }
    const [row] = await db.query(
      `INSERT INTO spot_photos (spot_id, file_path, position, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [spotId, file_path, position ?? 0, auth.userId],
    );
    return created(row);
  }

  if (method === "DELETE" && pathname.match(/^\/spots\/[^/]+\/photos\/[^/]+$/)) {
    const parts = pathname.split("/");
    const spotId = parts[2];
    const photoId = parts[4];
    // Allow deletion if user owns the spot OR the photo itself
    const spotOwner = await ownerCheck(db, "spots", spotId, auth.userId);
    const photoOwner = await ownerCheck(db, "spot_photos", photoId, auth.userId);
    if (!spotOwner && !photoOwner) return forbidden();
    await db.query(`DELETE FROM spot_photos WHERE id = $1 AND spot_id = $2`, [photoId, spotId]);
    return noContent();
  }

  // ── Trips ──────────────────────────────────────────────────────────────────

  if (route === "GET /trips") {
    const rows = await db.query(`SELECT * FROM trips ORDER BY year DESC NULLS LAST, name ASC LIMIT 500`);
    return ok(rows);
  }
  if (route === "POST /trips") {
    const { name, year, description } = body as TripInput;
    if (!name || !name.trim()) return badRequest("name_required");
    const [row] = await db.query(
      `INSERT INTO trips (name, year, description, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), year ?? null, description ?? "", auth.userId],
    );
    return created(row);
  }
  if (method === "PATCH" && pathname.match(/^\/trips\/[^/]+$/)) {
    const id = segId(pathname);
    const { name, year, description } = body as Partial<TripInput>;
    if (name !== undefined && !name.trim()) return badRequest("name_empty");
    // Bugfix (2026-07-05): ownership was checked via a separate SELECT, then
    // the UPDATE ran without any ownership clause of its own — a second
    // request racing between the two could mutate a row the check had
    // already rejected (TOCTOU). The ownership condition now lives directly
    // in the UPDATE's WHERE clause; zero rows returned means either the
    // trip doesn't exist or the caller doesn't own it, and both cases are
    // reported identically as "not found" (same as before this fix, via
    // ownerCheck()'s forbidden()) to avoid leaking which one it was — see
    // unifi-network's approveDeviceChange()/rejectDeviceChange() for the
    // same pattern this mirrors.
    const [row] = await db.query(
      `UPDATE trips SET
         name        = COALESCE($3, name),
         year        = COALESCE($4, year),
         description = COALESCE($5, description),
         updated_at  = now()
       WHERE id = $1 AND created_by = $2 AND created_by != 'system' RETURNING *`,
      [id, auth.userId, name?.trim() ?? null, year ?? null, description ?? null],
    );
    if (!row) return notFound("trip");
    return ok(row);
  }
  if (method === "DELETE" && pathname.match(/^\/trips\/[^/]+$/)) {
    const id = segId(pathname);
    const rows = await db.query<{ id: string }>(
      `DELETE FROM trips WHERE id = $1 AND created_by = $2 AND created_by != 'system' RETURNING id`,
      [id, auth.userId],
    );
    if (rows.length === 0) return notFound("trip");
    return noContent();
  }

  // ── Categories ─────────────────────────────────────────────────────────────

  if (route === "GET /categories") {
    const rows = await db.query(`SELECT * FROM categories ORDER BY name ASC LIMIT 500`);
    return ok(rows);
  }
  if (route === "POST /categories") {
    const { name, color, icon, sort_order } = body as CategoryInput;
    if (!name || !name.trim()) return badRequest("name_required");
    const [row] = await db.query(
      `INSERT INTO categories (name, color, icon, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), color ?? "#888780", icon ?? "ti-map-pin", sort_order ?? 0, auth.userId],
    );
    return created(row);
  }
  if (method === "PATCH" && pathname.match(/^\/categories\/[^/]+$/)) {
    const id = segId(pathname);
    const { name, color, icon, sort_order } = body as Partial<CategoryInput>;
    if (name !== undefined && !name.trim()) return badRequest("name_empty");
    // Same TOCTOU fix as trips/spots above: ownership condition moved into
    // the UPDATE's own WHERE clause instead of a prior separate SELECT.
    const [row] = await db.query(
      `UPDATE categories SET
         name       = COALESCE($3, name),
         color      = COALESCE($4, color),
         icon       = COALESCE($5, icon),
         sort_order = COALESCE($6, sort_order)
       WHERE id = $1 AND created_by = $2 AND created_by != 'system' RETURNING *`,
      [id, auth.userId, name?.trim() ?? null, color ?? null, icon ?? null, sort_order ?? null],
    );
    if (!row) return notFound("category");
    return ok(row);
  }
  if (method === "DELETE" && pathname.match(/^\/categories\/[^/]+$/)) {
    const id = segId(pathname);
    const rows = await db.query<{ id: string }>(
      `DELETE FROM categories WHERE id = $1 AND created_by = $2 AND created_by != 'system' RETURNING id`,
      [id, auth.userId],
    );
    if (rows.length === 0) return notFound("category");
    return noContent();
  }

  // ── PII key migration (Admin only, Core-triggered) ────────────────────────

  if (route === "POST /admin/migrate-pii-key") {
    return migratePiiKey(db, auth, piiCrypto, legacyCrypto);
  }

  return { status: 404, body: { error: "not_found" } };
}

// ── PII key migration ─────────────────────────────────────────────────────────
//
// One-time action triggered by Core's POST /v1/admin/modules/{name}/
// migrate-pii-key (adminReauthOnly-gated, see backend/internal/modules/
// handlers.go's MigratePIIKeyHandler). Core keeps piiCrypto.key as the OLD
// raw shared MODULAB_MODULE_PII_KEY until this handler succeeds - it only
// exposes this module's new per-module HKDF-derived key via legacyCrypto.key
// during the migration window (see deno.go's buildWorker doc comment on why
// - an earlier version got this backwards and broke every module's existing
// PII the moment it shipped). Re-encrypts this module's two PII surfaces -
// settings.value (maptiler_api_key) and spots.name_enc/note_enc - from the
// old key to the new one, so Core can then flip piiCrypto.key over to it
// for good (see docs/Modul-DB-Sandbox_Plan_2026-08-02.md Part B and
// internal/crypto/modulekey.go's DeriveModuleKey).
//
// Idempotent/retry-safe: reencryptField() below tries the NEW key first - a
// value already migrated by an earlier, partially-failed run decrypts fine
// under newKey and is left untouched, so re-running this after a partial
// failure only redoes the rows that didn't finish. Core only calls
// SetModulePIIMigrated (marking the module done, and only then switching
// piiCrypto.key over) on a 200 from this handler - any non-2xx is always
// safe to retry.
async function migratePiiKey(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  piiCrypto: ModulePiiCrypto,
  legacyCrypto: ModulePiiCrypto,
): Promise<HandlerResponse> {
  if (!auth.roles.includes("admin")) return forbidden();
  const oldKey = piiCrypto.key; // still the raw shared key pre-migration
  const newKey = legacyCrypto.key; // this module's derived key, the migration target
  if (!newKey) {
    // No derived key granted - either Core already completed migration for
    // this module (pii_migrated_at already set, piiCrypto.key IS the
    // derived key by now) or this module never had PII configured to begin
    // with. Either way there's nothing to re-encrypt; treat as success
    // rather than erroring on a duplicate/late-retried call.
    return ok({ migrated_rows: 0, note: "no_legacy_key_granted" });
  }
  if (!oldKey) return { status: 500, body: { error: "pii_key_not_configured" } };

  let migratedRows = 0;

  const [settingsRow] = await db.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'maptiler_api_key'`,
  );
  if (settingsRow?.value) {
    const reencrypted = await reencryptField(settingsRow.value, newKey, oldKey);
    if (reencrypted !== settingsRow.value) {
      await db.query(
        `UPDATE settings SET value = $1, updated_at = now() WHERE key = 'maptiler_api_key'`,
        [reencrypted],
      );
      migratedRows++;
    }
  }

  const spots = await db.query<{ id: string; name_enc: string; note_enc: string | null }>(
    `SELECT id, name_enc, note_enc FROM spots`,
  );
  for (const spot of spots) {
    const nameEnc = await reencryptField(spot.name_enc, newKey, oldKey);
    const noteEnc = spot.note_enc ? await reencryptField(spot.note_enc, newKey, oldKey) : spot.note_enc;
    if (nameEnc !== spot.name_enc || noteEnc !== spot.note_enc) {
      await db.query(`UPDATE spots SET name_enc = $2, note_enc = $3 WHERE id = $1`, [spot.id, nameEnc, noteEnc]);
      migratedRows++;
    }
  }

  return ok({ migrated_rows: migratedRows });
}

// Re-encrypts one AES-256-GCM ciphertext column from the legacy shared key to
// this module's new derived key. Tries newKey first (see migratePiiKey's doc
// comment on retry-safety) - only falls through to legacyKey if that fails,
// which also means a genuinely corrupt/tampered value throws here (from the
// legacyKey attempt) rather than being silently swallowed.
async function reencryptField(value: string, newKey: CryptoKey, legacyKey: CryptoKey): Promise<string> {
  try {
    await decrypt(newKey, value);
    return value; // already re-encrypted under the new key
  } catch {
    const plain = await decrypt(legacyKey, value);
    return encrypt(newKey, plain);
  }
}

// ── Spot helpers ───────────────────────────────────────────────────────────────

async function listSpots(db: ModuleDbClient, path: string, encKey: CryptoKey | null): Promise<HandlerResponse> {
  const params = new URL("http://x" + path).searchParams;
  const tripId = params.get("trip") ?? "";
  const categoryId = params.get("category") ?? "";

  const conditions: string[] = [];
  const args: unknown[] = [];
  let idx = 1;
  if (tripId)     { conditions.push(`s.trip_id = $${idx++}`);     args.push(tripId); }
  if (categoryId) { conditions.push(`s.category_id = $${idx++}`); args.push(categoryId); }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  const rows = await db.query<SpotRow>(
    `SELECT s.*,
            t.name  AS trip_name,
            t.year  AS trip_year,
            c.name  AS category_name,
            c.color AS category_color,
            c.icon  AS category_icon,
            COALESCE(
              json_agg(p.file_path ORDER BY p.position ASC)
              FILTER (WHERE p.id IS NOT NULL),
              '[]'::json
            ) AS photo_paths
     FROM spots s
     LEFT JOIN trips      t ON t.id = s.trip_id
     LEFT JOIN categories c ON c.id = s.category_id
     LEFT JOIN spot_photos p ON p.spot_id = s.id
     ${where}
     GROUP BY s.id, t.name, t.year, c.name, c.color, c.icon
     ORDER BY s.created_at DESC
     LIMIT 500`,
    args,
  );

  return ok(await Promise.all(rows.map((r) => decryptSpot(r, encKey))));
}

async function getSpot(db: ModuleDbClient, id: string, encKey: CryptoKey | null): Promise<HandlerResponse> {
  const [row] = await db.query<SpotRow>(
    `SELECT s.*,
            t.name  AS trip_name,
            t.year  AS trip_year,
            c.name  AS category_name,
            c.color AS category_color,
            c.icon  AS category_icon,
            COALESCE(
              json_agg(
                jsonb_build_object('id', p.id, 'file_path', p.file_path, 'position', p.position)
                ORDER BY p.position ASC
              ) FILTER (WHERE p.id IS NOT NULL),
              '[]'::json
            ) AS photos
     FROM spots s
     LEFT JOIN trips      t ON t.id = s.trip_id
     LEFT JOIN categories c ON c.id = s.category_id
     LEFT JOIN spot_photos p ON p.spot_id = s.id
     WHERE s.id = $1
     GROUP BY s.id, t.name, t.year, c.name, c.color, c.icon`,
    [id],
  );
  if (!row) return notFound("spot");
  return ok(await decryptSpot(row, encKey));
}

async function createSpot(db: ModuleDbClient, input: SpotInput, userId: string, encKey: CryptoKey | null): Promise<HandlerResponse> {
  if (!input.name || !input.name.trim()) return badRequest("name_required");
  if (!isValidLatLng(input.lat, input.lng)) return badRequest("invalid_coordinates");
  const nameEnc = encKey ? await encrypt(encKey, input.name.trim()) : input.name.trim();
  const noteEnc = encKey && input.note ? await encrypt(encKey, input.note) : (input.note ?? null);
  const [row] = await db.query<SpotRow>(
    `INSERT INTO spots (trip_id, category_id, name_enc, note_enc, lat, lng, rating, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [input.trip_id ?? null, input.category_id ?? null, nameEnc, noteEnc,
     input.lat, input.lng, input.rating ?? null, userId],
  );
  return created(await decryptSpot(row, encKey));
}

async function updateSpot(
  db: ModuleDbClient,
  id: string,
  input: Partial<SpotInput>,
  rawBody: unknown,
  userId: string,
  encKey: CryptoKey | null,
): Promise<HandlerResponse> {
  if (input.name !== undefined && !input.name.trim()) return badRequest("name_empty");
  if (
    (input.lat !== undefined || input.lng !== undefined) &&
    !isValidLatLng(input.lat ?? 0, input.lng ?? 0)
  ) {
    return badRequest("invalid_coordinates");
  }
  const nameEnc = encKey && input.name ? await encrypt(encKey, input.name.trim()) : (input.name?.trim() ?? null);

  // note_enc distinguishes "field omitted" (keep existing value) from
  // "field explicitly set to null/empty" (clear it) via the noteProvided
  // flag passed into the CASE expression below as its own parameter —
  // without this a PATCH could never intentionally clear note to NULL
  // (found 2026-07-05). Only note supports this: it's the only nullable
  // free-text field on spots (name is required, lat/lng/rating/trip_id/
  // category_id are either required or already fine with COALESCE-only
  // partial updates since clearing them to NULL isn't a real use case here).
  const bodyObj = (rawBody && typeof rawBody === "object") ? (rawBody as Record<string, unknown>) : {};
  const noteProvided = "note" in bodyObj;
  const noteEnc = input.note ? (encKey ? await encrypt(encKey, input.note) : input.note) : null;

  // Bugfix (2026-07-05): ownership was checked via a separate SELECT, then
  // the UPDATE ran without an ownership clause — TOCTOU. The condition now
  // lives in the UPDATE's own WHERE clause; RETURNING empty means not
  // found/forbidden (mirrors unifi-network's approveDeviceChange() pattern).
  const [row] = await db.query<SpotRow>(
    `UPDATE spots SET
       trip_id     = COALESCE($3, trip_id),
       category_id = COALESCE($4, category_id),
       name_enc    = COALESCE($5, name_enc),
       note_enc    = CASE WHEN $6 THEN $7 ELSE note_enc END,
       lat         = COALESCE($8, lat),
       lng         = COALESCE($9, lng),
       rating      = COALESCE($10, rating),
       updated_at  = now()
     WHERE id = $1 AND created_by = $2 RETURNING *`,
    [id, userId, input.trip_id ?? null, input.category_id ?? null, nameEnc,
     noteProvided, noteEnc, input.lat ?? null, input.lng ?? null, input.rating ?? null],
  );
  if (!row) return notFound("spot");
  return ok(await decryptSpot(row, encKey));
}

async function deleteSpot(db: ModuleDbClient, id: string, userId: string): Promise<HandlerResponse> {
  // Same TOCTOU fix as updateSpot() above: ownership condition in the
  // DELETE's own WHERE clause instead of a prior separate SELECT.
  const rows = await db.query<{ id: string }>(
    `DELETE FROM spots WHERE id = $1 AND created_by = $2 RETURNING id`,
    [id, userId],
  );
  if (rows.length === 0) return notFound("spot");
  return noContent();
}

async function decryptSpot(row: SpotRow, encKey: CryptoKey | null): Promise<Record<string, unknown>> {
  const { name_enc, note_enc, ...rest } = row;
  return {
    ...rest,
    name: encKey
      ? await decrypt(encKey, name_enc).catch((err) => {
          // Logged (found 2026-07-05): a failed decrypt previously became a
          // silent "???" with no trace of which spot/field failed or why.
          console.error(`[my-place] decryptSpot: failed to decrypt name for spot ${row.id}:`, err);
          return "???";
        })
      : name_enc,
    note: encKey && note_enc
      ? await decrypt(encKey, note_enc).catch((err) => {
          console.error(`[my-place] decryptSpot: failed to decrypt note for spot ${row.id}:`, err);
          return null;
        })
      : note_enc,
  };
}

// Cap on photos per spot (item found 2026-07-05) — checked in the POST
// /spots/:id/photos handler above.
const MAX_PHOTOS_PER_SPOT = 20;

function isValidLatLng(lat: unknown, lng: unknown): boolean {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return false;
  if (latNum < -90 || latNum > 90) return false;
  if (lngNum < -180 || lngNum > 180) return false;
  return true;
}

// ── Owner check ────────────────────────────────────────────────────────────────

async function ownerCheck(db: ModuleDbClient, table: string, id: string, userId: string): Promise<boolean> {
  const [row] = await db.query<{ created_by: string }>(
    `SELECT created_by FROM ${table} WHERE id = $1`,
    [id],
  );
  if (!row) return false;
  if (row.created_by === "system") return false; // system seed rows are protected
  return row.created_by === userId;
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function segId(path: string): string {
  return path.split("/").filter(Boolean)[1] ?? "";
}

function ok(body: unknown): HandlerResponse      { return { status: 200, body }; }
function created(body: unknown): HandlerResponse { return { status: 201, body }; }
function noContent(): HandlerResponse            { return { status: 204, body: null }; }
// error is a short snake_case code (see this file's header re: no hardcoded
// English UI text server-side) — "what" is included so the frontend can
// distinguish which resource type was involved if it ever needs to, though
// it currently maps every "not_found" to a single generic i18n string.
function notFound(what: string): HandlerResponse { return { status: 404, body: { error: "not_found", what } }; }
function forbidden(): HandlerResponse            { return { status: 403, body: { error: "forbidden" } }; }
function badRequest(code: string, extra?: Record<string, unknown>): HandlerResponse {
  return { status: 400, body: { error: code, ...extra } };
}

// file_path is meant to be a relative path under this module's own storage
// directory, written by Core's upload step ("Core writes file, sends path",
// see this file's header) — POST /spots/:id/photos still receives it as
// ordinary untrusted request-body input, though, since nothing stops a
// client from calling this endpoint directly with a hand-picked value
// instead of going through the real upload first. Nothing here ever reads
// this path off disk server-side (it's only ever handed back to the
// browser, which resolves it against the storage base URL), so this is not
// a path-traversal-into-a-server-read risk, but an unchecked value could
// still point outside the storage prefix (`../`) or inject an arbitrary
// absolute URL/protocol (`https://evil.example/...`, `javascript:...`) that
// ends up rendered as an <img src> for every other user viewing this spot
// (found 2026-07-05).
function isSafeFilePath(value: string): boolean {
  if (!value || value.includes("..") || value.includes("://") || value.startsWith("/")) return false;
  // Bugfix (2026-07-05): "..", "://" and a leading "/" don't catch a bare
  // scheme like "data:text/html,..." or "javascript:alert(1)" — neither
  // contains ".." or "://", and neither starts with "/". Any colon that
  // appears before the first "/" (or anywhere at all, if there's no "/")
  // means this isn't a relative path under the storage prefix but a
  // URI scheme, so reject it too.
  const slashIdx = value.indexOf("/");
  const colonIdx = value.indexOf(":");
  if (colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) return false;
  return true;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface SpotInput {
  trip_id?: string | null;
  category_id?: string | null;
  name: string;
  note?: string | null;
  lat: number;
  lng: number;
  rating?: number | null;
}

interface SpotRow {
  id: string;
  name_enc: string;
  note_enc: string | null;
  lat: number;
  lng: number;
  rating: number | null;
  trip_id: string | null;
  category_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

interface TripInput {
  name: string;
  year?: number | null;
  description?: string;
}

interface CategoryInput {
  name: string;
  color?: string;
  icon?: string;
  sort_order?: number;
}
