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
 * Meal plan
 *   GET    /meal-plan?week=YYYY-MM-DD          get week (Monday date)
 *   PUT    /meal-plan/:weekStart/:day/:slot     set entry  (day=1-7, slot=breakfast|lunch|dinner|snack)
 *   DELETE /meal-plan/:weekStart/:day/:slot     clear entry
 */

import type { HandlerRequest, HandlerResponse, ModuleDbClient } from "./types.ts";

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
      `SELECT * FROM categories ORDER BY sort_order ASC, name ASC`,
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
    return setMealPlanEntry(db, weekStart, parseInt(day), slot, body as MealPlanInput, auth.userId);
  }
  if (method === "DELETE" && pathname.match(/^\/meal-plan\/[^/]+\/\d+\/\w+$/)) {
    const [, , weekStart, day, slot] = pathname.split("/");
    await db.query(
      `DELETE FROM meal_plan_entries WHERE week_start = $1 AND day_of_week = $2 AND meal_slot = $3`,
      [weekStart, parseInt(day), slot],
    );
    return noContent();
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
  const [row] = await db.query(
    `INSERT INTO recipes
       (title, description, category_id, servings, prep_time_min, cook_time_min,
        source_url, notes, nutrition_source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9)
     RETURNING *`,
    [
      input.title,
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
  await db.query(`DELETE FROM recipes WHERE id = $1`, [id]);
  return noContent();
}

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
