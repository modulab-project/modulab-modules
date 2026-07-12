/**
 * Recipes module — Deno Tier 2 handler
 *
 * Routes (all under /v1/modules/recipes/api/):
 *
 * Recipes
 *   GET    /recipes              list all (+ filter by category, tag, search)
 *   GET    /recipes/:id          detail with ingredients + steps + tags
 *   POST   /recipes              create
 *   PATCH  /recipes/:id          update
 *   DELETE /recipes/:id          delete
 *
 * Recipe images
 *   POST   /recipes/:id/image    attach uploaded image (Core writes file, sends path)
 *
 * Ingredients
 *   GET    /recipes/:id/ingredients        list
 *   PUT    /recipes/:id/ingredients        replace all (full list in body)
 *
 * Steps
 *   GET    /recipes/:id/steps              list
 *   PUT    /recipes/:id/steps              replace all
 *
 * Tags
 *   GET    /tags                  list all tags
 *   POST   /tags                  create tag
 *   DELETE /tags/:id              delete tag
 *   PUT    /recipes/:id/tags      set tags on recipe
 *
 * Categories
 *   GET    /categories            list
 *   POST   /categories            create
 *   PATCH  /categories/:id        update
 *   DELETE /categories/:id        delete
 *
 * Portion calculator
 *   GET    /recipes/:id/nutrition?servings=N   recalculated per servings
 *
 * AI nutrition estimation (2026-07-12, see Entscheidungsvorlage "KI-Nährwertberechnung")
 *   POST   /recipes/:id/nutrition/ai        estimate nutrition via a configured AI provider
 *                                            body: { provider?: "openai"|"google"|"anthropic"|"deepseek" }
 *                                            (falls back to the default provider if omitted)
 *
 * AI provider settings — Admin only (mirrors unifi-network gateways)
 *   GET    /ai-providers                    list configured providers (keys never returned)
 *   PUT    /ai-providers/:provider           upsert one provider's config
 *   DELETE /ai-providers/:provider           remove one provider's config
 *   GET    /ai-providers/:provider/models    list available models via the provider's own /models
 *                                             API (requires the key to already be saved — same
 *                                             requirement as Core's admin/system/ai equivalent)
 *
 * Meal plan
 *   GET    /meal-plan?week=YYYY-MM-DD          get week (Monday date)
 *   PUT    /meal-plan/:weekStart/:day/:slot     set entry  (day=1-7, slot=breakfast|lunch|dinner|snack)
 *   DELETE /meal-plan/:weekStart/:day/:slot     clear entry
 */

import type { HandlerRequest, HandlerResponse, ModuleDbClient, ModuleAuthContext } from "./types.ts";
import { getEncKey, encrypt, decrypt } from "./crypto.ts";
import {
  callNutritionAi,
  listAvailableModels,
  AiProviderError,
  AI_PROVIDER_NAMES,
  AI_PROVIDER_DEFAULT_MODELS,
  type AiProviderName,
} from "./ai-providers.ts";

