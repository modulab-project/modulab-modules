/**
 * Recipes module — React frontend  v0.4.0
 *
 * Changes vs 0.3.20:
 *  - AI nutrition estimation (2026-07-12): a "Nährwerte per KI berechnen"
 *    button in RecipeDetail calls POST /recipes/:id/nutrition/ai, which
 *    hits whichever AI provider (OpenAI/Google/Anthropic/DeepSeek) is
 *    configured as default under Settings. New nutrition panel actually
 *    renders now (the "always visible" claim below the old v0.3.0 entry was
 *    stale — no such panel existed in this file until this change).
 *  - New Admin-only "Settings" tab (AISettingsView) to configure AI provider
 *    API keys, mirroring unifi-network's Gateways tab: hidden client-side
 *    from non-Admins via the same isAdmin-probe pattern (ModuleComponentProps
 *    carries no role info), enforced server-side regardless.
 *
 * Changes vs 0.2.4 (carried over from v0.3.0):
 *  - Tag filter added to RecipeList (alongside category filter)
 *  - Ingredient unit field replaced by datalist with common units
 *  - Image upload no longer requires title first (uses temp title)
 *  - Meal plan picker: event bubbling fixed so recipe selection works
 *  - Search now covers title + description (already was, just documented)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import type { ModuleComponentProps } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Recipe {
  id: string;
  title: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  servings: number;
  prep_time_min: number | null;
  cook_time_min: number | null;
  image_path: string | null;
  source_url: string | null;
  notes: string | null;
  tag_names: string[];
  updated_at: string;
  kcal_per_serving: number | null;
  protein_g_per_serving: number | null;
  fat_g_per_serving: number | null;
  carbs_g_per_serving: number | null;
  fiber_g_per_serving: number | null;
  nutrition_source: "manual" | "off" | "calculated" | "ai" | null;
}

interface Ingredient {
  id: string;
  position: number;
  name: string;
  amount: number | null;
  unit: string | null;
}

interface Step {
  id: string;
  step_number: number;
  instruction: string;
}

interface Category {
  id: string;
  name: string;
  sort_order: number;
}

interface Tag {
  id: string;
  name: string;
}

interface MealPlanEntry {
  id: string;
  week_start: string;
  day_of_week: number;
  meal_slot: string;
  recipe_id: string | null;
  recipe_title: string | null;
  recipe_image: string | null;
  note: string | null;
}

type View =
  | { type: "list" }
  | { type: "detail"; id: string }
  | { type: "editor"; id?: string }
  | { type: "meal-plan" }
  | { type: "categories" }
  | { type: "settings" }
  | { type: "info" };

// Common ingredient units shown in datalist
const UNITS = ["g", "kg", "ml", "l", "EL", "TL", "Stk", "Prise", "Bund", "Dose", "Pck", "Scheibe", "Zehe"];

// ── API helper ────────────────────────────────────────────────────────────────

// Core (or Cloudflare/Traefik in front of it) sometimes fails a request
// without ever reaching our Go handler — e.g. Cloudflare's own 502 page when
// the origin doesn't answer in time. In that case the body is a full HTML
// document, not the plain-text/JSON error Core itself would send. Dumping
// that raw markup into the UI is unreadable, so detect it and fall back to a
// short, translated message instead.
function extractErrorMessage(status: number, txt: string): string {
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(txt);
  if (looksLikeHtml || !txt.trim()) {
    return i18next.t(`${NS}:error_server`, { status }) as string;
  }
  return txt;
}

function useApi(apiBase: string, token: string) {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;

  const get = useCallback(
    async <T,>(path: string): Promise<T> => {
      const url = base + (path.startsWith("/") ? path : "/" + path);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(extractErrorMessage(r.status, txt));
      }
      return r.json();
    },
    [base, token],
  );

  const mutate = useCallback(
    async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
      const url = base + (path.startsWith("/") ? path : "/" + path);
      const r = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(extractErrorMessage(r.status, txt));
      }
      if (r.status === 204) return undefined as unknown as T;
      return r.json();
    },
    [base, token],
  );

  const upload = useCallback(
    async <T,>(path: string, formData: FormData): Promise<T> => {
      const url = base + (path.startsWith("/") ? path : "/" + path);
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(extractErrorMessage(r.status, txt));
      }
      return r.json();
    },
    [base, token],
  );

  return { get, mutate, upload };
}

// ── Root component ────────────────────────────────────────────────────────────

const NS = "mod_recipes";

export default function RecipesApp({ moduleName, apiBase, token }: ModuleComponentProps) {
  const { t } = useTranslation(NS);
  const [view, setView] = useState<View>({ type: "list" });
  const api = useApi(apiBase, token);
  setStorageBase(apiBase, token);

  // isAdmin (2026-07-12, same pattern as unifi-network's ui/src/App.tsx):
  // the Settings tab (AI provider API keys) must be fully hidden from
  // non-Admins, not just have its mutating actions rejected server-side.
  // ModuleComponentProps carries no role info, so Admin status is inferred
  // client-side from whether the Admin-only GET /ai-providers probe
  // succeeds. null = not yet known (probe in flight); the tab stays hidden
  // during that brief window rather than flashing visible for everyone. A
  // transient network error also resolves to false (hidden) — for a
  // UI-only visibility gate (the backend enforces the real permission check
  // regardless), that is the safer default.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .get("/ai-providers")
      .then(() => setIsAdmin(true))
      .catch(() => setIsAdmin(false));
  }, [api]);

  // Guards against a stale deep-link landing a non-Admin on the settings
  // tab just before it disappears from the nav — bounces back to the
  // recipe list once the Admin probe above resolves to false.
  useEffect(() => {
    if (isAdmin === false && view.type === "settings") {
      setView({ type: "list" });
    }
  }, [isAdmin, view.type]);

  return (
    <div className="recipes-module">
      {/* Navigation bar — scrollable on mobile */}
      <div className="mb-4 flex items-center gap-1 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => setView({ type: "list" })}
          className={navCls(view.type === "list")}
          title={t("nav_recipes")}
        >
          <i className="ti ti-book-2 text-[15px]" />
          <span className="hidden sm:inline">{t("nav_recipes")}</span>
        </button>
        <button
          type="button"
          onClick={() => setView({ type: "meal-plan" })}
          className={navCls(view.type === "meal-plan")}
          title={t("nav_meal_plan")}
        >
          <i className="ti ti-calendar-week text-[15px]" />
          <span className="hidden sm:inline">{t("nav_meal_plan")}</span>
        </button>
        <button
          type="button"
          onClick={() => setView({ type: "categories" })}
          className={navCls(view.type === "categories")}
          title={t("nav_categories")}
        >
          <i className="ti ti-tag text-[15px]" />
          <span className="hidden sm:inline">{t("nav_categories")}</span>
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setView({ type: "settings" })}
            className={navCls(view.type === "settings")}
            title={t("nav_settings")}
          >
            <i className="ti ti-settings text-[15px]" />
            <span className="hidden sm:inline">{t("nav_settings")}</span>
          </button>
        )}
        <div className="flex-1" style={{ minWidth: "4px" }} />
        <button
          type="button"
          onClick={() => setView({ type: "info" })}
          className={navCls(view.type === "info")}
          title={t("nav_info")}
        >
          <i className="ti ti-info-circle" style={{ fontSize: "15px" }} />
        </button>
        <button
          type="button"
          onClick={() => setView({ type: "editor" })}
          className="flex flex-none items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
          title={t("btn_new_recipe")}
        >
          <i className="ti ti-plus" style={{ fontSize: "14px" }} />
          <span className="hidden sm:inline">{t("btn_new_recipe")}</span>
        </button>
      </div>

      {view.type === "list" && (
        <RecipeList api={api} onSelect={(id) => setView({ type: "detail", id })} />
      )}
      {view.type === "detail" && (
        <RecipeDetail
          api={api}
          id={view.id}
          onBack={() => setView({ type: "list" })}
          onEdit={(id) => setView({ type: "editor", id })}
        />
      )}
      {view.type === "editor" && (
        <RecipeEditor
          api={api}
          id={view.id}
          onDone={(id) => setView({ type: "detail", id })}
          onCancel={() => setView(view.id ? { type: "detail", id: view.id } : { type: "list" })}
        />
      )}
      {view.type === "meal-plan" && <MealPlanView api={api} />}
      {view.type === "categories" && <CategoriesView api={api} />}
      {view.type === "settings" && isAdmin && <AISettingsView api={api} />}
      {view.type === "info" && <ModuleInfoView moduleName={moduleName} token={token} />}
    </div>
  );
}

