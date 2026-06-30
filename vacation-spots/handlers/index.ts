/**
 * Vacation Spots module — Deno Tier 2 handler
 *
 * Routes (all under /v1/modules/vacation-spots/api/):
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

import type { HandlerRequest, HandlerResponse, ModuleDbClient } from "./types.ts";

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
// Key source: MODULAB_ENCRYPTION_KEY env var (64 hex chars = 32 bytes), set by Core.

let _cachedKey: CryptoKey | null = null;

async function getEncKey(): Promise<CryptoKey | null> {
  if (_cachedKey) return _cachedKey;
  const hexKey = Deno.env.get("MODULAB_ENCRYPTION_KEY") ?? "";
  console.log(`[vacation-spots] MODULAB_ENCRYPTION_KEY length=${hexKey.length}`);
  if (hexKey.length !== 64) return null;
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(hexKey.slice(i * 2, i * 2 + 2), 16);
  _cachedKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return _cachedKey;
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}

async function decrypt(key: CryptoKey, ciphertext: string): Promise<string> {
  const buf = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  return new TextDecoder().decode(pt);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: HandlerRequest): Promise<HandlerResponse> {
  const { method, path, body, auth, db } = req;

  const encKey = await getEncKey();

  const qIdx = path.indexOf("?");
  const pathname = qIdx === -1 ? path : path.slice(0, qIdx);
  const route = `${method} ${pathname}`;

  // ── Settings (admin: GET + PUT, all users: GET /config) ──────────────────

  if (route === "GET /config") {
    const [row] = await db.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'maptiler_api_key'`,
    );
    let maptilerKey = "";
    if (row?.value && encKey) {
      maptilerKey = await decrypt(encKey, row.value).catch(() => "");
    }
    return ok({
      map_configured: maptilerKey.length > 0,
      map_style_url: maptilerKey
        ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${maptilerKey}`
        : null,
    });
  }

  if (route === "GET /settings") {
    if (!auth.roles.includes("admin") && !auth.roles.includes("super_admin")) {
      return forbidden();
    }
    const [row] = await db.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'maptiler_api_key'`,
    );
    return ok({ maptiler_api_key: row?.value ? "••••••••" : "" });
  }

  if (route === "PUT /settings") {
    console.log(`[vacation-spots] PUT /settings roles=${JSON.stringify(auth.roles)} body=${JSON.stringify(body)}`);
    if (!auth.roles.includes("admin") && !auth.roles.includes("super_admin")) {
      return forbidden();
    }
    if (!encKey) {
      return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };
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
  }

  // ── Spots ──────────────────────────────────────────────────────────────────

  if (route === "GET /spots")
    return listSpots(db, path, encKey);
  if (method === "GET" && pathname.match(/^\/spots\/[^/]+$/) && !pathname.endsWith("/photos"))
    return getSpot(db, segId(pathname), encKey);
  if (route === "POST /spots")
    return createSpot(db, body as SpotInput, auth.userId, encKey);
  if (method === "PATCH" && pathname.match(/^\/spots\/[^/]+$/))
    return updateSpot(db, segId(pathname), body as Partial<SpotInput>, auth.userId, encKey);
  if (method === "DELETE" && pathname.match(/^\/spots\/[^/]+$/))
    return deleteSpot(db, segId(pathname), auth.userId);

  // ── Spot photos ────────────────────────────────────────────────────────────

  if (method === "POST" && pathname.match(/^\/spots\/[^/]+\/photos$/)) {
    const spotId = pathname.split("/")[2];
    const { file_path, position } = body as { file_path: string; position?: number };
    if (!(await ownerCheck(db, "spots", spotId, auth.userId))) return forbidden();
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
    if (!(await ownerCheck(db, "spots", spotId, auth.userId))) return forbidden();
    await db.query(`DELETE FROM spot_photos WHERE id = $1 AND spot_id = $2`, [photoId, spotId]);
    return noContent();
  }

  // ── Trips ──────────────────────────────────────────────────────────────────

  if (route === "GET /trips") {
    const rows = await db.query(`SELECT * FROM trips ORDER BY year DESC NULLS LAST, name ASC`);
    return ok(rows);
  }
  if (route === "POST /trips") {
    const { name, year, description } = body as TripInput;
    const [row] = await db.query(
      `INSERT INTO trips (name, year, description, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, year ?? null, description ?? "", auth.userId],
    );
    return created(row);
  }
  if (method === "PATCH" && pathname.match(/^\/trips\/[^/]+$/)) {
    const id = segId(pathname);
    if (!(await ownerCheck(db, "trips", id, auth.userId))) return forbidden();
    const { name, year, description } = body as Partial<TripInput>;
    const [row] = await db.query(
      `UPDATE trips SET
         name        = COALESCE($2, name),
         year        = COALESCE($3, year),
         description = COALESCE($4, description),
         updated_at  = now()
       WHERE id = $1 RETURNING *`,
      [id, name ?? null, year ?? null, description ?? null],
    );
    if (!row) return notFound("trip");
    return ok(row);
  }
  if (method === "DELETE" && pathname.match(/^\/trips\/[^/]+$/)) {
    const id = segId(pathname);
    if (!(await ownerCheck(db, "trips", id, auth.userId))) return forbidden();
    await db.query(`DELETE FROM trips WHERE id = $1`, [id]);
    return noContent();
  }

  // ── Categories ─────────────────────────────────────────────────────────────

  if (route === "GET /categories") {
    const rows = await db.query(`SELECT * FROM categories ORDER BY sort_order ASC, name ASC`);
    return ok(rows);
  }
  if (route === "POST /categories") {
    const { name, color, icon, sort_order } = body as CategoryInput;
    const [row] = await db.query(
      `INSERT INTO categories (name, color, icon, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, color ?? "#888780", icon ?? "ti-map-pin", sort_order ?? 0, auth.userId],
    );
    return created(row);
  }
  if (method === "PATCH" && pathname.match(/^\/categories\/[^/]+$/)) {
    const id = segId(pathname);
    if (!(await ownerCheck(db, "categories", id, auth.userId))) return forbidden();
    const { name, color, icon, sort_order } = body as Partial<CategoryInput>;
    const [row] = await db.query(
      `UPDATE categories SET
         name       = COALESCE($2, name),
         color      = COALESCE($3, color),
         icon       = COALESCE($4, icon),
         sort_order = COALESCE($5, sort_order)
       WHERE id = $1 RETURNING *`,
      [id, name ?? null, color ?? null, icon ?? null, sort_order ?? null],
    );
    if (!row) return notFound("category");
    return ok(row);
  }
  if (method === "DELETE" && pathname.match(/^\/categories\/[^/]+$/)) {
    const id = segId(pathname);
    if (!(await ownerCheck(db, "categories", id, auth.userId))) return forbidden();
    await db.query(`DELETE FROM categories WHERE id = $1`, [id]);
    return noContent();
  }

  return { status: 404, body: { error: "not found" } };
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
     GROUP BY s.id, t.name, c.name, c.color, c.icon
     ORDER BY s.created_at DESC`,
    args,
  );

  return ok(await Promise.all(rows.map((r) => decryptSpot(r, encKey))));
}

async function getSpot(db: ModuleDbClient, id: string, encKey: CryptoKey | null): Promise<HandlerResponse> {
  const [row] = await db.query<SpotRow>(
    `SELECT s.*,
            t.name  AS trip_name,
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
     GROUP BY s.id, t.name, c.name, c.color, c.icon`,
    [id],
  );
  if (!row) return notFound("spot");
  return ok(await decryptSpot(row, encKey));
}

async function createSpot(db: ModuleDbClient, input: SpotInput, userId: string, encKey: CryptoKey | null): Promise<HandlerResponse> {
  const nameEnc = encKey ? await encrypt(encKey, input.name) : input.name;
  const noteEnc = encKey && input.note ? await encrypt(encKey, input.note) : (input.note ?? null);
  const [row] = await db.query<SpotRow>(
    `INSERT INTO spots (trip_id, category_id, name_enc, note_enc, lat, lng, rating, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [input.trip_id ?? null, input.category_id ?? null, nameEnc, noteEnc,
     input.lat, input.lng, input.rating ?? null, userId],
  );
  return created(await decryptSpot(row, encKey));
}

async function updateSpot(db: ModuleDbClient, id: string, input: Partial<SpotInput>, userId: string, encKey: CryptoKey | null): Promise<HandlerResponse> {
  if (!(await ownerCheck(db, "spots", id, userId))) return forbidden();
  const nameEnc = encKey && input.name ? await encrypt(encKey, input.name) : (input.name ?? null);
  const noteEnc = encKey && input.note ? await encrypt(encKey, input.note) : (input.note ?? null);
  const [row] = await db.query<SpotRow>(
    `UPDATE spots SET
       trip_id     = COALESCE($2, trip_id),
       category_id = COALESCE($3, category_id),
       name_enc    = COALESCE($4, name_enc),
       note_enc    = COALESCE($5, note_enc),
       lat         = COALESCE($6, lat),
       lng         = COALESCE($7, lng),
       rating      = COALESCE($8, rating),
       updated_at  = now()
     WHERE id = $1 RETURNING *`,
    [id, input.trip_id ?? null, input.category_id ?? null, nameEnc, noteEnc,
     input.lat ?? null, input.lng ?? null, input.rating ?? null],
  );
  if (!row) return notFound("spot");
  return ok(await decryptSpot(row, encKey));
}

async function deleteSpot(db: ModuleDbClient, id: string, userId: string): Promise<HandlerResponse> {
  if (!(await ownerCheck(db, "spots", id, userId))) return forbidden();
  await db.query(`DELETE FROM spots WHERE id = $1`, [id]);
  return noContent();
}

async function decryptSpot(row: SpotRow, encKey: CryptoKey | null): Promise<Record<string, unknown>> {
  const { name_enc, note_enc, ...rest } = row;
  return {
    ...rest,
    name: encKey ? await decrypt(encKey, name_enc).catch(() => "???") : name_enc,
    note: encKey && note_enc ? await decrypt(encKey, note_enc).catch(() => null) : note_enc,
  };
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
function notFound(w: string): HandlerResponse    { return { status: 404, body: { error: `${w} not found` } }; }
function forbidden(): HandlerResponse            { return { status: 403, body: { error: "forbidden" } }; }

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