export default async function handler(req: HandlerRequest): Promise<HandlerResponse> {
  const { method, path, body, auth, db } = req;

  // path may include a query string (e.g. "/recipes?search=foo").
  // Split it so route matching works on the pathname only, while filter
  // functions still receive the full path (with "?...") for URLSearchParams.
  const qIdx = path.indexOf("?");
  const pathname = qIdx === -1 ? path : path.slice(0, qIdx);
  const route = `${method} ${pathname}`;

  // ── Recipes ───────────────────────────────────────────────────────────────

  if (route === "GET /recipes") {
    return listRecipes(db, path);
  }
  if (method === "GET" && pathname.match(/^\/recipes\/[^/]+$/)) {
    return getRecipe(db, segId(pathname));
  }
  if (route === "POST /recipes") {
    return createRecipe(db, body as RecipeInput, auth.userId);
  }
  if (method === "PATCH" && pathname.match(/^\/recipes\/[^/]+$/)) {
    return updateRecipe(db, segId(pathname), body as Partial<RecipeInput>);
  }
  if (method === "DELETE" && pathname.match(/^\/recipes\/[^/]+$/)) {
    return deleteRecipe(db, segId(pathname));
  }

  // ── Recipe image ──────────────────────────────────────────────────────────

  if (method === "POST" && pathname.match(/^\/recipes\/[^/]+\/image$/)) {
    const id = pathname.split("/")[2];
    const { file_path } = body as { file_path: string };
    if (!isSafeFilePath(file_path)) return badRequest("invalid file_path");
    await db.query(
      `UPDATE recipes SET image_path = $1, updated_at = now() WHERE id = $2`,
      [file_path, id],
    );
    return ok({ image_path: file_path });
  }
  if (method === "DELETE" && pathname.match(/^\/recipes\/[^/]+\/image$/)) {
    const id = pathname.split("/")[2];
    await db.query(
      `UPDATE recipes SET image_path = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    return noContent();
  }

  // ── Ingredients ───────────────────────────────────────────────────────────

  if (method === "GET" && pathname.match(/^\/recipes\/[^/]+\/ingredients$/)) {
    const id = pathname.split("/")[2];
    // Bugfix (2026-07-05): a nonexistent recipe id previously fell through
    // to an empty-result SELECT and returned 200 with `[]`, indistinguishable
    // from "recipe exists but has no ingredients yet".
    if (!(await recipeExists(db, id))) return notFound("recipe");
    const rows = await db.query<Ingredient>(
      `SELECT * FROM ingredients WHERE recipe_id = $1 ORDER BY position ASC`,
      [id],
    );
    return ok(rows);
  }
  if (method === "PUT" && pathname.match(/^\/recipes\/[^/]+\/ingredients$/)) {
    const id = pathname.split("/")[2];
    return replaceIngredients(db, id, body as IngredientInput[]);
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  if (method === "GET" && pathname.match(/^\/recipes\/[^/]+\/steps$/)) {
    const id = pathname.split("/")[2];
    // Same bugfix as GET /recipes/:id/ingredients above.
    if (!(await recipeExists(db, id))) return notFound("recipe");
    const rows = await db.query<Step>(
      `SELECT * FROM recipe_steps WHERE recipe_id = $1 ORDER BY step_number ASC`,
      [id],
    );
    return ok(rows);
  }
  if (method === "PUT" && pathname.match(/^\/recipes\/[^/]+\/steps$/)) {
    const id = pathname.split("/")[2];
    return replaceSteps(db, id, body as StepInput[]);
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  if (route === "GET /tags") {
    const rows = await db.query(`SELECT * FROM tags ORDER BY name ASC`);
    return ok(rows);
  }
  if (route === "POST /tags") {
    const { name } = body as { name: string };
    const [row] = await db.query<{ id: string; name: string }>(
      `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id, name`,
      [name],
    );
    return created(row);
  }
  if (method === "DELETE" && pathname.match(/^\/tags\/[^/]+$/)) {
    await db.query(`DELETE FROM tags WHERE id = $1`, [segId(pathname)]);
    return noContent();
  }
  if (method === "PUT" && pathname.match(/^\/recipes\/[^/]+\/tags$/)) {
    const id = pathname.split("/")[2];
    const tagIds = (body as { tag_ids: string[] }).tag_ids ?? [];
    await db.query(`DELETE FROM recipe_tags WHERE recipe_id = $1`, [id]);
    for (const tagId of tagIds) {
      await db.query(
        `INSERT INTO recipe_tags (recipe_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, tagId],
      );
    }
    return ok({ recipe_id: id, tag_ids: tagIds });
  }

  // ── Categories ────────────────────────────────────────────────────────────

  if (route === "GET /categories") {
    const rows = await db.query(
      `SELECT * FROM categories ORDER BY name ASC`,
    );
    return ok(rows);
  }
  if (route === "POST /categories") {
    const { name, sort_order } = body as { name: string; sort_order?: number };
    const [row] = await db.query(
      `INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING *`,
      [name, sort_order ?? 0],
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

  // ── Portion calculator ────────────────────────────────────────────────────

  if (method === "GET" && pathname.match(/^\/recipes\/[^/]+\/nutrition$/)) {
    const id = pathname.split("/")[2];
    const params = new URL("http://x" + path).searchParams;
    const servings = parseInt(params.get("servings") ?? "1", 10);
    return calcNutrition(db, id, servings);
  }

  // ── Meal plan ─────────────────────────────────────────────────────────────

  if (method === "GET" && pathname.startsWith("/meal-plan")) {
    const week = new URL("http://x" + path).searchParams.get("week") ?? mondayOfCurrentWeek();
    return getMealPlan(db, week);
  }
  if (method === "PUT" && pathname.match(/^\/meal-plan\/[^/]+\/\d+\/\w+$/)) {
    const [, , weekStart, day, slot] = pathname.split("/");
    const dayNum = parseInt(day);
    // Bugfix (2026-07-05): the route regex only checked "digits" / "word
    // chars" shape, not the actual allowed range/values — an out-of-range
    // day or unknown slot reached the INSERT and hit meal_plan_entries' own
    // CHECK constraints as a raw, unhandled 500 instead of a clear 400.
    if (!isValidDayOfWeek(dayNum)) return badRequest("day must be between 1 and 7");
    if (!isValidMealSlot(slot)) return badRequest(`slot must be one of: ${VALID_MEAL_SLOTS.join(", ")}`);
    return setMealPlanEntry(db, weekStart, dayNum, slot, body as MealPlanInput, auth.userId);
  }
  if (method === "DELETE" && pathname.match(/^\/meal-plan\/[^/]+\/\d+\/\w+$/)) {
    const [, , weekStart, day, slot] = pathname.split("/");
    const dayNum = parseInt(day);
    if (!isValidDayOfWeek(dayNum)) return badRequest("day must be between 1 and 7");
    if (!isValidMealSlot(slot)) return badRequest(`slot must be one of: ${VALID_MEAL_SLOTS.join(", ")}`);
    await db.query(
      `DELETE FROM meal_plan_entries WHERE week_start = $1 AND day_of_week = $2 AND meal_slot = $3`,
      [weekStart, dayNum, slot],
    );
    return noContent();
  }

  // ── AI provider settings (Admin only) ───────────────────────────────────

  if (route === "GET /ai-providers") {
    return listAiProviders(db, auth);
  }
  if (method === "PUT" && pathname.match(/^\/ai-providers\/[^/]+$/)) {
    return upsertAiProvider(db, auth, segId(pathname), body);
  }
  if (method === "DELETE" && pathname.match(/^\/ai-providers\/[^/]+$/)) {
    return deleteAiProvider(db, auth, segId(pathname));
  }
  if (method === "GET" && pathname.match(/^\/ai-providers\/[^/]+\/models$/)) {
    const provider = pathname.split("/")[2];
    return listAiProviderModels(db, auth, provider);
  }

  // ── AI nutrition estimation ──────────────────────────────────────────────

  if (method === "POST" && pathname.match(/^\/recipes\/[^/]+\/nutrition\/ai$/)) {
    const id = pathname.split("/")[2];
    return estimateNutritionWithAi(db, id, body as { provider?: string } | undefined);
  }

  return { status: 404, body: { error: "not found" } };
}

// ── Recipe helpers ────────────────────────────────────────────────────────────

async function listRecipes(db: ModuleDbClient, path: string): Promise<HandlerResponse> {
  const params = new URL("http://x" + path).searchParams;
  const search = params.get("search") ?? "";
  const category = params.get("category") ?? "";
  const tag = params.get("tag") ?? "";
  const limit = Math.min(parseInt(params.get("limit") ?? "50"), 200);
  const offset = parseInt(params.get("offset") ?? "0");

  const conditions: string[] = [];
  const args: unknown[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`(r.title ILIKE $${idx} OR r.description ILIKE $${idx})`);
    args.push(`%${search}%`);
    idx++;
  }
  if (category) {
    conditions.push(`r.category_id = $${idx}`);
    args.push(category);
    idx++;
  }
  if (tag) {
    conditions.push(`EXISTS (
      SELECT 1 FROM recipe_tags rt
      JOIN tags t ON t.id = rt.tag_id
      WHERE rt.recipe_id = r.id AND t.name = $${idx}
    )`);
    args.push(tag);
    idx++;
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  args.push(limit, offset);

  const rows = await db.query(
    `SELECT r.*,
            c.name AS category_name,
            COALESCE(
              json_agg(t.name ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL),
              '[]'::json
            ) AS tag_names
     FROM recipes r
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN recipe_tags rt ON rt.recipe_id = r.id
     LEFT JOIN tags t ON t.id = rt.tag_id
     ${where}
     GROUP BY r.id, c.name
     ORDER BY r.updated_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    args,
  );

  // Separate COUNT(*) re-running the same WHERE as the list query above.
  // Left as-is (2026-07-05 review): combining via a window function
  // (COUNT(*) OVER()) would need a second GROUP BY-shaped subquery here
  // because of the existing json_agg/tag_names aggregation, and the current
  // two-query version is already simple and correct — not worth the
  // rewrite risk for a homelab-scale recipe count.
  const [countRow] = await db.query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM recipes r ${where}`,
    args.slice(0, -2),
  );

  return ok({ recipes: rows, total: parseInt(countRow?.total ?? "0") });
}

async function getRecipe(db: ModuleDbClient, id: string): Promise<HandlerResponse> {
  const [recipe] = await db.query(
    `SELECT r.*,
            c.name AS category_name,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name))
              FILTER (WHERE t.id IS NOT NULL),
              '[]'::json
            ) AS tags
     FROM recipes r
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN recipe_tags rt ON rt.recipe_id = r.id
     LEFT JOIN tags t ON t.id = rt.tag_id
     WHERE r.id = $1
     GROUP BY r.id, c.name`,
    [id],
  );
  if (!recipe) return notFound("recipe");

  const ingredients = await db.query(
    `SELECT * FROM ingredients WHERE recipe_id = $1 ORDER BY position ASC`,
    [id],
  );
  const steps = await db.query(
    `SELECT * FROM recipe_steps WHERE recipe_id = $1 ORDER BY step_number ASC`,
    [id],
  );

  return ok({ ...recipe, ingredients, steps });
}

async function createRecipe(
  db: ModuleDbClient,
  input: RecipeInput,
  userId: string,
): Promise<HandlerResponse> {
  // Bugfix (2026-07-05): title has a NOT NULL constraint but no non-empty
  // check, so a bare "" previously reached the INSERT and created an
  // untitled, effectively unusable recipe.
  if (!input.title || !input.title.trim()) return badRequest("title is required");
  if (input.source_url && !isSafeUrl(input.source_url)) return badRequest("invalid source_url");
  const [row] = await db.query(
    `INSERT INTO recipes
       (title, description, category_id, servings, prep_time_min, cook_time_min,
        source_url, notes, nutrition_source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9)
     RETURNING *`,
    [
      input.title.trim(),
      input.description ?? "",
      input.category_id ?? null,
      input.servings ?? 4,
      input.prep_time_min ?? null,
      input.cook_time_min ?? null,
      input.source_url ?? null,
      input.notes ?? null,
      userId,
    ],
  );
  return created(row);
}

async function updateRecipe(
  db: ModuleDbClient,
  id: string,
  input: Partial<RecipeInput>,
): Promise<HandlerResponse> {
  // postgres.js does not accept undefined as a parameter value — only null.
  // n() converts undefined (and empty string for nullable fields) to null so
  // COALESCE($n, col) correctly falls back to the existing column value.
  const n = (v: unknown) => (v === undefined || v === "" ? null : v);

  if (input.title !== undefined && !input.title.trim()) return badRequest("title cannot be empty");
  if (input.source_url && !isSafeUrl(input.source_url)) return badRequest("invalid source_url");

  const [row] = await db.query(
    `UPDATE recipes SET
       title         = COALESCE($2, title),
       description   = COALESCE($3, description),
       category_id   = $4,
       servings      = COALESCE($5, servings),
       prep_time_min = $6,
       cook_time_min = $7,
       source_url    = $8,
       notes         = $9,
       updated_at    = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      n(input.title),
      n(input.description) ?? "",
      n(input.category_id),
      n(input.servings),
      n(input.prep_time_min),
      n(input.cook_time_min),
      n(input.source_url),
      n(input.notes),
    ],
  );
  if (!row) return notFound("recipe");
  return ok(row);
}

async function deleteRecipe(db: ModuleDbClient, id: string): Promise<HandlerResponse> {
  // Bugfix (2026-07-05): previously returned 204 unconditionally, even for a
  // nonexistent id — matches updateRecipe()'s RETURNING/row-count pattern above.
  const rows = await db.query<{ id: string }>(`DELETE FROM recipes WHERE id = $1 RETURNING id`, [id]);
  if (rows.length === 0) return notFound("recipe");
  return noContent();
}

// replaceIngredients()/replaceSteps() below do DELETE-all + one INSERT per
// item in a loop rather than a single multi-row INSERT. Left as-is
// (2026-07-05 review): there's no existing dynamic multi-row VALUES helper
// anywhere in this module (or the other two — see the project-wide
// no-shared-utilities convention) to model one on, recipe ingredient/step
// counts are small (a handful to a few dozen rows, not thousands), and
// building the parameter-index bookkeeping for a variable-width, variable-
// row-count VALUES list by hand without a TypeScript compiler available to
// catch an off-by-one is a real risk of silently swapping columns for one
// row. Not worth it for a homelab-scale recipe box.
async function replaceIngredients(
  db: ModuleDbClient,
  recipeId: string,
  inputs: IngredientInput[],
): Promise<HandlerResponse> {
  await db.query(`DELETE FROM ingredients WHERE recipe_id = $1`, [recipeId]);
  const saved = [];
  for (let i = 0; i < inputs.length; i++) {
    const ing = inputs[i];
    const [row] = await db.query(
      `INSERT INTO ingredients
         (recipe_id, position, name, amount, unit,
          off_product_id, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, fiber_per_100g)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        recipeId, i, ing.name, ing.amount ?? null, ing.unit ?? null,
        ing.off_product_id ?? null,
        ing.kcal_per_100g ?? null, ing.protein_per_100g ?? null,
        ing.fat_per_100g ?? null, ing.carbs_per_100g ?? null, ing.fiber_per_100g ?? null,
      ],
    );
    saved.push(row);
  }
  // Recalculate and store recipe nutrition from ingredients
  await recalcNutritionFromIngredients(db, recipeId);
  return ok(saved);
}