function navCls(active: boolean) {
  return `flex flex-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
    active
      ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
      : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
  }`;
}

// ── RecipeList ────────────────────────────────────────────────────────────────

function RecipeList({
  api,
  onSelect,
}: {
  api: ReturnType<typeof useApi>;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation(NS);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Category[]>("/categories").then((rows) => setCategories(Array.isArray(rows) ? rows : [])).catch(() => {});
    api.get<Tag[]>("/tags").then((rows) => setTags(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [api]);

  const load = useCallback(
    async (searchVal: string, catVal: string, tagVal: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (searchVal) params.set("search", searchVal);
        if (catVal) params.set("category", catVal);
        if (tagVal) params.set("tag", tagVal);
        const qs = params.toString();
        const res = await api.get<{ recipes: Recipe[]; total: number }>(
          `/recipes${qs ? "?" + qs : ""}`,
        );
        setRecipes(Array.isArray(res.recipes) ? res.recipes : []);
        setTotal(res.total ?? 0);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    load(search, categoryId, tagFilter);
  }, [load, search, categoryId, tagFilter]);

  return (
    <div>
      {/* Filters */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          placeholder={t("search_placeholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
        />
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto sm:min-w-[160px]"
          style={{ fontSize: "16px" }}
        >
          <option value="">{t("all_categories")}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {tags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto sm:min-w-[140px]"
            style={{ fontSize: "16px" }}
          >
            <option value="">{t("all_tags")}</option>
            {tags.map((tg) => (
              <option key={tg.id} value={tg.name}>{tg.name}</option>
            ))}
          </select>
        )}
      </div>

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      {!loading && recipes.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
          <i className="ti ti-book-off text-[36px] text-gray-300 dark:text-gray-700" />
          <p className="mt-3 text-sm text-gray-400">{t("no_recipes")}</p>
        </div>
      )}

      {/* Grid: 1 col on mobile, 2 on sm, 3 on lg */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {recipes.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(r.id)}
            className="group flex flex-col gap-2 rounded-2xl border border-gray-200 bg-white p-4 text-left transition hover:border-teal-300 hover:shadow-sm dark:border-gray-800 dark:bg-gray-900"
          >
            {r.image_path && (
              <img
                src={imageUrl(r.image_path)}
                alt={r.title}
                className="h-36 w-full rounded-xl object-cover"
              />
            )}
            <div>
              <h3 className="font-semibold text-sm leading-snug">{r.title}</h3>
              <div className="mt-1 flex flex-wrap gap-1">
                {r.category_name && (
                  <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    {r.category_name}
                  </span>
                )}
                {r.tag_names?.slice(0, 3).map((tg) => (
                  <span key={tg} className="inline-block rounded-full bg-teal-50 px-2 py-0.5 text-[10px] text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                    #{tg}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-auto flex items-center gap-3 text-xs text-gray-400">
              {r.prep_time_min != null && (
                <span><i className="ti ti-clock text-[12px]" /> {t("total_time", { min: r.prep_time_min })}</span>
              )}
              <span className="ml-auto"><i className="ti ti-users text-[12px]" /> {r.servings}</span>
            </div>
          </button>
        ))}
      </div>
      {total > recipes.length && (
        <p className="mt-4 text-center text-xs text-gray-400">{t("recipes_total", { count: total })}</p>
      )}
    </div>
  );
}

// ── RecipeDetail ──────────────────────────────────────────────────────────────

function RecipeDetail({
  api,
  id,
  onBack,
  onEdit,
}: {
  api: ReturnType<typeof useApi>;
  id: string;
  onBack: () => void;
  onEdit: (id: string) => void;
}) {
  const { t } = useTranslation(NS);
  const [recipe, setRecipe] = useState<Recipe & { ingredients: Ingredient[]; steps: Step[]; tags: Tag[] } | null>(null);
  const [servings, setServings] = useState(4);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [aiCalculating, setAiCalculating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Recipe & { ingredients: Ingredient[]; steps: Step[]; tags: Tag[] }>(`/recipes/${id}`)
      .then((r) => {
        setRecipe(r);
        setServings(r.servings);
      })
      .finally(() => setLoading(false));
  }, [api, id]);

  async function handleDelete() {
    if (!window.confirm(t("recipe_delete_confirm"))) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.mutate("DELETE", `/recipes/${id}`);
      onBack();
    } catch {
      // Bugfix (2026-07-05): previously only reset the `deleting` flag with
      // no user-visible error — a failed delete looked identical to a
      // successful one that just hadn't navigated away yet.
      setDeleteError(t("recipe_delete_error"));
      setDeleting(false);
    }
  }

  async function handleCalcNutritionAi() {
    setAiCalculating(true);
    setAiError(null);
    try {
      const updated = await api.mutate<Recipe>("POST", `/recipes/${id}/nutrition/ai`, {});
      setRecipe((prev) => (prev ? { ...prev, ...updated } : prev));
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiCalculating(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-400">{t("loading")}</p>;
  if (!recipe) return <p className="text-sm text-red-500">{t("recipe_not_found")}</p>;

  const totalMin = (recipe.prep_time_min ?? 0) + (recipe.cook_time_min ?? 0);

  return (
    <div className="mx-auto max-w-2xl">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <i className="ti ti-arrow-left text-[14px]" /> {t("back")}
      </button>

      {deleteError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {deleteError}
        </div>
      )}

      {recipe.image_path && (
        <img
          src={imageUrl(recipe.image_path)}
          alt={recipe.title}
          className="mb-4 h-48 w-full rounded-2xl object-cover sm:h-56"
        />
      )}

      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{recipe.title}</h1>
          <div className="mt-1 flex flex-wrap gap-1">
            {recipe.category_name && (
              <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                {recipe.category_name}
              </span>
            )}
            {recipe.tags?.map((tag) => (
              <span key={tag.id} className="inline-block rounded-full bg-teal-50 px-2.5 py-0.5 text-xs text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                #{tag.name}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onEdit(id)}
            className="flex flex-none items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            <i className="ti ti-pencil text-[14px]" /> {t("edit")}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="flex flex-none items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950 disabled:opacity-50"
          >
            <i className="ti ti-trash text-[14px]" />
            <span className="hidden sm:inline">{t("delete")}</span>
          </button>
        </div>
      </div>

      {/* Meta row */}
      <div className="mb-4 flex flex-wrap gap-3 text-sm text-gray-500 dark:text-gray-400">
        {totalMin > 0 && <span><i className="ti ti-clock" /> {t("total_time", { min: totalMin })}</span>}
        <span><i className="ti ti-users" /> {recipe.servings} {t("servings")}</span>
        {recipe.source_url && (
          <a href={recipe.source_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-teal-600">
            <i className="ti ti-external-link" /> {t("source")}
          </a>
        )}
      </div>

      {recipe.description && (
        <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">{recipe.description}</p>
      )}

      {/* Notes */}
      {recipe.notes && (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
            <i className="ti ti-note text-[13px]" /> {t("notes")}
          </div>
          <p className="whitespace-pre-wrap text-sm text-amber-900 dark:text-amber-200">{recipe.notes}</p>
        </div>
      )}

      {/* Nutrition */}
      <div className="mb-5 rounded-2xl border border-gray-200 p-4 dark:border-gray-800">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="font-semibold">{t("nutrition")}</h2>
          <button
            type="button"
            onClick={handleCalcNutritionAi}
            disabled={aiCalculating || recipe.ingredients.length === 0}
            className="flex flex-none items-center gap-1.5 rounded-lg border border-teal-300 px-2.5 py-1.5 text-xs font-medium text-teal-700 hover:bg-teal-50 disabled:opacity-50 dark:border-teal-800 dark:text-teal-300 dark:hover:bg-teal-950"
          >
            {aiCalculating ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-sparkles text-[13px]" />}
            {t("calc_nutrition_ai")}
          </button>
        </div>
        {aiError && (
          <p className="mb-2 text-xs text-red-600 dark:text-red-400">{aiError}</p>
        )}
        {recipe.kcal_per_serving != null ? (
          <div className="flex flex-wrap gap-4 text-sm">
            <span><strong>{Math.round(recipe.kcal_per_serving * (servings / (recipe.servings || 1)))}</strong> kcal</span>
            {recipe.protein_g_per_serving != null && <span>{t("nutrition_protein")}: {+(recipe.protein_g_per_serving * (servings / (recipe.servings || 1))).toFixed(1)} g</span>}
            {recipe.fat_g_per_serving != null && <span>{t("nutrition_fat")}: {+(recipe.fat_g_per_serving * (servings / (recipe.servings || 1))).toFixed(1)} g</span>}
            {recipe.carbs_g_per_serving != null && <span>{t("nutrition_carbs")}: {+(recipe.carbs_g_per_serving * (servings / (recipe.servings || 1))).toFixed(1)} g</span>}
            {recipe.fiber_g_per_serving != null && <span>{t("nutrition_fiber")}: {+(recipe.fiber_g_per_serving * (servings / (recipe.servings || 1))).toFixed(1)} g</span>}
            {recipe.nutrition_source && (
              <span className="text-gray-400">({t(`nutrition_source_${recipe.nutrition_source}`)})</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400">{t("nutrition_unavailable")}</p>
        )}
      </div>

      {/* Ingredients */}
      {recipe.ingredients.length > 0 && (
        <div className="mb-5">
          <h2 className="mb-2 font-semibold">{t("ingredients")}</h2>
          <ul className="space-y-1.5">
            {recipe.ingredients.map((ing) => {
              const factor = servings / (recipe.servings || 1);
              const amount = ing.amount != null ? +(ing.amount * factor).toFixed(1) : null;
              return (
                <li key={ing.id} className="flex items-baseline gap-2 text-sm">
                  <span className="w-20 flex-none text-right font-medium">
                    {amount != null ? `${amount}${ing.unit ? " " + ing.unit : ""}` : ""}
                  </span>
                  <span className="text-gray-700 dark:text-gray-300">{ing.name}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Steps */}
      {recipe.steps.length > 0 && (
        <div className="mb-5">
          <h2 className="mb-2 font-semibold">{t("steps")}</h2>
          <ol className="space-y-3">
            {recipe.steps.map((step) => (
              <li key={step.id} className="flex gap-3 text-sm">
                <span style={{ width: "1.5rem", height: "1.5rem", flexShrink: 0, fontSize: "11px", fontWeight: 700, lineHeight: "1.5rem" }}
                  className="flex items-center justify-center rounded-full bg-teal-600 text-white">
                  {step.step_number}
                </span>
                <p className="text-gray-700 dark:text-gray-300">{step.instruction}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ── RecipeEditor ──────────────────────────────────────────────────────────────

function RecipeEditor({
  api,
  id,
  onDone,
  onCancel,
}: {
  api: ReturnType<typeof useApi>;
  id?: string;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(NS);
  const isEdit = !!id;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [servings, setServings] = useState(4);
  const [prepTime, setPrepTime] = useState("");
  const [cookTime, setCookTime] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [ingredients, setIngredients] = useState<Array<{ name: string; amount: string; unit: string }>>([
    { name: "", amount: "", unit: "" },
  ]);
  const [steps, setSteps] = useState<string[]>([""]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Image upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  // recipeIdRef tracks the already-created recipe ID so image upload
  // doesn't require saving first and doesn't cause double-creation.
  const recipeIdRef = useRef<string | null>(id ?? null);

  useEffect(() => {
    api.get<Category[]>("/categories").then((rows) => setCategories(Array.isArray(rows) ? rows : [])).catch(() => {});
    api.get<Tag[]>("/tags").then((rows) => setAllTags(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!id) return;
    api
      .get<Recipe & { ingredients: Ingredient[]; steps: Step[]; tags: Tag[] }>(`/recipes/${id}`)
      .then((r) => {
        setTitle(r.title);
        setDescription(r.description ?? "");
        setCategoryId(r.category_id ?? "");
        setServings(r.servings);
        setPrepTime(r.prep_time_min?.toString() ?? "");
        setCookTime(r.cook_time_min?.toString() ?? "");
        setNotes(r.notes ?? "");
        if (r.image_path) setImagePreview(imageUrl(r.image_path));
        setTags(Array.isArray(r.tags) ? r.tags : []);
        setIngredients(
          r.ingredients.length
            ? r.ingredients.map((i) => ({
                name: i.name,
                amount: i.amount?.toString() ?? "",
                unit: i.unit ?? "",
              }))
            : [{ name: "", amount: "", unit: "" }],
        );
        setSteps(r.steps.length ? r.steps.map((s) => s.instruction) : [""]);
      })
      .catch(() => setError(t("recipe_load_error")));
  }, [api, id, t]);

  async function handleSave() {
    if (!title.trim()) { setError(t("title_required")); return; }
    setSaving(true);
    setError(null);
    try {
      const body = {
        title: title.trim(),
        description: description.trim(),
        category_id: categoryId || null,
        servings,
        prep_time_min: prepTime ? parseInt(prepTime) : null,
        cook_time_min: cookTime ? parseInt(cookTime) : null,
        notes: notes.trim() || null,
      };

      let recipeId: string;
      if (isEdit) {
        await api.mutate("PATCH", `/recipes/${id}`, body);
        recipeId = id!;
      } else if (recipeIdRef.current) {
        await api.mutate("PATCH", `/recipes/${recipeIdRef.current}`, body);
        recipeId = recipeIdRef.current;
      } else {
        const created = await api.mutate<{ id: string }>("POST", "/recipes", body);
        recipeId = created.id;
        recipeIdRef.current = recipeId;
      }

      // Save ingredients
      const ingrPayload = ingredients
        .filter((i) => i.name.trim())
        .map((i) => ({
          name: i.name.trim(),
          amount: i.amount ? parseFloat(i.amount) : null,
          unit: i.unit || null,
        }));
      await api.mutate("PUT", `/recipes/${recipeId}/ingredients`, ingrPayload);

      // Save steps
      const stepsPayload = steps
        .filter((s) => s.trim())
        .map((s) => ({ instruction: s.trim() }));
      await api.mutate("PUT", `/recipes/${recipeId}/steps`, stepsPayload);

      // Save tags
      await api.mutate("PUT", `/recipes/${recipeId}/tags`, { tag_ids: tags.map((tg) => tg.id) });

      onDone(recipeId);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleImageUpload(file: File) {
    // Create a draft recipe if we don't have an ID yet —
    // use a temp title or the current title if available.
    if (!recipeIdRef.current) {
      setError(null);
      try {
        const created = await api.mutate<{ id: string }>("POST", "/recipes", {
          title: title.trim() || t("draft_recipe_title"),
          servings,
        });
        recipeIdRef.current = created.id;
        // If we used a placeholder, prefill title so user can see + edit it
        if (!title.trim()) setTitle(t("draft_recipe_title"));
      } catch (e) {
        setError(String(e));
        return;
      }
    }

    setImageUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.upload<{ image_path: string }>(`/recipes/${recipeIdRef.current}/image`, fd);
      setImagePreview(imageUrl(res.image_path));
    } catch (e) {
      setError(String(e));
    } finally {
      setImageUploading(false);
    }
  }

  async function handleImageDelete() {
    setError(null);
    try {
      const recipeId = recipeIdRef.current ?? id;
      if (recipeId) await api.mutate("DELETE", `/recipes/${recipeId}/image`);
      setImagePreview(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setError(String(e));
    }
  }

  async function addTag(tag: Tag) {
    if (!tags.find((t) => t.id === tag.id)) {
      setTags([...tags, tag]);
    }
    setNewTagName("");
  }

  async function createAndAddTag(name: string) {
    try {
      const created = await api.mutate<Tag>("POST", "/tags", { name: name.trim() });
      setAllTags((prev) => [...prev.filter((t) => t.id !== created.id), created]);
      addTag(created);
    } catch (e) {
      setError(String(e));
    }
  }

  const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";
  const labelCls = "mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300";

  return (
    <div className="mx-auto max-w-2xl">
      <button type="button" onClick={onCancel}
        className="mb-4 flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:text-gray-400">
        <i className="ti ti-arrow-left text-[14px]" /> {t("cancel")}
      </button>
      <h1 className="mb-5 text-xl font-semibold">{isEdit ? t("edit_recipe") : t("new_recipe")}</h1>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {/* Image upload — no title required */}
        <div>
          <label className={labelCls}>{t("image")}</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImageUpload(file);
            }}
          />
          {imagePreview ? (
            <div className="relative">
              <img src={imagePreview} alt="" className="h-40 w-full rounded-xl object-cover" />
              <div className="absolute bottom-2 right-2 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={imageUploading}
                  className="flex items-center gap-1.5 rounded-lg bg-black/60 px-3 py-1.5 text-xs font-medium text-white hover:bg-black/80 disabled:opacity-50"
                >
                  {imageUploading
                    ? <><i className="ti ti-loader-2 animate-spin text-[12px]" /> {t("uploading")}</>
                    : <><i className="ti ti-camera text-[12px]" /> {t("change_image")}</>
                  }
                </button>
                <button
                  type="button"
                  onClick={handleImageDelete}
                  disabled={imageUploading}
                  className="flex items-center justify-center rounded-lg bg-black/60 px-2 py-1.5 text-xs text-red-300 hover:bg-red-600/80 hover:text-white disabled:opacity-50"
                  title={t("delete_image")}
                >
                  <i className="ti ti-trash text-[13px]" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={imageUploading}
              className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-gray-300 text-sm text-gray-400 hover:border-teal-400 hover:text-teal-600 dark:border-gray-700 disabled:opacity-50"
            >
              {imageUploading
                ? <><i className="ti ti-loader-2 animate-spin text-[22px]" /><span>{t("uploading")}</span></>
                : <><i className="ti ti-photo text-[28px]" /><span>{t("upload_image")}</span></>
              }
            </button>
          )}
        </div>

        <div>
          <label className={labelCls}>{t("title")} *</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            className={inputCls} style={{ fontSize: "16px" }} placeholder={t("title_placeholder")} />
        </div>
        <div>
          <label className={labelCls}>{t("description")}</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)}
            className={inputCls} rows={2} style={{ fontSize: "16px" }} />
        </div>

        {/* Category + Servings */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t("category")}</label>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
              className={inputCls} style={{ fontSize: "16px" }}>
              <option value="">—</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t("servings")}</label>
            <input type="number" min={1} value={servings} onChange={(e) => setServings(parseInt(e.target.value) || 1)}
              className={inputCls} style={{ fontSize: "16px" }} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t("prep_time")}</label>
            <input type="number" min={0} value={prepTime} onChange={(e) => setPrepTime(e.target.value)}
              className={inputCls} style={{ fontSize: "16px" }} placeholder="15" />
          </div>
          <div>
            <label className={labelCls}>{t("cook_time")}</label>
            <input type="number" min={0} value={cookTime} onChange={(e) => setCookTime(e.target.value)}
              className={inputCls} style={{ fontSize: "16px" }} placeholder="30" />
          </div>
        </div>

        {/* Tags */}
        <div>
          <label className={labelCls}>{t("tags")}</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {tags.map((tg) => (
              <span key={tg.id} className="flex items-center gap-1 rounded-full bg-teal-50 px-2.5 py-0.5 text-xs text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                #{tg.name}
                <button type="button" onClick={() => setTags(tags.filter((t) => t.id !== tg.id))}
                  className="ml-0.5 text-teal-400 hover:text-red-500">×</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder={t("tag_placeholder")}
              list="tag-suggestions"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900"
              style={{ fontSize: "16px" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTagName.trim()) {
                  e.preventDefault();
                  const existing = allTags.find((t) => t.name.toLowerCase() === newTagName.trim().toLowerCase());
                  if (existing) addTag(existing);
                  else createAndAddTag(newTagName.trim());
                }
              }}
            />
            <datalist id="tag-suggestions">
              {allTags.filter((t) => !tags.find((sel) => sel.id === t.id)).map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
            <button
              type="button"
              disabled={!newTagName.trim()}
              onClick={() => {
                if (!newTagName.trim()) return;
                const existing = allTags.find((t) => t.name.toLowerCase() === newTagName.trim().toLowerCase());
                if (existing) addTag(existing);
                else createAndAddTag(newTagName.trim());
              }}
              className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 disabled:opacity-40"
            >
              <i className="ti ti-plus text-[13px]" /> {t("add_tag")}
            </button>
          </div>
        </div>

        {/* Ingredients */}
        <div>
          <label className={labelCls}>{t("ingredients")}</label>
          {/* datalist for units */}
          <datalist id="unit-list">
            {UNITS.map((u) => <option key={u} value={u} />)}
          </datalist>
          <div className="space-y-2">
            {ingredients.map((ing, i) => (
              <div key={i} className="flex gap-2">
                <input type="number" step="0.1" min={0} placeholder={t("amount_placeholder")}
                  value={ing.amount} onChange={(e) => { const n = [...ingredients]; n[i].amount = e.target.value; setIngredients(n); }}
                  className="w-16 rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" style={{ fontSize: "16px" }} />
                <input
                  type="text"
                  placeholder={t("unit_placeholder")}
                  value={ing.unit}
                  list="unit-list"
                  onChange={(e) => { const n = [...ingredients]; n[i].unit = e.target.value; setIngredients(n); }}
                  className="w-20 rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                  style={{ fontSize: "16px" }}
                />
                <input type="text" placeholder={t("ingredient_placeholder")}
                  value={ing.name} onChange={(e) => { const n = [...ingredients]; n[i].name = e.target.value; setIngredients(n); }}
                  className="flex-1 rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" style={{ fontSize: "16px" }} />
                <button type="button" onClick={() => setIngredients(ingredients.filter((_, j) => j !== i))}
                  className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500">
                  <i className="ti ti-trash text-[14px]" />
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setIngredients([...ingredients, { name: "", amount: "", unit: "" }])}
            className="mt-2 flex items-center gap-1.5 text-sm text-teal-600 hover:text-teal-700">
            <i className="ti ti-plus text-[13px]" /> {t("add_ingredient")}
          </button>
        </div>

        {/* Steps */}
        <div>
          <label className={labelCls}>{t("steps")}</label>
          <div className="space-y-2">
            {steps.map((step, i) => (
              <div key={i} className="flex gap-2">
                <span style={{ width: "1.5rem", height: "1.5rem", flexShrink: 0, fontSize: "11px", fontWeight: 700, lineHeight: "1.5rem", marginTop: "10px" }}
                  className="flex items-center justify-center rounded-full bg-teal-600 text-white">
                  {i + 1}
                </span>
                <textarea value={step} onChange={(e) => { const n = [...steps]; n[i] = e.target.value; setSteps(n); }}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                  rows={2} style={{ fontSize: "16px" }} placeholder={t("step_placeholder", { n: i + 1 })} />
                <button type="button" onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                  className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500">
                  <i className="ti ti-trash text-[14px]" />
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setSteps([...steps, ""])}
            className="mt-2 flex items-center gap-1.5 text-sm text-teal-600 hover:text-teal-700">
            <i className="ti ti-plus text-[13px]" /> {t("add_step")}
          </button>
        </div>

        {/* Notes */}
        <div>
          <label className={labelCls}>{t("notes")}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={inputCls}
            rows={3}
            style={{ fontSize: "16px" }}
            placeholder={t("notes_placeholder")}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
            {t("cancel")}
          </button>
          <button type="button" onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
            {saving ? <><i className="ti ti-loader-2 animate-spin text-[13px]" /> {t("saving")}</> : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MealPlanView ──────────────────────────────────────────────────────────────

const SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;

function mondayOfWeek(offset = 0): string {
  const d = new Date();
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1 + offset * 7);
  return d.toISOString().slice(0, 10);
}

// ISO-8601 week number (weeks start Monday, week 1 contains the year's first
// Thursday — same definition as German "Kalenderwoche"). Takes the Monday
// date string mondayOfWeek() already produces, so no extra day-of-week
// normalization is needed here beyond what that function already does.
function isoWeekNumber(mondayIso: string): number {
  const d = new Date(mondayIso + "T00:00:00Z");
  // Thursday of this week determines the ISO week's year (handles
  // year-boundary weeks, e.g. Mon Dec 30 2025 belongs to week 1 of 2026).
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return weekNo;
}

// German-style "dd.mm." short date, used for the from/to range in the meal
// plan week header. Locale-agnostic on purpose (matches how German users
// write date ranges regardless of UI language) — this mirrors an existing
// pattern of some labels being fixed rather than i18n'd where the format is
// a deliberate stylistic choice, not user-facing translated text.
function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.`;
}

function sundayOfWeek(mondayIso: string): string {
  const d = new Date(mondayIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function MealPlanView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [weekOffset, setWeekOffset] = useState(0);
  const weekStart = mondayOfWeek(weekOffset);
  const [entries, setEntries] = useState<MealPlanEntry[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerCell, setPickerCell] = useState<{ day: number; slot: string } | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [mealPlanError, setMealPlanError] = useState<string | null>(null);

  const DAY_KEYS = ["day_mon", "day_tue", "day_wed", "day_thu", "day_fri", "day_sat", "day_sun"] as const;

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get<{ entries: MealPlanEntry[] }>(`/meal-plan?week=${weekStart}`),
      api.get<{ recipes: Recipe[] }>("/recipes?limit=200"),
    ])
      .then(([plan, rList]) => {
        setEntries(plan.entries ?? []);
        setRecipes(rList.recipes ?? []);
      })
      .finally(() => setLoading(false));
  }, [api, weekStart]);

  // Picker is now a modal overlay (see render below) that closes via its own
  // backdrop onClick + stopPropagation on the inner panel — no document-level
  // click listener needed anymore (the old dropdown approach used one to
  // detect clicks outside the table cell; not applicable to a fixed overlay).

  function entryFor(day: number, slot: string) {
    return entries.find((e) => e.day_of_week === day && e.meal_slot === slot);
  }

  async function setEntry(day: number, slot: string, recipeId: string | null) {
    try {
      const updated = await api.mutate<MealPlanEntry>(
        "PUT",
        `/meal-plan/${weekStart}/${day}/${slot}`,
        { recipe_id: recipeId },
      );
      // RETURNING * from the DB doesn't include recipe_title — enrich from local list
      const recipe = recipes.find((r) => r.id === recipeId);
      const enriched: MealPlanEntry = {
        ...updated,
        recipe_title: recipe?.title ?? updated.recipe_title ?? null,
        recipe_image: recipe?.image_path ?? updated.recipe_image ?? null,
      };
      setEntries((prev) => {
        const without = prev.filter((e) => !(e.day_of_week === day && e.meal_slot === slot));
        return [...without, enriched];
      });
    } catch (e) {
      console.error("setEntry failed", e);
    }
    setPickerCell(null);
    setPickerSearch("");
  }

  async function clearEntry(day: number, slot: string) {
    setMealPlanError(null);
    try {
      await api.mutate("DELETE", `/meal-plan/${weekStart}/${day}/${slot}`);
      setEntries((prev) => prev.filter((e) => !(e.day_of_week === day && e.meal_slot === slot)));
    } catch {
      // Bugfix (2026-07-05): previously had no try/catch at all — a failed
      // DELETE call threw unhandled, and the picker still closed as if it
      // had worked (setPickerCell(null) below still ran via the outer flow
      // in the old code path). Now the entry is only removed from local
      // state on success, and a failure is shown instead.
      setMealPlanError(t("meal_plan_clear_error"));
    }
    setPickerCell(null);
    setPickerSearch("");
  }

  const filteredRecipes = recipes.filter((r) =>
    !pickerSearch || r.title.toLowerCase().includes(pickerSearch.toLowerCase()),
  );

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={() => setWeekOffset((o) => o - 1)}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
          <i className="ti ti-chevron-left" />
        </button>
        <span className="text-sm font-medium">
          {t("meal_plan_week", {
            week: isoWeekNumber(weekStart),
            from: shortDate(weekStart),
            to: shortDate(sundayOfWeek(weekStart)),
          })}
        </span>
        <button type="button" onClick={() => setWeekOffset((o) => o + 1)}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
          <i className="ti ti-chevron-right" />
        </button>
        <button type="button" onClick={() => setWeekOffset(0)}
          className="text-xs text-teal-600 hover:underline">{t("this_week")}</button>
      </div>

      {mealPlanError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {mealPlanError}
        </div>
      )}

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      {/* overflow-x-auto alone still constrains the vertical axis to
          "clip" in some browsers (the CSS overflow spec resolves a
          specified overflow-x together with a computed overflow-y: visible
          into overflow-y: auto — see
          https://www.w3.org/TR/css-overflow-3/#overflow-properties). That
          silently turned this wrapper into a second, nested scroll
          container: the picker dropdown below (position: absolute,
          intentionally meant to overflow past the table) got clipped by/
          added scrollable height to THIS div instead of overflowing onto
          the page, and the resulting reflow of the wrapper's own height is
          what caused the whole page to visibly jump when opening a picker.
          overflowY: "visible" here overrides that implicit auto so the
          dropdown escapes the horizontal scroll wrapper entirely, the same
          way it already escapes the table. */}
      <div className="overflow-x-auto" style={{ overflowY: "visible" }}>
        {/* min-w-[500px] as inline style: Tailwind arbitrary-value classes
            are purged in production (Core has no own Tailwind compiler,
            only classes Core itself uses survive purge — recurring issue in
            this project). Without a fixed min-width the table could
            collapse narrower than its 7-day grid needs, contributing to the
            page-jump bug when the picker dropdown opens (see min-h-[48px]
            fix below in the same table). */}
        <table className="w-full border-collapse text-sm" style={{ minWidth: "500px" }}>
          <thead>
            <tr>
              <th className="w-20 py-2 text-left font-medium text-gray-500" />
              {DAY_KEYS.map((key) => (
                <th key={key} className="py-2 text-center font-medium text-gray-700 dark:text-gray-300">{t(key)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SLOTS.map((slot) => (
              <tr key={slot}>
                <td className="pr-2 py-1.5 text-right text-xs font-medium text-gray-400">{t(`slot_${slot}`)}</td>
                {[1,2,3,4,5,6,7].map((day) => {
                  const entry = entryFor(day, slot);
                  const isOpen = pickerCell?.day === day && pickerCell?.slot === slot;
                  return (
                    <td key={day} className="relative p-1">
                      {/* Cell: click opens picker */}
                      <div
                        data-picker
                        // min-h-[48px] as inline style (see comment on the
                        // table's min-w-[500px] above): without it the cell
                        // collapses to its content height, and combined with
                        // the picker dropdown below (position: absolute but
                        // anchored to a now-shorter cell) this was causing
                        // the whole page to jump when opening it — the
                        // browser reflows the shorter row before the
                        // dropdown repositions.
                        style={{ minHeight: "48px" }}
                        className={`cursor-pointer rounded-xl border p-1.5 text-center text-xs transition ${
                          entry
                            ? "border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200"
                            : "border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPickerCell(isOpen ? null : { day, slot });
                          setPickerSearch("");
                        }}
                      >
                        {entry?.recipe_title ?? <span className="text-gray-300 dark:text-gray-700">+</span>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recipe picker — rendered as a centered modal overlay instead of a
          position: absolute dropdown anchored inside the table cell.
          The previous dropdown approach caused the whole page to visibly
          jump open (confirmed live in Chrome even after fixing the
          min-w/min-h purge issue and the overflow-x-auto/overflow-y
          interaction — see git history on this file). A modal rendered
          here, outside the table/scroll-wrapper DOM entirely and
          positioned with `fixed` relative to the viewport, cannot be
          affected by any ancestor's overflow or box-size changes, so this
          class of bug structurally cannot recur regardless of what's
          above it in the tree. */}
      {pickerCell && (() => {
        const { day, slot } = pickerCell;
        const entry = entryFor(day, slot);
        return (
          <div
            className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
            onClick={() => { setPickerCell(null); setPickerSearch(""); }}
          >
            <div
              className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-2 border-b border-gray-100 p-3 dark:border-gray-800">
                <span className="text-sm font-medium">{t(DAY_KEYS[day - 1])} · {t(`slot_${slot}`)}</span>
                <button
                  type="button"
                  onClick={() => { setPickerCell(null); setPickerSearch(""); }}
                  className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800"
                >
                  <i className="ti ti-x" style={{ fontSize: "16px" }} />
                </button>
              </div>
              <div className="p-3 border-b border-gray-100 dark:border-gray-800">
                <input
                  type="search"
                  autoFocus
                  placeholder={t("search_placeholder")}
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
                  style={{ fontSize: "16px" }}
                />
              </div>
              <div className="max-h-80 overflow-y-auto p-1.5">
                {entry && (
                  <button
                    type="button"
                    onClick={() => clearEntry(day, slot)}
                    className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    <i className="ti ti-trash" style={{ fontSize: "14px" }} /> {t("clear")}
                  </button>
                )}
                {filteredRecipes.length === 0 && (
                  <p className="px-3 py-4 text-center text-sm text-gray-400">{t("no_recipes")}</p>
                )}
                {filteredRecipes.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setEntry(day, slot, r.id)}
                    className="flex w-full items-center rounded-lg px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 text-left"
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── CategoriesView ────────────────────────────────────────────────────────────

function CategoriesView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<Category[]>("/categories");
      setCategories(Array.isArray(rows) ? rows : []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  function startNew() { setEditingId("new"); setName(""); setError(null); }
  function startEdit(cat: Category) { setEditingId(cat.id); setName(cat.name); setError(null); }
  function cancelEdit() { setEditingId(null); setError(null); }

  async function handleSave() {
    if (!name.trim()) { setError(t("category_name_required")); return; }
    setSaving(true);
    setError(null);
    try {
      if (editingId === "new") {
        await api.mutate("POST", "/categories", { name: name.trim() });
      } else {
        await api.mutate("PATCH", `/categories/${editingId}`, { name: name.trim() });
      }
      setEditingId(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm(t("category_delete_confirm"))) return;
    try {
      await api.mutate("DELETE", `/categories/${id}`);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  const inputCls = "rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("categories_title")}</h2>
        {editingId === null && (
          <button type="button" onClick={startNew}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700">
            <i className="ti ti-plus text-[13px]" /> {t("new_category")}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {editingId !== null && (
        <div className="mb-4 rounded-2xl border border-teal-200 bg-teal-50 p-4 dark:border-teal-800 dark:bg-teal-950">
          <div className="flex gap-2">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder={t("category_name_placeholder")} className={`flex-1 ${inputCls}`}
              style={{ fontSize: "16px" }} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") cancelEdit(); }} />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={cancelEdit}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
              {t("cancel")}
            </button>
            <button type="button" onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
              {saving ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-check text-[13px]" />}
              {t("save")}
            </button>
          </div>
        </div>
      )}

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      {!loading && categories.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-10 text-center dark:border-gray-800">
          <i className="ti ti-tag text-[32px] text-gray-300 dark:text-gray-700" />
          <p className="mt-2 text-sm text-gray-400">{t("no_categories")}</p>
        </div>
      )}

      <div className="space-y-1.5">
        {categories.map((cat) => (
          <div key={cat.id}
            className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-800">
            <span className="flex-1 text-sm font-medium">{cat.name}</span>
            <button type="button" onClick={() => startEdit(cat)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
              <i className="ti ti-pencil text-[14px]" />
            </button>
            <button type="button" onClick={() => handleDelete(cat.id)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
              <i className="ti ti-trash text-[14px]" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AISettingsView ───────────────────────────────────────────────────────────
//
// Admin-only. Configure API keys for the four supported AI providers used
// by "Nährwerte per KI berechnen" in RecipeDetail. Keys are write-only from
// here on out: GET /ai-providers never returns api_key_enc/the plaintext
// key (see handlers/index.ts listAiProviders), only has_key: true/false — so
// the input field always starts empty and a save with it left empty keeps
// whatever key is already stored (mirrors unifi-network's Gateway edit form).

const AI_PROVIDERS: { id: string; label: string; placeholder_model: string }[] = [
  { id: "openai", label: "OpenAI", placeholder_model: "gpt-5.6" },
  { id: "google", label: "Google Gemini", placeholder_model: "gemini-3.1-flash-lite" },
  { id: "anthropic", label: "Anthropic Claude", placeholder_model: "claude-haiku-4-5" },
  { id: "deepseek", label: "DeepSeek", placeholder_model: "deepseek-v4-flash" },
];

interface AiProviderConfig {
  provider: string;
  model: string;
  enabled: boolean;
  is_default: boolean;
  has_key: boolean;
  updated_at?: string;
}

function AISettingsView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [configs, setConfigs] = useState<Record<string, AiProviderConfig>>({});
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [enabledInput, setEnabledInput] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<AiProviderConfig[]>("/ai-providers");
      const byProvider: Record<string, AiProviderConfig> = {};
      for (const row of Array.isArray(rows) ? rows : []) byProvider[row.provider] = row;
      setConfigs(byProvider);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  function startEdit(providerId: string) {
    const existing = configs[providerId];
    const meta = AI_PROVIDERS.find((p) => p.id === providerId)!;
    setEditingId(providerId);
    setApiKeyInput("");
    setModelInput(existing?.model ?? meta.placeholder_model);
    setEnabledInput(existing?.enabled ?? true);
    setError(null);
  }
  function cancelEdit() { setEditingId(null); setError(null); }

  async function handleSave(providerId: string) {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { model: modelInput.trim(), enabled: enabledInput };
      if (apiKeyInput.trim()) body.api_key = apiKeyInput.trim();
      await api.mutate("PUT", `/ai-providers/${providerId}`, body);
      setEditingId(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(providerId: string) {
    setError(null);
    try {
      await api.mutate("PUT", `/ai-providers/${providerId}`, { is_default: true });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(providerId: string) {
    if (!window.confirm(t("ai_settings_delete_confirm"))) return;
    setError(null);
    try {
      await api.mutate("DELETE", `/ai-providers/${providerId}`);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";

  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-1 text-lg font-semibold">{t("ai_settings_title")}</h2>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t("ai_settings_description")}</p>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      {!loading && (
        <div className="space-y-3">
          {AI_PROVIDERS.map((meta) => {
            const cfg = configs[meta.id];
            const isEditing = editingId === meta.id;
            return (
              <div key={meta.id} className="rounded-2xl border border-gray-200 p-4 dark:border-gray-800">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{meta.label}</span>
                      {cfg?.has_key && (
                        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                          {t("ai_settings_configured")}
                        </span>
                      )}
                      {cfg?.is_default && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                          {t("ai_settings_default")}
                        </span>
                      )}
                      {cfg && !cfg.enabled && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                          {t("ai_settings_disabled")}
                        </span>
                      )}
                    </div>
                    {cfg?.model && <div className="mt-0.5 text-xs text-gray-400">{cfg.model}</div>}
                  </div>
                  {!isEditing && (
                    <div className="flex flex-none gap-2">
                      {cfg?.has_key && !cfg.is_default && (
                        <button type="button" onClick={() => handleSetDefault(meta.id)}
                          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
                          {t("ai_settings_make_default")}
                        </button>
                      )}
                      <button type="button" onClick={() => startEdit(meta.id)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
                        <i className="ti ti-pencil text-[14px]" />
                      </button>
                      {cfg?.has_key && (
                        <button type="button" onClick={() => handleDelete(meta.id)}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
                          <i className="ti ti-trash text-[14px]" />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {isEditing && (
                  <div className="mt-3 space-y-2">
                    <div>
                      <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">{t("ai_settings_api_key")}</label>
                      <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder={cfg?.has_key ? t("ai_settings_api_key_keep") : ""}
                        className={inputCls} style={{ fontSize: "16px" }} autoFocus />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">{t("ai_settings_model")}</label>
                      <input type="text" value={modelInput} onChange={(e) => setModelInput(e.target.value)}
                        placeholder={meta.placeholder_model} className={inputCls} style={{ fontSize: "16px" }} />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={enabledInput} onChange={(e) => setEnabledInput(e.target.checked)} />
                      {t("ai_settings_enabled")}
                    </label>
                    <div className="flex justify-end gap-2 pt-1">
                      <button type="button" onClick={cancelEdit}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
                        {t("cancel")}
                      </button>
                      <button type="button" onClick={() => handleSave(meta.id)} disabled={saving}
                        className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
                        {saving ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-check text-[13px]" />}
                        {t("save")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── ModuleInfoView ────────────────────────────────────────────────────────────
//
// Shows installed_modules metadata for this module (version, tier, author,
// license, description, egress allowlist, install date, pending update).
// Calls Core's GET /v1/modules/{name} directly — NOT this module's own
// apiBase/api/ proxy — because that's Core's route, not something the
// recipes handler (handlers/index.ts) exposes itself. Same-origin, so a
// plain fetch() with the existing Bearer token works with no extra CORS
// setup; ModulePage.tsx (Core's frontend) calls the exact same route the
// exact same way.
//
// Deliberately written with no recipes-specific assumptions beyond
// moduleName/token, so it can be lifted into a shared component later
// (e.g. when @modulab/ui becomes a real package as part of the iframe
// module-rendering migration — see Task #13) instead of being copy-pasted
// into my-place/unifi-network as-is.

interface InstalledModuleInfo {
  name: string;
  version: string;
  tier: number;
  scope: string;
  status: string;
  installed_at: string;
  updated_at: string;
  available_version?: string | null;
  manifest?: {
    description?: string;
    author?: string;
    license?: string;
    category?: string;
    egress_allowlist?: string[];
  };
}

function ModuleInfoView({ moduleName, token }: { moduleName: string; token: string }) {
  const { t } = useTranslation(NS);
  const [info, setInfo] = useState<InstalledModuleInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/v1/modules/${encodeURIComponent(moduleName)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setInfo(data);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [moduleName, token]);

  const rowCls = "flex items-center justify-between gap-4 border-b border-gray-100 py-2 text-sm last:border-0 dark:border-gray-800";
  const labelCls = "text-gray-500 dark:text-gray-400";
  const valueCls = "text-right font-medium text-gray-800 dark:text-gray-100";

  if (loading) return <p className="text-sm text-gray-400">{t("loading")}</p>;
  if (error || !info) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
        <i className="ti ti-alert-circle text-gray-300 dark:text-gray-700" style={{ fontSize: "36px" }} />
        <p className="mt-3 text-sm text-gray-400">{t("info_load_error")}</p>
      </div>
    );
  }

  const manifest = info.manifest ?? {};
  const egressHosts = manifest.egress_allowlist ?? [];

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-4 flex items-center gap-2">
        <i className="ti ti-info-circle text-teal-600" style={{ fontSize: "20px" }} />
        <h2 className="text-lg font-semibold">{t("info_title")}</h2>
      </div>
      <div className="rounded-2xl border border-gray-200 p-4 dark:border-gray-800">
        {/* Localized description, not manifest.description from Core's API
            (that field is a single hardcoded English string, not translated
            — see de.json/en.json's info_description for the maintained,
            localized text instead). */}
        <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{t("info_description")}</p>
        <div className={rowCls}>
          <span className={labelCls}>{t("info_version")}</span>
          <span className={valueCls}>{info.version}</span>
        </div>
        {info.available_version && (
          <div className={rowCls}>
            <span className={labelCls}>{t("info_update_available")}</span>
            <span className={valueCls} style={{ color: "#d97706" }}>{info.available_version}</span>
          </div>
        )}
        <div className={rowCls}>
          <span className={labelCls}>{t("info_tier")}</span>
          <span className={valueCls}>{info.tier}</span>
        </div>
        {manifest.category && (
          <div className={rowCls}>
            <span className={labelCls}>{t("info_category")}</span>
            <span className={valueCls}>{manifest.category}</span>
          </div>
        )}
        {manifest.author && (
          <div className={rowCls}>
            <span className={labelCls}>{t("info_author")}</span>
            <span className={valueCls}>{manifest.author}</span>
          </div>
        )}
        {manifest.license && (
          <div className={rowCls}>
            <span className={labelCls}>{t("info_license")}</span>
            <span className={valueCls}>{manifest.license}</span>
          </div>
        )}
        <div className={rowCls}>
          <span className={labelCls}>{t("info_network_access_core")}</span>
          <span className={valueCls}>
            {egressHosts.length > 0 ? egressHosts.join(", ") : t("info_no_network_access")}
          </span>
        </div>
        {/* This module's own UI code makes no frontend (browser-side)
            network access of its own — verified: all fetch() calls in
            App.tsx go to same-origin /v1/modules/... (Core). The Tabler
            Icons stylesheet used by the "ti ti-*" icon classes throughout
            this file is loaded once, globally, by Core's own
            frontend/index.html (cdnjs.cloudflare.com) — that is Core's own
            network access, not something this module's manifest or egress
            config controls, so it is intentionally not listed here. */}
        <div className={rowCls}>
          <span className={labelCls}>{t("info_network_access_frontend")}</span>
          <span className={valueCls}>{t("info_no_network_access")}</span>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>{t("info_installed_at")}</span>
          <span className={valueCls}>{new Date(info.installed_at).toLocaleDateString()}</span>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>{t("info_updated_at")}</span>
          <span className={valueCls}>{new Date(info.updated_at).toLocaleDateString()}</span>
        </div>
      </div>
      {/* Fixed constant, not fetched from the registry: source_repo lives in
          the store/registry tables, not installed_modules, so GET
          /v1/modules/{name} doesn't return it. Adding a Core API field just
          for this one link wasn't worth it — the repo a module ships from
          essentially never changes once installed. */}
      <a
        href={MODULE_SOURCE_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 flex items-center justify-center gap-1.5 rounded-2xl border border-gray-200 p-3 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        <i className="ti ti-brand-github" style={{ fontSize: "16px" }} />
        {t("info_github_link")}
      </a>
    </div>
  );
}

// Fixed source repo URL for this module — see the comment above where it's
// used for why this isn't fetched from Core's API.
const MODULE_SOURCE_REPO_URL = "https://github.com/modulab-project/modulab-modules";

// ── Helpers ───────────────────────────────────────────────────────────────────

let _storageBase = "";
let _token = "";

function setStorageBase(apiBase: string, token: string) {
  _storageBase = apiBase.replace(/\/api\/?$/, "") + "/storage";
  _token = token;
}

function imageUrl(path: string): string {
  if (!path) return "";
  // New format: relative path stored in DB, e.g. "uploads/foo.jpg"
  // Old format: absolute server path, e.g. "/Users/.../storage/uploads/foo.jpg"
  // Detect old format by presence of "/storage/" and extract the relative part.
  const storageIdx = path.indexOf("/storage/");
  const rel = storageIdx !== -1 ? path.slice(storageIdx + 9) : path;
  return `${_storageBase}/${rel}?t=${encodeURIComponent(_token)}`;
}
