/**
 * Recipes module — React frontend
 *
 * This component is built to ui/bundle.js and loaded dynamically by
 * ModulePage.tsx in modulab-core. It receives moduleName, apiBase, and token
 * as props, and handles all communication with the Deno backend itself.
 *
 * Views:
 *   - RecipeList   (default)
 *   - RecipeDetail
 *   - RecipeEditor (create / edit)
 *   - MealPlan
 *   - CategoriesView
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
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
  kcal_per_serving: number | null;
  protein_g_per_serving: number | null;
  fat_g_per_serving: number | null;
  carbs_g_per_serving: number | null;
  tag_names: string[];
  updated_at: string;
}

interface Ingredient {
  id: string;
  position: number;
  name: string;
  amount: number | null;
  unit: string | null;
  kcal_per_100g: number | null;
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
  | { type: "import" }
  | { type: "categories" };

// ── API helper ────────────────────────────────────────────────────────────────

function useApi(apiBase: string, token: string) {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;

  const get = useCallback(
    async <T,>(path: string): Promise<T> => {
      const url = base + (path.startsWith("/") ? path : "/" + path);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
        throw new Error(txt || `HTTP ${r.status}`);
      }
      if (r.status === 204) return undefined as unknown as T;
      return r.json();
    },
    [apiBase, token],
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
        throw new Error(txt || `HTTP ${r.status}`);
      }
      return r.json();
    },
    [base, token],
  );

  return { get, mutate, upload };
}

// ── Root component ────────────────────────────────────────────────────────────

const NS = "mod_recipes";

export default function RecipesApp({ apiBase, token }: ModuleComponentProps) {
  const { t } = useTranslation(NS);
  const [view, setView] = useState<View>({ type: "list" });
  const api = useApi(apiBase, token);

  return (
    <div className="recipes-module">
      {/* Navigation bar — scrollable on mobile */}
      <div className="mb-4 flex items-center gap-1 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => setView({ type: "list" })}
          className={navCls(view.type === "list")}
        >
          <i className="ti ti-book-2 text-[14px]" /> {t("nav_recipes")}
        </button>
        <button
          type="button"
          onClick={() => setView({ type: "meal-plan" })}
          className={navCls(view.type === "meal-plan")}
        >
          <i className="ti ti-calendar-week text-[14px]" /> {t("nav_meal_plan")}
        </button>
        <button
          type="button"
          onClick={() => setView({ type: "import" })}
          className={navCls(view.type === "import")}
        >
          <i className="ti ti-link text-[14px]" /> {t("nav_import")}
        </button>
        <button
          type="button"
          onClick={() => setView({ type: "categories" })}
          className={navCls(view.type === "categories")}
        >
          <i className="ti ti-tag text-[14px]" /> {t("nav_categories")}
        </button>
        <div className="flex-1 min-w-[8px]" />
        <button
          type="button"
          onClick={() => setView({ type: "editor" })}
          className="flex flex-none items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
        >
          <i className="ti ti-plus text-[14px]" /> <span className="hidden sm:inline">{t("btn_new_recipe")}</span><span className="sm:hidden">{t("btn_new")}</span>
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
      {view.type === "import" && (
        <UrlImport api={api} onImported={(id) => setView({ type: "editor", id })} />
      )}
      {view.type === "categories" && <CategoriesView api={api} />}
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
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories).catch(() => {});
  }, [api]);

  // Separate load function that explicitly takes the current filter values
  // to avoid stale-closure issues with useCallback deps
  const load = useCallback(
    async (searchVal: string, catVal: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (searchVal) params.set("search", searchVal);
        if (catVal) params.set("category", catVal);
        const qs = params.toString();
        const res = await api.get<{ recipes: Recipe[]; total: number }>(
          `/recipes${qs ? "?" + qs : ""}`,
        );
        setRecipes(res.recipes ?? []);
        setTotal(res.total ?? 0);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    load(search, categoryId);
  }, [load, search, categoryId]);

  return (
    <div>
      {/* Filters — stacked on mobile, row on larger screens */}
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
              {r.category_name && (
                <span className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  {r.category_name}
                </span>
              )}
            </div>
            <div className="mt-auto flex items-center gap-3 text-xs text-gray-400">
              {r.prep_time_min != null && (
                <span><i className="ti ti-clock text-[12px]" /> {t("total_time", { min: r.prep_time_min })}</span>
              )}
              {r.kcal_per_serving != null && (
                <span><i className="ti ti-flame text-[12px]" /> {Math.round(r.kcal_per_serving)} {t("kcal")}</span>
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
  const [nutrition, setNutrition] = useState<{ kcal: number; protein: number; fat: number; carbs: number } | null>(null);
  const [servings, setServings] = useState(4);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Recipe & { ingredients: Ingredient[]; steps: Step[]; tags: Tag[] }>(`/recipes/${id}`)
      .then((r) => {
        setRecipe(r);
        setServings(r.servings);
      })
      .finally(() => setLoading(false));
  }, [api, id]);

  useEffect(() => {
    if (!recipe) return;
    api
      .get<{ available: boolean; kcal?: number; protein?: number; fat?: number; carbs?: number }>(
        `/recipes/${id}/nutrition?servings=${servings}`,
      )
      .then((n) => {
        if (n.available) setNutrition({ kcal: n.kcal!, protein: n.protein!, fat: n.fat!, carbs: n.carbs! });
        else setNutrition(null);
      })
      .catch(() => {});
  }, [api, id, recipe, servings]);

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
          {recipe.category_name && (
            <span className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
              {recipe.category_name}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onEdit(id)}
          className="flex flex-none items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          <i className="ti ti-pencil text-[14px]" /> {t("edit")}
        </button>
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

      {/* Portion adjuster + nutrition */}
      <div className="mb-5 rounded-2xl border border-gray-200 p-4 dark:border-gray-800">
        <div className="mb-3 flex items-center gap-3">
          <span className="text-sm font-medium">{t("servings")}:</span>
          <button type="button" onClick={() => setServings(Math.max(1, servings - 1))}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 text-sm hover:bg-gray-50 dark:border-gray-700">−</button>
          <span className="w-6 text-center text-sm font-semibold">{servings}</span>
          <button type="button" onClick={() => setServings(servings + 1)}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 text-sm hover:bg-gray-50 dark:border-gray-700">+</button>
        </div>
        {nutrition && (
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            {[
              { label: t("kcal"), val: Math.round(nutrition.kcal) },
              { label: t("protein"), val: `${nutrition.protein.toFixed(1)}g` },
              { label: t("fat"), val: `${nutrition.fat.toFixed(1)}g` },
              { label: t("carbs"), val: `${nutrition.carbs.toFixed(1)}g` },
            ].map(({ label, val }) => (
              <div key={label} className="rounded-xl bg-gray-50 py-2 dark:bg-gray-900">
                <div className="font-semibold text-gray-800 dark:text-gray-200">{val}</div>
                <div className="text-gray-400">{label}</div>
              </div>
            ))}
          </div>
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

      {recipe.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {recipe.tags.map((tag) => (
            <span key={tag.id} className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs text-teal-700 dark:bg-teal-950 dark:text-teal-300">
              #{tag.name}
            </span>
          ))}
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
  const [savedRecipeId, setSavedRecipeId] = useState<string | null>(id ?? null);

  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories).catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!id) return;
    api
      .get<Recipe & { ingredients: Ingredient[]; steps: Step[] }>(`/recipes/${id}`)
      .then((r) => {
        setTitle(r.title);
        setDescription(r.description ?? "");
        setCategoryId(r.category_id ?? "");
        setServings(r.servings);
        setPrepTime(r.prep_time_min?.toString() ?? "");
        setCookTime(r.cook_time_min?.toString() ?? "");
        setNotes(r.notes ?? "");
        if (r.image_path) setImagePreview(imageUrl(r.image_path));
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
      } else {
        const created = await api.mutate<{ id: string }>("POST", "/recipes", body);
        recipeId = created.id;
        setSavedRecipeId(recipeId);
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

      onDone(recipeId);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleImageUpload(file: File) {
    // Must have a recipe ID to attach image. Save first if new.
    let recipeId = savedRecipeId;
    if (!recipeId) {
      if (!title.trim()) { setError(t("title_required_for_image")); return; }
      setSaving(true);
      try {
        const created = await api.mutate<{ id: string }>("POST", "/recipes", {
          title: title.trim(),
          description: description.trim(),
          category_id: categoryId || null,
          servings,
          notes: notes.trim() || null,
        });
        recipeId = created.id;
        setSavedRecipeId(recipeId);
      } catch (e) {
        setError(String(e));
        setSaving(false);
        return;
      } finally {
        setSaving(false);
      }
    }

    setImageUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file); // Go router expects "file" field name
      const res = await api.upload<{ image_path: string }>(`/recipes/${recipeId}/image`, fd);
      setImagePreview(imageUrl(res.image_path));
    } catch (e) {
      setError(String(e));
    } finally {
      setImageUploading(false);
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
        {/* Image upload */}
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
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-lg bg-black/60 px-3 py-1.5 text-xs font-medium text-white hover:bg-black/80"
              >
                {imageUploading
                  ? <><i className="ti ti-loader-2 animate-spin text-[12px]" /> {t("uploading")}</>
                  : <><i className="ti ti-camera text-[12px]" /> {t("change_image")}</>
                }
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={imageUploading}
              className="flex h-32 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 text-sm text-gray-400 hover:border-teal-400 hover:text-teal-600 dark:border-gray-700 disabled:opacity-50"
            >
              {imageUploading
                ? <><i className="ti ti-loader-2 animate-spin text-[18px]" /> {t("uploading")}</>
                : <><i className="ti ti-photo text-[24px]" /><br />{t("upload_image")}</>
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
        {/* Category + Servings — 2 cols on all screens (fields short enough) */}
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

        {/* Ingredients */}
        <div>
          <label className={labelCls}>{t("ingredients")}</label>
          <div className="space-y-2">
            {ingredients.map((ing, i) => (
              <div key={i} className="flex gap-2">
                <input type="number" step="0.1" min={0} placeholder={t("amount_placeholder")}
                  value={ing.amount} onChange={(e) => { const n = [...ingredients]; n[i].amount = e.target.value; setIngredients(n); }}
                  className="w-16 rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" style={{ fontSize: "16px" }} />
                <input type="text" placeholder={t("unit_placeholder")}
                  value={ing.unit} onChange={(e) => { const n = [...ingredients]; n[i].unit = e.target.value; setIngredients(n); }}
                  className="w-16 rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" style={{ fontSize: "16px" }} />
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

function MealPlanView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [weekOffset, setWeekOffset] = useState(0);
  const weekStart = mondayOfWeek(weekOffset);
  const [entries, setEntries] = useState<MealPlanEntry[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerCell, setPickerCell] = useState<{ day: number; slot: string } | null>(null);

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

  function entryFor(day: number, slot: string) {
    return entries.find((e) => e.day_of_week === day && e.meal_slot === slot);
  }

  async function setEntry(day: number, slot: string, recipeId: string | null) {
    const updated = await api.mutate<MealPlanEntry>(
      "PUT",
      `/meal-plan/${weekStart}/${day}/${slot}`,
      { recipe_id: recipeId },
    );
    setEntries((prev) => {
      const without = prev.filter((e) => !(e.day_of_week === day && e.meal_slot === slot));
      return [...without, updated];
    });
    setPickerCell(null);
  }

  async function clearEntry(day: number, slot: string) {
    await api.mutate("DELETE", `/meal-plan/${weekStart}/${day}/${slot}`);
    setEntries((prev) => prev.filter((e) => !(e.day_of_week === day && e.meal_slot === slot)));
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={() => setWeekOffset((o) => o - 1)}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
          <i className="ti ti-chevron-left" />
        </button>
        <span className="text-sm font-medium">{t("meal_plan_week", { date: weekStart })}</span>
        <button type="button" onClick={() => setWeekOffset((o) => o + 1)}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
          <i className="ti ti-chevron-right" />
        </button>
        <button type="button" onClick={() => setWeekOffset(0)}
          className="text-xs text-teal-600 hover:underline">{t("this_week")}</button>
      </div>

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[500px] border-collapse text-sm">
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
                      <div
                        className={`min-h-[48px] cursor-pointer rounded-xl border p-1.5 text-center text-xs transition ${
                          entry
                            ? "border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200"
                            : "border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
                        }`}
                        onClick={() => setPickerCell(isOpen ? null : { day, slot })}
                      >
                        {entry?.recipe_title ?? <span className="text-gray-300 dark:text-gray-700">+</span>}
                      </div>
                      {isOpen && (
                        <div className="absolute left-0 top-full z-10 mt-1 min-w-[180px] rounded-xl border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                          {entry && (
                            <button type="button" onClick={() => clearEntry(day, slot)}
                              className="mb-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
                              <i className="ti ti-trash text-[12px]" /> {t("clear")}
                            </button>
                          )}
                          {recipes.slice(0, 20).map((r) => (
                            <button key={r.id} type="button" onClick={() => setEntry(day, slot, r.id)}
                              className="flex w-full items-center rounded-lg px-2 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800">
                              {r.title}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── UrlImport ─────────────────────────────────────────────────────────────────

function UrlImport({
  api,
  onImported,
}: {
  api: ReturnType<typeof useApi>;
  onImported: (id: string) => void;
}) {
  const { t } = useTranslation(NS);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleImport() {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { draft } = await api.mutate<{ draft: { title: string }; source_url: string }>(
        "POST", "/import/url", { url: url.trim() },
      );
      const created = await api.mutate<{ id: string }>("POST", "/recipes", {
        title: draft.title || t("imported_recipe_title"),
        source_url: url.trim(),
      });
      onImported(created.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-4 text-lg font-semibold">{t("import_title")}</h2>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t("import_description")}</p>
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("import_placeholder")}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
          onKeyDown={(e) => e.key === "Enter" && handleImport()}
        />
        <button
          type="button"
          onClick={handleImport}
          disabled={loading || !url.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {loading ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-download text-[13px]" />}
          {loading ? t("importing") : t("import_btn")}
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
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
  const [sortOrder, setSortOrder] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<Category[]>("/categories");
      setCategories(rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  function startNew() {
    setEditingId("new");
    setName("");
    setSortOrder("0");
    setError(null);
  }

  function startEdit(cat: Category) {
    setEditingId(cat.id);
    setName(cat.name);
    setSortOrder(String(cat.sort_order));
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
  }

  async function handleSave() {
    if (!name.trim()) { setError(t("category_name_required")); return; }
    setSaving(true);
    setError(null);
    try {
      if (editingId === "new") {
        await api.mutate("POST", "/categories", { name: name.trim(), sort_order: parseInt(sortOrder) || 0 });
      } else {
        await api.mutate("PATCH", `/categories/${editingId}`, { name: name.trim(), sort_order: parseInt(sortOrder) || 0 });
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
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("category_name_placeholder")}
              className={`flex-1 ${inputCls}`}
              style={{ fontSize: "16px" }}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") cancelEdit(); }}
            />
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              title={t("category_sort_order")}
              placeholder="0"
              className={`w-20 ${inputCls}`}
              style={{ fontSize: "16px" }}
            />
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
            <span className="text-xs text-gray-400">{cat.sort_order}</span>
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function imageUrl(path: string): string {
  // path is stored as absolute storage path like /home/user/.../storage/abc.jpg
  // The core serves module storage at /modules/{name}/storage/...
  // Extract everything after /storage/
  const idx = path.indexOf("/storage/");
  if (idx === -1) return path;
  return `/modules/recipes/storage/${path.slice(idx + 9)}`;
}