async function replaceSteps(
  db: ModuleDbClient,
  recipeId: string,
  inputs: StepInput[],
): Promise<HandlerResponse> {
  for (const step of inputs) {
    if (step.image_path && !isSafeFilePath(step.image_path)) {
      return badRequest(`invalid image_path for step: ${step.image_path}`);
    }
  }
  await db.query(`DELETE FROM recipe_steps WHERE recipe_id = $1`, [recipeId]);
  const saved = [];
  for (let i = 0; i < inputs.length; i++) {
    const step = inputs[i];
    const [row] = await db.query(
      `INSERT INTO recipe_steps (recipe_id, step_number, instruction, image_path)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [recipeId, i + 1, step.instruction, step.image_path ?? null],
    );
    saved.push(row);
  }
  return ok(saved);
}

// Recalculate per-serving nutrition from stored ingredient data
async function recalcNutritionFromIngredients(db: ModuleDbClient, recipeId: string) {
  const [recipeRow] = await db.query<{ servings: number }>(
    `SELECT servings FROM recipes WHERE id = $1`,
    [recipeId],
  );
  if (!recipeRow) return;
  const servings = recipeRow.servings || 1;

  const ingredients = await db.query<Ingredient>(
    `SELECT * FROM ingredients WHERE recipe_id = $1`,
    [recipeId],
  );

  let kcal = 0, protein = 0, fat = 0, carbs = 0, fiber = 0;
  let hasData = false;

  for (const ing of ingredients) {
    if (
      ing.kcal_per_100g != null && ing.amount != null
    ) {
      const factor = Number(ing.amount) / 100;
      kcal    += Number(ing.kcal_per_100g)    * factor;
      protein += Number(ing.protein_per_100g ?? 0) * factor;
      fat     += Number(ing.fat_per_100g ?? 0)     * factor;
      carbs   += Number(ing.carbs_per_100g ?? 0)   * factor;
      fiber   += Number(ing.fiber_per_100g ?? 0)   * factor;
      hasData = true;
    }
  }

  if (hasData) {
    await db.query(
      `UPDATE recipes SET
         kcal_per_serving      = $2,
         protein_g_per_serving = $3,
         fat_g_per_serving     = $4,
         carbs_g_per_serving   = $5,
         fiber_g_per_serving   = $6,
         nutrition_source      = 'calculated',
         updated_at            = now()
       WHERE id = $1`,
      [recipeId, kcal / servings, protein / servings, fat / servings, carbs / servings, fiber / servings],
    );
  }
}

// ── Open Food Facts nutrition lookup removed 2026-07-03 ─────────────────────
//
// searchNutrition()/fetchNutrition()/mapOFFProduct() used to call
// world.openfoodfacts.org / api.openfoodfacts.org for product nutrition
// data. Removed because the /nutrition/search and /nutrition/:offId routes
// were never wired up to any UI component (no autocomplete/search field in
// ui/src/App.tsx ever called them) — dead code making an outbound network
// call for no reachable feature. The portion calculator below
// (calcNutrition, /recipes/:id/nutrition) is unaffected: it only
// recalculates from ingredient rows already stored in the DB, no external
// call. The off_product_id column on ingredients and the 'off' value in
// nutrition_source's CHECK constraint are left in place in the schema
// (migrations aren't rewritten after the fact) but are now unreachable —
// nothing in this handler ever sets off_product_id or nutrition_source='off'
// again.

async function calcNutrition(
  db: ModuleDbClient,
  recipeId: string,
  targetServings: number,
): Promise<HandlerResponse> {
  const [row] = await db.query<RecipeNutrition>(
    `SELECT servings, kcal_per_serving, protein_g_per_serving,
            fat_g_per_serving, carbs_g_per_serving, fiber_g_per_serving, nutrition_source
     FROM recipes WHERE id = $1`,
    [recipeId],
  );
  if (!row) return notFound("recipe");
  if (!row.kcal_per_serving) return ok({ available: false });

  const factor = targetServings / (row.servings || 1);
  return ok({
    available: true,
    target_servings: targetServings,
    kcal:    +(Number(row.kcal_per_serving)    * factor).toFixed(1),
    protein: +(Number(row.protein_g_per_serving) * factor).toFixed(1),
    fat:     +(Number(row.fat_g_per_serving)     * factor).toFixed(1),
    carbs:   +(Number(row.carbs_g_per_serving)   * factor).toFixed(1),
    fiber:   +(Number(row.fiber_g_per_serving)   * factor).toFixed(1),
    source:  row.nutrition_source,
  });
}

// ── Meal plan ─────────────────────────────────────────────────────────────────

async function getMealPlan(db: ModuleDbClient, weekStart: string): Promise<HandlerResponse> {
  const rows = await db.query(
    `SELECT mp.*, r.title AS recipe_title, r.image_path AS recipe_image, r.prep_time_min, r.cook_time_min
     FROM meal_plan_entries mp
     LEFT JOIN recipes r ON r.id = mp.recipe_id
     WHERE mp.week_start = $1
     ORDER BY mp.day_of_week ASC, mp.meal_slot ASC`,
    [weekStart],
  );
  return ok({ week_start: weekStart, entries: rows });
}

async function setMealPlanEntry(
  db: ModuleDbClient,
  weekStart: string,
  day: number,
  slot: string,
  input: MealPlanInput,
  userId: string,
): Promise<HandlerResponse> {
  const [row] = await db.query(
    `INSERT INTO meal_plan_entries (week_start, day_of_week, meal_slot, recipe_id, note, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (week_start, day_of_week, meal_slot)
     DO UPDATE SET recipe_id = EXCLUDED.recipe_id, note = EXCLUDED.note, updated_at = now()
     RETURNING *`,
    [weekStart, day, slot, input.recipe_id ?? null, input.note ?? null, userId],
  );
  return ok(row);
}

// ── AI provider settings ─────────────────────────────────────────────────────
//
// Managing the API keys themselves is Admin-only (same reasoning as
// unifi-network's gateways: these are shared, billable credentials for the
// whole location, not per-user data). Actually *using* a configured
// provider to estimate a recipe's nutrition (estimateNutritionWithAi below)
// is not gated — any user who can edit a recipe can trigger a calculation,
// same as the existing manual/portion-calculator nutrition features.

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
  const rows = await db.query<AiProviderRow>(
    `SELECT * FROM ai_nutrition_providers ORDER BY provider ASC`,
  );
  // api_key_enc/created_by_enc are never sent to the frontend — has_key is
  // enough for the settings UI to show "configured" vs. "not configured"
  // without ever exposing the ciphertext (let alone the plaintext key).
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
): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  if (!AI_PROVIDER_NAMES.includes(provider as AiProviderName)) {
    return badRequest(`provider must be one of: ${AI_PROVIDER_NAMES.join(", ")}`);
  }
  const encKey = await getEncKey();
  if (!encKey) return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };

  const { api_key, model, enabled, is_default } = body as {
    api_key?: string;
    model?: string;
    enabled?: boolean;
    is_default?: boolean;
  };

  const [existing] = await db.query<AiProviderRow>(
    `SELECT * FROM ai_nutrition_providers WHERE provider = $1`,
    [provider],
  );
  if (!existing && !api_key) return badRequest("api_key is required when configuring a provider for the first time");

  const resolvedModel = (model && model.trim()) || existing?.model || AI_PROVIDER_DEFAULT_MODELS[provider as AiProviderName];
  const resolvedEnabled = enabled ?? existing?.enabled ?? true;
  const resolvedIsDefault = is_default ?? existing?.is_default ?? false;
  const createdByEnc = existing?.created_by_enc ?? (await encrypt(encKey, auth.userEmail));

  // Clearing any other row's is_default first avoids the partial-unique-index
  // conflict (ai_nutrition_providers_one_default_idx) when this upsert is the
  // one being promoted to default.
  if (resolvedIsDefault) {
    await db.query(`UPDATE ai_nutrition_providers SET is_default = false WHERE provider != $1`, [provider]);
  }

  if (api_key) {
    const apiKeyEnc = await encrypt(encKey, api_key);
    await db.query(
      `INSERT INTO ai_nutrition_providers (provider, api_key_enc, model, enabled, is_default, created_by_enc)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider) DO UPDATE SET
         api_key_enc = EXCLUDED.api_key_enc, model = EXCLUDED.model,
         enabled = EXCLUDED.enabled, is_default = EXCLUDED.is_default, updated_at = now()`,
      [provider, apiKeyEnc, resolvedModel, resolvedEnabled, resolvedIsDefault, createdByEnc],
    );
  } else {
    // No new key supplied — rotate model/enabled/is_default only, keep the
    // existing encrypted key untouched (mirrors unifi-network updateGateway).
    await db.query(
      `UPDATE ai_nutrition_providers SET model = $2, enabled = $3, is_default = $4, updated_at = now() WHERE provider = $1`,
      [provider, resolvedModel, resolvedEnabled, resolvedIsDefault],
    );
  }

  return ok({ provider, model: resolvedModel, enabled: resolvedEnabled, is_default: resolvedIsDefault, has_key: true });
}

async function deleteAiProvider(db: ModuleDbClient, auth: ModuleAuthContext, provider: string): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  const rows = await db.query<{ provider: string }>(
    `DELETE FROM ai_nutrition_providers WHERE provider = $1 RETURNING provider`,
    [provider],
  );
  if (rows.length === 0) return notFound("provider config");
  return noContent();
}

// listAiProviderModels — GET /ai-providers/:provider/models (2026-07-12,
// user request "genauso umsetzen wie in admin/system/ai"): ported to match
// Core's AdminListModelsHandler exactly, including its constraint that the
// key must already be saved (no "unsaved key in the request body" fast
// path — Core doesn't have one either; its frontend saves the key first,
// then calls this). Response shape is Core's {"models": [...]} , a flat
// sorted string[], not the earlier {id,label}[] shape.
//
// The entire body is one try/catch (2026-07-12 hardening, see the same
// change in estimateNutritionWithAi below): a bug anywhere in here —
// including in getEncKey()/decrypt(), which previously sat outside the
// try — must never escape as an uncaught exception. An escaped exception
// here doesn't reach extractErrorMessage()'s JSON-body handling on the
// frontend; it surfaces as a bare, bodyless error that renders as the
// generic "Serverfehler (Status 502)" fallback with zero information about
// what actually broke.
async function listAiProviderModels(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  provider: string,
): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  if (!AI_PROVIDER_NAMES.includes(provider as AiProviderName)) {
    return badRequest(`provider must be one of: ${AI_PROVIDER_NAMES.join(", ")}`);
  }

  try {
    const encKey = await getEncKey();
    if (!encKey) return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };

    const [existing] = await db.query<AiProviderRow>(
      `SELECT * FROM ai_nutrition_providers WHERE provider = $1`,
      [provider],
    );
    // Matches Core's 503 ("no admin API key configured for this provider")
    // rather than a 400 — this isn't a malformed request, the provider is
    // just not set up yet.
    if (!existing) return { status: 503, body: { error: "no API key configured for this provider" } };

    const apiKey = await decrypt(encKey, existing.api_key_enc);
    const models = await listAvailableModels(provider as AiProviderName, apiKey);
    return ok({ models });
  } catch (err) {
    console.error(`[recipes] listAiProviderModels(${provider}) failed:`, err);
    const message = err instanceof AiProviderError ? err.message : String(err);
    return { status: 502, body: { error: `could not list models (${provider}): ${message}` } };
  }
}

// ── AI nutrition estimation ──────────────────────────────────────────────────

async function estimateNutritionWithAi(
  db: ModuleDbClient,
  recipeId: string,
  input: { provider?: string } | undefined,
): Promise<HandlerResponse> {
  // Bugfix (2026-07-12, still reproducing after the first pass at this):
  // the whole function body is now one try/catch, not just the decrypt+
  // provider-call portion. ANY unexpected failure in here — a DB error on
  // the very first query, a bug in row shape handling, anything — must
  // become a structured JSON response, never an uncaught exception. An
  // uncaught exception here doesn't reach extractErrorMessage()'s JSON
  // handling on the frontend at all: it comes back as a bare, bodyless
  // error, which extractErrorMessage's `looksLikeHtml || !txt.trim()`
  // check falls back to the generic "Serverfehler (Status 502)." text for
  // — exactly the symptom reported, with zero information about the real
  // cause. console.error below at least gets the real error into this
  // module's own worker logs even when the HTTP response can't carry it.
  try {
    const [recipe] = await db.query<{ title: string; servings: number }>(
      `SELECT title, servings FROM recipes WHERE id = $1`,
      [recipeId],
    );
    if (!recipe) return notFound("recipe");

    const ingredients = await db.query<{ name: string; amount: number | null; unit: string | null }>(
      `SELECT name, amount, unit FROM ingredients WHERE recipe_id = $1 ORDER BY position ASC`,
      [recipeId],
    );
    if (ingredients.length === 0) return badRequest("recipe has no ingredients to estimate from");

    const requestedProvider = input?.provider;
    if (requestedProvider && !AI_PROVIDER_NAMES.includes(requestedProvider as AiProviderName)) {
      return badRequest(`provider must be one of: ${AI_PROVIDER_NAMES.join(", ")}`);
    }

    const [row] = requestedProvider
      ? await db.query<AiProviderRow>(
          `SELECT * FROM ai_nutrition_providers WHERE provider = $1 AND enabled = true`,
          [requestedProvider],
        )
      : await db.query<AiProviderRow>(
          `SELECT * FROM ai_nutrition_providers WHERE enabled = true ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
        );
    if (!row) {
      return badRequest(
        requestedProvider
          ? `provider "${requestedProvider}" is not configured or disabled — set it up under Settings first`
          : "no AI provider is configured — set one up under Settings first",
      );
    }

    const encKey = await getEncKey();
    if (!encKey) return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };

    const apiKey = await decrypt(encKey, row.api_key_enc);
    const estimate = await callNutritionAi(row.provider, apiKey, row.model, recipe.title, recipe.servings || 1, ingredients);

    const [updated] = await db.query(
      `UPDATE recipes SET
         kcal_per_serving      = $2,
         protein_g_per_serving = $3,
         fat_g_per_serving     = $4,
         carbs_g_per_serving   = $5,
         fiber_g_per_serving   = $6,
         nutrition_source      = 'ai',
         updated_at            = now()
       WHERE id = $1 RETURNING *`,
      [recipeId, estimate.kcal, estimate.protein_g, estimate.fat_g, estimate.carbs_g, estimate.fiber_g],
    );
    return ok({ ...updated, ai_provider: row.provider, ai_model: row.model });
  } catch (err) {
    console.error(`[recipes] estimateNutritionWithAi(recipe=${recipeId}) failed:`, err);
    const message = err instanceof AiProviderError ? err.message : String(err);
    return { status: 502, body: { error: `AI nutrition estimation failed: ${message}` } };
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function segId(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[1] ?? "";
}

function mondayOfCurrentWeek(): string {
  const d = new Date();
  const day = d.getDay() || 7; // Sunday = 7
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
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

// Mirrors migrations/0001_initial.sql's meal_plan_entries CHECK constraints
// (day_of_week BETWEEN 1 AND 7, meal_slot IN (...)) — validated here too so
// an out-of-range value reaches the caller as a 400 with a clear message
// instead of a raw Postgres constraint-violation 500 (found 2026-07-05).
const VALID_MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"];
function isValidDayOfWeek(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= 7;
}
function isValidMealSlot(slot: string): boolean {
  return VALID_MEAL_SLOTS.includes(slot);
}

// image_path/file_path is meant to be a relative path under this module's
// own storage directory, returned by a prior multipart upload call (see the
// UI's upload() helper) — never a value the client is free to invent
// wholesale. Nothing here ever reads this path off disk server-side (it's
// only ever handed back to the browser, which resolves it against the
// storage base URL itself), so this is not an SSRF/path-traversal-into-a-
// server-read risk, but an unchecked value could still point outside the
// storage prefix (`../`) or inject an arbitrary absolute URL/protocol
// (`https://evil.example/...`, `javascript:...`) that ends up rendered as an
// <img src> for every other user who views this recipe (found 2026-07-05).
function isSafeFilePath(value: string): boolean {
  if (!value || value.includes("..") || value.includes("://") || value.startsWith("/")) return false;
  // A scheme like "data:" or "javascript:" has no "//" and doesn't start
  // with "/", so it slipped past the checks above undetected until this
  // was found alongside the equivalent my-place fix (2026-07-05) - reject
  // any colon that appears before the first slash (or with no slash at
  // all), which catches those schemes while still accepting a bare
  // relative path like "uploads/abc123.jpg".
  const slashIdx = value.indexOf("/");
  const colonIdx = value.indexOf(":");
  if (colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) return false;
  return true;
}

// source_url is rendered as <a href> in the frontend (RecipeDetail) — a
// javascript:/data:/vbscript: scheme there would execute in the viewer's
// session. Only http/https are ever legitimate for a recipe source link, so
// anything else is rejected outright (found 2026-07-05).
function isSafeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Existence check used by GET /recipes/:id/ingredients and GET
// /recipes/:id/steps (found 2026-07-05): both previously returned `[]` for a
// nonexistent recipe id instead of 404, indistinguishable from "recipe
// exists but has no rows yet".
async function recipeExists(db: ModuleDbClient, id: string): Promise<boolean> {
  const rows = await db.query<{ exists: boolean }>(`SELECT 1 AS exists FROM recipes WHERE id = $1`, [id]);
  return rows.length > 0;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecipeInput {
  title: string;
  description?: string;
  category_id?: string | null;
  servings?: number;
  prep_time_min?: number | null;
  cook_time_min?: number | null;
  source_url?: string | null;
  notes?: string | null;
  image_path?: string | null;
}

interface IngredientInput {
  name: string;
  amount: number | null;
  unit?: string | null;
  off_product_id?: string | null;
  kcal_per_100g?: number | null;
  protein_per_100g?: number | null;
  fat_per_100g?: number | null;
  carbs_per_100g?: number | null;
  fiber_per_100g?: number | null;
}

interface Ingredient extends IngredientInput {
  id: string;
  recipe_id: string;
  position: number;
}

interface StepInput {
  instruction: string;
  image_path?: string | null;
}

interface Step extends StepInput {
  id: string;
  recipe_id: string;
  step_number: number;
}

interface RecipeNutrition {
  servings: number;
  kcal_per_serving: number | null;
  protein_g_per_serving: number | null;
  fat_g_per_serving: number | null;
  carbs_g_per_serving: number | null;
  fiber_g_per_serving: number | null;
  nutrition_source: string | null;
}

interface MealPlanInput {
  recipe_id?: string | null;
  note?: string | null;
}
