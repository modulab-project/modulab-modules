/**
 * Pantry module — React frontend  v0.2.0
 *
 * Visual/structural pattern deliberately mirrors recipes/ui/src/App.tsx
 * (2026-07-18 user request: "same look as recipes' AI integration") -
 * the sparkles-icon AI action button, the Admin-only Settings tab
 * (AISettingsView), the ModuleInfoView "Info" tab, the useApi/
 * extractErrorMessage helpers, and the isAdmin visibility-probe pattern are
 * all carried over near-verbatim.
 *
 * v0.2.0 changes (2026-07-18, user feedback round):
 *  - Item/batch split: pantry_items is now a product record (name/category/
 *    unit/min_stock/notes), quantity+expiry_date+location live on a
 *    per-item batches array instead - "buy steaks twice with two different
 *    best-before dates" no longer creates two separate list rows. See
 *    handlers/index.ts and migrations/0001_initial.sql for the backend side.
 *  - Locations are now an admin-managed list (LocationsView), same pattern
 *    as Categories, instead of a free-text field.
 *  - No seeded categories - the list starts empty.
 *  - Units offered in the datalist are translated per-locale (see UNIT_CODES
 *    below) instead of hardcoded English abbreviations.
 *  - The "Scan receipt" tab only shows once at least one AI provider is
 *    configured and enabled (probes the new, non-admin-gated
 *    GET /ai-providers/status).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import type { ModuleComponentProps } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PantryItem {
  id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  unit: string | null;
  min_stock: number | null;
  notes: string | null;
  image_path: string | null;
  quantity: number; // aggregated SUM across this item's batches
  expiry_date: string | null; // nearest (soonest) expiry_date across batches
  batch_count: number;
  added_via_ai_scan: boolean; // true if any batch was added via AI scan
  is_low_stock: boolean;
  is_expired: boolean;
  days_until_expiry: number | null;
  updated_at: string;
}

interface Batch {
  id: string;
  item_id: string;
  quantity: number;
  expiry_date: string | null;
  location_id: string | null;
  location_name: string | null;
  added_via: "manual" | "ai_scan";
  created_at: string;
  updated_at: string;
}

interface PantryItemDetail extends PantryItem {
  batches: Batch[];
}

interface Category {
  id: string;
  name: string;
  sort_order: number;
}

interface Location {
  id: string;
  name: string;
  sort_order: number;
}

interface ScannedItem {
  name: string;
  quantity: number | null;
  unit: string | null;
  category: string | null;
}

type View =
  | { type: "list" }
  | { type: "editor"; id?: string }
  | { type: "scan" }
  | { type: "categories" }
  | { type: "locations" }
  | { type: "settings" }
  | { type: "info" };

// Unit suggestions, translated per-locale (2026-07-18 user request: "pcs"
// should read "Stk" for a German user, not stay in English). The datalist's
// option value IS the translated abbreviation - the field itself stays free
// text underneath, so a custom unit can always be typed instead.
const UNIT_CODES = ["pcs", "kg", "g", "l", "ml", "pack", "can", "bottle"] as const;

// ── API helper ────────────────────────────────────────────────────────────────
//
// Identical to recipes/ui/src/App.tsx's useApi/extractErrorMessage - Cloudflare
// or Traefik can fail a request without ever reaching Core's Go handler (e.g. a
// bare HTML 502 page), which is unreadable dumped raw into the UI.

function extractErrorMessage(status: number, txt: string): string {
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(txt);
  if (looksLikeHtml || !txt.trim()) {
    return i18next.t(`${NS}:error_server`, { status }) as string;
  }
  // 2026-07-19 ("nichts festes alles über locales") - the backend now sends
  // a stable { error_code, params? } body instead of a hardcoded English
  // sentence (see handlers/index.ts's errorResponse). Translate it through
  // this module's own locale files; anything that doesn't parse into this
  // shape (an older/unexpected response, or a bare-text error from
  // something in front of Core entirely) falls through to the raw text
  // exactly as before - never a hard failure just because a message
  // couldn't be localized.
  try {
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object" && typeof parsed.error_code === "string") {
      const key = `${NS}:error_${parsed.error_code}`;
      const translated = i18next.t(key, parsed.params ?? {});
      if (translated !== key) return translated as string;
    }
  } catch {
    // not JSON - fall through to raw text below
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

const NS = "mod_pantry";

export default function PantryApp({ moduleName, apiBase, token }: ModuleComponentProps) {
  const { t } = useTranslation(NS);
  const [view, setView] = useState<View>({ type: "list" });
  const api = useApi(apiBase, token);

  // isAdmin: same client-side visibility probe as recipes - the Settings tab
  // (AI provider API keys) must be fully hidden from non-Admins, not just
  // have its mutating actions rejected server-side. null = not yet known.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    api.get("/ai-providers").then(() => setIsAdmin(true)).catch(() => setIsAdmin(false));
  }, [api]);
  useEffect(() => {
    if (view.type === "settings" && isAdmin === false) setView({ type: "list" });
  }, [view, isAdmin]);

  // scanAvailable: whether any AI provider is configured+enabled, probed via
  // the non-admin-gated /ai-providers/status - unlike isAdmin above, this
  // gates a tab every user (not just Admins) would otherwise see, so it
  // can't reuse the admin-only /ai-providers probe. null = not yet known,
  // treated as "hidden" the same conservative way isAdmin is.
  const [scanAvailable, setScanAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    api.get<{ available: boolean }>("/ai-providers/status").then((r) => setScanAvailable(r.available)).catch(() => setScanAvailable(false));
  }, [api]);
  useEffect(() => {
    if (view.type === "scan" && scanAvailable === false) setView({ type: "list" });
  }, [view, scanAvailable]);

  return (
    <div className="p-4 sm:p-6">
      {/* Navigation bar — exact layout of recipes/ui/src/App.tsx's nav
          (2026-07-18 user request): scrollable row of icon-only tabs
          (tooltip via title), a flex-1 spacer pushing Info to the right,
          then the primary "+ New" action always rightmost - reachable from
          every view, not just the Items list, same as recipes' "+ New
          Recipe" button. */}
      <div className="mb-4 flex items-center gap-1 overflow-x-auto pb-1">
        <button type="button" onClick={() => setView({ type: "list" })} className={navCls(view.type === "list")} title={t("nav_items") as string}>
          <i className="ti ti-shopping-cart text-[15px]" />
        </button>
        {scanAvailable && (
          <button type="button" onClick={() => setView({ type: "scan" })} className={navCls(view.type === "scan")} title={t("nav_scan") as string}>
            <i className="ti ti-camera text-[15px]" />
          </button>
        )}
        <button type="button" onClick={() => setView({ type: "categories" })} className={navCls(view.type === "categories")} title={t("nav_categories") as string}>
          <i className="ti ti-tag text-[15px]" />
        </button>
        <button type="button" onClick={() => setView({ type: "locations" })} className={navCls(view.type === "locations")} title={t("nav_locations") as string}>
          <i className="ti ti-map-pin text-[15px]" />
        </button>
        {isAdmin && (
          <button type="button" onClick={() => setView({ type: "settings" })} className={navCls(view.type === "settings")} title={t("nav_settings") as string}>
            <i className="ti ti-settings text-[15px]" />
          </button>
        )}
        <div className="flex-1" style={{ minWidth: "4px" }} />
        <button type="button" onClick={() => setView({ type: "info" })} className={navCls(view.type === "info")} title={t("nav_info") as string}>
          <i className="ti ti-info-circle text-[15px]" />
        </button>
        <button
          type="button"
          onClick={() => setView({ type: "editor" })}
          className="flex flex-none items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
          title={t("btn_new_item") as string}
        >
          <i className="ti ti-plus" style={{ fontSize: "14px" }} />
          <span className="hidden sm:inline">{t("btn_new_item")}</span>
        </button>
      </div>

      {view.type === "list" && (
        <ItemList
          api={api}
          onEdit={(id) => setView({ type: "editor", id })}
        />
      )}
      {view.type === "editor" && (
        <ItemEditor api={api} id={view.id} onDone={() => setView({ type: "list" })} onBack={() => setView({ type: "list" })} />
      )}
      {view.type === "scan" && scanAvailable && <ScanView api={api} onDone={() => setView({ type: "list" })} />}
      {view.type === "categories" && <CategoriesView api={api} />}
      {view.type === "locations" && <LocationsView api={api} />}
      {view.type === "settings" && isAdmin && <AISettingsView api={api} />}
      {view.type === "info" && <ModuleInfoView moduleName={moduleName} token={token} />}
    </div>
  );
}

// Identical to recipes/ui/src/App.tsx's navCls (same px-3 py-1.5 padding,
// same whitespace-nowrap/transition classes) - only the visible <span> text
// label is omitted here, the button's own spacing is untouched so the
// active-tab box and gaps between icons match recipes exactly.
function navCls(active: boolean) {
  return `flex flex-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
    active
      ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
      : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
  }`;
}

// ── ItemList ──────────────────────────────────────────────────────────────────

function ItemList({
  api,
  onEdit,
}: {
  api: ReturnType<typeof useApi>;
  onEdit: (id: string) => void;
}) {
  const { t } = useTranslation(NS);
  const [items, setItems] = useState<PantryItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [expiringSoonOnly, setExpiringSoonOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (categoryFilter) params.set("category", categoryFilter);
      if (locationFilter) params.set("location", locationFilter);
      if (lowStockOnly) params.set("low_stock", "true");
      if (expiringSoonOnly) params.set("expiring_soon", "true");
      const [itemsResp, cats, locs] = await Promise.all([
        api.get<{ items: PantryItem[]; total: number }>(`/items?${params.toString()}`),
        api.get<Category[]>("/categories"),
        api.get<Location[]>("/locations"),
      ]);
      setItems(itemsResp.items);
      setCategories(cats);
      setLocations(locs);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [api, search, categoryFilter, locationFilter, lowStockOnly, expiringSoonOnly]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0); // debounce free-text search only
    return () => clearTimeout(timer);
  }, [load, search]);

  async function handleDelete(id: string) {
    if (!window.confirm(t("item_delete_confirm"))) return;
    try {
      await api.mutate("DELETE", `/items/${id}`);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  // "Wie entnehme ich einen Artikel aus dem Bestand?" (2026-07-19) - one tap
  // takes 1 unit out via FEFO (POST /items/:id/consume), no batch-picking
  // required. For removing more than 1 at once, or from a specific batch,
  // the item editor's batch list still supports editing/deleting by hand.
  async function handleConsume(id: string) {
    try {
      await api.mutate("POST", `/items/${id}/consume`, { quantity: 1 });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  const lowStockCount = items.filter((i) => i.is_low_stock).length;
  const expiringCount = items.filter((i) => i.days_until_expiry != null && i.days_until_expiry <= 3).length;

  return (
    <div className="mx-auto max-w-3xl">
      {/* No local "new item" button here anymore - the + in the top nav
          (2026-07-18 user request) is reachable from every view, not just
          this list, so it replaces this one. */}
      <h1 className="mb-4 text-lg font-semibold">{t("nav_items")}</h1>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <MetricCard label={t("metric_total")} value={items.length} />
        <MetricCard label={t("metric_expiring")} value={expiringCount} tone="warning" />
        <MetricCard label={t("metric_low_stock")} value={lowStockCount} tone="danger" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("search_placeholder")}
          className="flex-1 min-w-[160px] rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
        >
          <option value="">{t("all_categories")}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
        >
          <option value="">{t("all_locations")}</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </div>

      {/* Low-stock/expiring-soon toggles on their own row (2026-07-18 user
          request), separate from the search/category/location row above. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setLowStockOnly((v) => !v)}
          className={`rounded-lg border px-3 py-1.5 text-sm ${
            lowStockOnly ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
                         : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
          }`}
        >
          {t("filter_low_stock")}
        </button>
        <button
          type="button"
          onClick={() => setExpiringSoonOnly((v) => !v)}
          className={`rounded-lg border px-3 py-1.5 text-sm ${
            expiringSoonOnly ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                              : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
          }`}
        >
          {t("filter_expiring_soon")}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      {!loading && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-10 text-center dark:border-gray-800">
          <i className="ti ti-shopping-cart text-[32px] text-gray-300 dark:text-gray-700" />
          <p className="mt-2 text-sm text-gray-400">{t("no_items")}</p>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-100 px-4 py-3 last:border-b-0 dark:border-gray-800"
          >
            {/* Name/category block: full row width on narrow screens
                (basis-full) so everything below always wraps onto its own
                line instead of being squeezed or clipped off - the mobile
                layout bug reported 2026-07-19 ("auf einem mobile device
                passt nichts", "ich finde nicht die Funktion wenn ich etwas
                entnehme"): this row used to be a single non-wrapping flex
                line, so on a narrow screen the quantity/consume/badges/edit/
                delete controls either got squeezed unreadably or clipped
                outside the list's rounded (overflow-hidden) container
                entirely - not just illegible, actually inaccessible. */}
            <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto sm:flex-1">
              <i className="ti ti-package flex-none text-[18px] text-gray-400" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  {item.added_via_ai_scan && (
                    <i className="ti ti-sparkles flex-none text-[12px] text-teal-500" title={t("added_via_ai_scan") as string} />
                  )}
                </div>
                <p className="truncate text-xs text-gray-400">
                  {item.category_name ?? t("uncategorized")}
                  {item.batch_count > 1 && ` · ${t("batch_count", { count: item.batch_count })}`}
                </p>
              </div>
            </div>

            {/* Actions block wraps as its own unit onto a new line on
                mobile, never gets clipped - quantity and the "-1" consume
                button are grouped into one pill so it reads as "take one of
                this quantity out" rather than a lone, easy-to-miss icon
                floating among other icon buttons. */}
            <div className="ml-auto flex flex-wrap items-center gap-2 sm:ml-0">
              <div className="flex flex-none items-center gap-1 rounded-lg bg-gray-50 py-1 pl-2.5 pr-1 dark:bg-gray-800">
                <span className="text-sm text-gray-600 dark:text-gray-300">{formatQty(item.quantity)} {item.unit ?? ""}</span>
                <button type="button" onClick={() => handleConsume(item.id)} disabled={item.quantity <= 0}
                  title={t("consume_one") as string}
                  className="flex-none rounded-lg p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 disabled:opacity-30 dark:hover:bg-gray-700">
                  <i className="ti ti-minus text-[14px]" />
                </button>
              </div>
              {item.is_expired ? (
                <Badge tone="danger">{t("badge_expired")}</Badge>
              ) : item.days_until_expiry != null && item.days_until_expiry <= 3 ? (
                <Badge tone="warning">{t("badge_expiring_in", { count: item.days_until_expiry })}</Badge>
              ) : item.expiry_date ? (
                <Badge tone="neutral">{t("badge_expiry_date", { date: item.expiry_date })}</Badge>
              ) : null}
              {item.is_low_stock && <Badge tone="danger">{t("badge_low_stock")}</Badge>}
              <button type="button" onClick={() => onEdit(item.id)}
                className="flex-none rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
                <i className="ti ti-pencil text-[14px]" />
              </button>
              <button type="button" onClick={() => handleDelete(item.id)}
                className="flex-none rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
                <i className="ti ti-trash text-[14px]" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Defensive display formatting for quantity/min_stock (2026-07-19 bug
// report: "80" was showing as "80.000 Stück"). The backend now converts its
// NUMERIC(10,3) columns to real JS numbers before sending them (see
// handlers/index.ts's num()), but this still guards against a raw numeric
// string slipping through and formats away any trailing ".000"/".50" noise
// that Number()'s default toString wouldn't otherwise add back in.
function formatQty(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "";
  return String(Math.round(n * 1000) / 1000);
}

function MetricCard({ label, value, tone }: { label: string; value: number; tone?: "warning" | "danger" }) {
  const valueColor =
    tone === "danger" ? "text-red-600 dark:text-red-400" : tone === "warning" ? "text-amber-600 dark:text-amber-400" : "";
  return (
    <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-xl font-semibold ${valueColor}`}>{value}</p>
    </div>
  );
}

function Badge({ tone, children }: { tone: "neutral" | "warning" | "danger"; children: React.ReactNode }) {
  const cls =
    tone === "danger"
      ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
      : tone === "warning"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
        : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400";
  return <span className={`flex-none whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

// ── ItemEditor ────────────────────────────────────────────────────────────────
//
// Edits item-level fields (name/category/unit/min_stock/notes) plus the
// item's batches (quantity/expiry_date/location) inline - same "embedded
// list, replaced/added row by row" pattern as recipes' ingredients editor,
// except batches are individually addressable (POST/PATCH/DELETE) rather
// than a wholesale PUT-replace-all, since a batch can outlive edits to the
// item itself and vice versa.
//
// For a brand-new item, exactly one blank batch row is offered by default -
// matches the old single-table UX where "new item" always meant "some stock
// of a new product," while still letting the user delete it down to zero
// batches (a bare product definition with nothing in stock yet is valid).

function ItemEditor({
  api,
  id,
  onDone,
  onBack,
}: {
  api: ReturnType<typeof useApi>;
  id?: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation(NS);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [unit, setUnit] = useState("");
  const [minStock, setMinStock] = useState("");
  const [notes, setNotes] = useState("");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [newBatches, setNewBatches] = useState<{ quantity: string; expiry_date: string; location_id: string }[]>(
    id ? [] : [{ quantity: "1", expiry_date: "", location_id: "" }],
  );
  const [loading, setLoading] = useState(!!id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories).catch(() => {});
    api.get<Location[]>("/locations").then(setLocations).catch(() => {});
  }, [api]);

  const reloadItem = useCallback(async () => {
    if (!id) return;
    const it = await api.get<PantryItemDetail>(`/items/${id}`);
    setName(it.name);
    setCategoryId(it.category_id ?? "");
    setUnit(it.unit ?? "");
    setMinStock(it.min_stock != null ? formatQty(it.min_stock) : "");
    setNotes(it.notes ?? "");
    setBatches(it.batches);
  }, [api, id]);

  useEffect(() => {
    if (!id) return;
    reloadItem().catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, [id, reloadItem]);

  async function handleSave() {
    if (!name.trim()) { setError(t("name_required")); return; }
    setSaving(true);
    setError(null);
    try {
      if (id) {
        await api.mutate("PATCH", `/items/${id}`, {
          name: name.trim(),
          category_id: categoryId || null,
          unit: unit.trim() || null,
          min_stock: minStock.trim() ? parseFloat(minStock) : null,
          notes: notes.trim() || null,
        });
        onDone();
      } else {
        const validBatches = newBatches.filter((b) => b.quantity.trim() || b.expiry_date || b.location_id);
        const created = await api.mutate<{ id: string }>("POST", "/items", {
          name: name.trim(),
          category_id: categoryId || null,
          unit: unit.trim() || null,
          min_stock: minStock.trim() ? parseFloat(minStock) : null,
          notes: notes.trim() || null,
          batch: validBatches[0]
            ? {
                quantity: parseFloat(validBatches[0].quantity) || 0,
                expiry_date: validBatches[0].expiry_date || null,
                location_id: validBatches[0].location_id || null,
              }
            : undefined,
        });
        // Any additional new-item batch rows beyond the first (rare, but the
        // form allows adding more before the first save) are created as
        // separate POST /items/:id/batches calls once the item itself exists.
        for (const b of validBatches.slice(1)) {
          await api.mutate("POST", `/items/${created.id}/batches`, {
            quantity: parseFloat(b.quantity) || 0,
            expiry_date: b.expiry_date || null,
            location_id: b.location_id || null,
          });
        }
        onDone();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function addNewBatchRow() {
    setNewBatches((prev) => [...prev, { quantity: "1", expiry_date: "", location_id: "" }]);
  }
  function updateNewBatchRow(i: number, patch: Partial<{ quantity: string; expiry_date: string; location_id: string }>) {
    setNewBatches((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }
  function removeNewBatchRow(i: number) {
    setNewBatches((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleAddBatch() {
    if (!id) return;
    try {
      await api.mutate("POST", `/items/${id}/batches`, { quantity: 1, expiry_date: null, location_id: null });
      await reloadItem();
    } catch (e) {
      setError(String(e));
    }
  }
  async function handleUpdateBatch(batchId: string, patch: Partial<{ quantity: number; expiry_date: string | null; location_id: string | null }>) {
    try {
      await api.mutate("PATCH", `/items/${id}/batches/${batchId}`, patch);
      await reloadItem();
    } catch (e) {
      setError(String(e));
    }
  }
  async function handleDeleteBatch(batchId: string) {
    try {
      await api.mutate("DELETE", `/items/${id}/batches/${batchId}`);
      await reloadItem();
    } catch (e) {
      setError(String(e));
    }
  }

  const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";
  const smallInputCls = "rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";

  if (loading) return <p className="text-sm text-gray-400">{t("loading")}</p>;

  return (
    <div className="mx-auto max-w-lg">
      <button type="button" onClick={onBack}
        className="mb-4 flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
        <i className="ti ti-arrow-left text-[14px]" /> {t("back")}
      </button>

      <h1 className="mb-4 text-lg font-semibold">{id ? t("edit_item") : t("new_item")}</h1>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_name")}</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} style={{ fontSize: "16px" }} autoFocus />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_category")}</label>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputCls} style={{ fontSize: "16px" }}>
              <option value="">{t("uncategorized")}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_unit")}</label>
            <input type="text" list="pantry-units" value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls} style={{ fontSize: "16px" }} />
            <datalist id="pantry-units">{UNIT_CODES.map((u) => <option key={u} value={t(`unit_${u}`)} />)}</datalist>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_min_stock")}</label>
          <input type="number" min={0} step="0.01" value={minStock} onChange={(e) => setMinStock(e.target.value)} placeholder={t("field_min_stock_placeholder") as string} className={inputCls} style={{ fontSize: "16px" }} />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_notes")}</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} style={{ fontSize: "16px" }} />
        </div>
      </div>

      <div className="mt-5 border-t border-gray-100 pt-4 dark:border-gray-800">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("batches_title")}</h2>
          {id && (
            <button type="button" onClick={handleAddBatch}
              className="flex items-center gap-1 text-xs text-teal-600 hover:underline dark:text-teal-400">
              <i className="ti ti-plus text-[12px]" /> {t("add_batch")}
            </button>
          )}
        </div>

        {/* Existing item: batches are saved immediately, one API call per field change. */}
        {id && batches.length === 0 && (
          <p className="text-xs text-gray-400">{t("no_batches")}</p>
        )}
        {id && batches.map((b) => (
          <div key={b.id} className="mb-2 flex items-center gap-2">
            <input type="number" min={0} step="0.01" defaultValue={formatQty(b.quantity)}
              onBlur={(e) => handleUpdateBatch(b.id, { quantity: parseFloat(e.target.value) || 0 })}
              className={`w-20 ${smallInputCls}`} style={{ fontSize: "16px" }} />
            <input type="date" defaultValue={b.expiry_date ?? ""}
              onBlur={(e) => handleUpdateBatch(b.id, { expiry_date: e.target.value || null })}
              className={smallInputCls} style={{ fontSize: "16px" }} />
            <select defaultValue={b.location_id ?? ""}
              onChange={(e) => handleUpdateBatch(b.id, { location_id: e.target.value || null })}
              className={`flex-1 ${smallInputCls}`} style={{ fontSize: "16px" }}>
              <option value="">{t("no_location")}</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {b.added_via === "ai_scan" && <i className="ti ti-sparkles text-[12px] text-teal-500" title={t("added_via_ai_scan") as string} />}
            <button type="button" onClick={() => handleDeleteBatch(b.id)}
              className="flex-none rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
              <i className="ti ti-trash text-[14px]" />
            </button>
          </div>
        ))}

        {/* New item: batch rows are plain local state, sent along with the
            initial POST /items call (see handleSave) rather than saved
            immediately - there is no item id to attach them to yet. */}
        {!id && newBatches.map((b, i) => (
          <div key={i} className="mb-2 flex items-center gap-2">
            <input type="number" min={0} step="0.01" value={b.quantity} onChange={(e) => updateNewBatchRow(i, { quantity: e.target.value })}
              className={`w-20 ${smallInputCls}`} style={{ fontSize: "16px" }} />
            <input type="date" value={b.expiry_date} onChange={(e) => updateNewBatchRow(i, { expiry_date: e.target.value })}
              className={smallInputCls} style={{ fontSize: "16px" }} />
            <select value={b.location_id} onChange={(e) => updateNewBatchRow(i, { location_id: e.target.value })}
              className={`flex-1 ${smallInputCls}`} style={{ fontSize: "16px" }}>
              <option value="">{t("no_location")}</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button type="button" onClick={() => removeNewBatchRow(i)}
              className="flex-none rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
              <i className="ti ti-trash text-[14px]" />
            </button>
          </div>
        ))}
        {!id && (
          <button type="button" onClick={addNewBatchRow}
            className="flex items-center gap-1 text-xs text-teal-600 hover:underline dark:text-teal-400">
            <i className="ti ti-plus text-[12px]" /> {t("add_batch")}
          </button>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onBack} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
          {t("cancel")}
        </button>
        <button type="button" onClick={handleSave} disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
          {saving ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-check text-[13px]" />}
          {saving ? t("saving") : t("save")}
        </button>
      </div>
    </div>
  );
}

// ── ScanView ──────────────────────────────────────────────────────────────────
//
// Upload a receipt photo -> POST /scan (multipart; Core writes the file to
// this module's storage dir AND base64-encodes the same bytes into the JSON
// body it forwards, see router.go) -> AI returns suggested items -> user
// edits/removes rows -> POST /items/bulk to actually persist (matches by
// name server-side: adds a batch to an existing item, or creates a new one).
// Nothing is written to the database until the user confirms.

function ScanView({ api, onDone }: { api: ReturnType<typeof useApi>; onDone: () => void }) {
  const { t } = useTranslation(NS);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ScannedItem[] | null>(null);
  const [aiMeta, setAiMeta] = useState<{ provider: string; model: string } | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categoryChoices, setCategoryChoices] = useState<string[]>([]);
  const [locationChoices, setLocationChoices] = useState<string[]>([]);
  const [expiryChoices, setExpiryChoices] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Inline "create a new category" for a suggestion row (2026-07-19 - "wenn
  // es keine passende Kategorie gibt, wäre es gut wenn ich sie direkt beim
  // Artikel eintragen kann und danach direkt im Bon bei anderen Artikeln
  // auswählen kann"). Only one row can be in "creating" mode at a time.
  // Newly created categories are appended to `categories` (not refetched),
  // so every other row's dropdown offers it immediately without a round trip.
  const [newCategoryRowIndex, setNewCategoryRowIndex] = useState<number | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategorySaving, setNewCategorySaving] = useState(false);

  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories).catch(() => {});
    api.get<Location[]>("/locations").then(setLocations).catch(() => {});
  }, [api]);

  async function handleFile(file: File) {
    setScanning(true);
    setError(null);
    setSuggestions(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.upload<{ items: ScannedItem[]; ai_provider: string; ai_model: string }>("/scan", fd);
      setSuggestions(res.items);
      setAiMeta({ provider: res.ai_provider, model: res.ai_model });
      // Best-effort category match by name - the AI only returns a free-text
      // guess, so pre-select a real category where the name matches exactly,
      // leaving "uncategorized" for the user to pick otherwise.
      setCategoryChoices(
        res.items.map((it) => categories.find((c) => c.name.toLowerCase() === (it.category ?? "").toLowerCase())?.id ?? ""),
      );
      setLocationChoices(res.items.map(() => ""));
      // Left blank on purpose (2026-07-19) - a receipt never prints a
      // best-before date, and an AI shelf-life guess was tried and
      // explicitly rejected ("ich möchte das das MHD nicht geschätzt wird,
      // sondern das ich es vor dem Import eintragen kann") - the user enters
      // it by hand below, where they know it, before importing.
      setExpiryChoices(res.items.map(() => ""));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  function updateSuggestion(i: number, patch: Partial<ScannedItem>) {
    setSuggestions((prev) => (prev ? prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) : prev));
  }
  function removeSuggestion(i: number) {
    setSuggestions((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
    setCategoryChoices((prev) => prev.filter((_, idx) => idx !== i));
    setLocationChoices((prev) => prev.filter((_, idx) => idx !== i));
    setExpiryChoices((prev) => prev.filter((_, idx) => idx !== i));
  }

  function startNewCategory(i: number) {
    setNewCategoryRowIndex(i);
    setNewCategoryName("");
  }
  function cancelNewCategory() {
    setNewCategoryRowIndex(null);
    setNewCategoryName("");
  }
  async function confirmNewCategory() {
    if (newCategoryRowIndex === null || !newCategoryName.trim()) return;
    setNewCategorySaving(true);
    setError(null);
    try {
      const row = await api.mutate<Category>("POST", "/categories", { name: newCategoryName.trim() });
      // Appended locally (not refetched) so it's immediately selectable for
      // every other row in this same scan, not just the one it was created
      // from - the whole point of the request.
      setCategories((prev) => [...prev, row].sort((a, b) => a.name.localeCompare(b.name)));
      setCategoryChoices((prev) => prev.map((v, idx) => (idx === newCategoryRowIndex ? row.id : v)));
      cancelNewCategory();
    } catch (e) {
      setError(String(e));
    } finally {
      setNewCategorySaving(false);
    }
  }

  async function handleConfirm() {
    if (!suggestions || suggestions.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await api.mutate("POST", "/items/bulk", {
        items: suggestions.map((it, i) => ({
          name: it.name,
          category_id: categoryChoices[i] || null,
          location_id: locationChoices[i] || null,
          quantity: it.quantity ?? 1,
          unit: it.unit,
          expiry_date: expiryChoices[i] || null,
        })),
      });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-lg font-semibold">{t("scan_title")}</h1>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t("scan_description")}</p>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      {!suggestions && (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={scanning}
          className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 px-6 py-12 text-center hover:border-teal-300 disabled:opacity-50 dark:border-gray-800"
        >
          {scanning ? (
            <>
              <i className="ti ti-loader-2 animate-spin text-[28px] text-teal-600 dark:text-teal-400" />
              <span className="text-sm text-gray-500 dark:text-gray-400">{t("scan_in_progress")}</span>
            </>
          ) : (
            <>
              <i className="ti ti-camera text-[28px] text-gray-300 dark:text-gray-700" />
              <span className="text-sm font-medium text-teal-700 dark:text-teal-300">{t("scan_upload_prompt")}</span>
              <span className="text-xs text-gray-400">{t("scan_upload_hint")}</span>
            </>
          )}
        </button>
      )}

      {suggestions && (
        <>
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-teal-50 px-3 py-2 text-xs text-teal-700 dark:bg-teal-950 dark:text-teal-300">
            <i className="ti ti-sparkles text-[13px]" />
            {t("scan_result_meta", { provider: aiMeta?.provider, model: aiMeta?.model, count: suggestions.length })}
          </div>
          <p className="mb-3 text-xs text-gray-400">{t("scan_expiry_estimate_hint")}</p>

          <div className="space-y-2">
            {suggestions.map((it, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 p-2.5 dark:border-gray-800">
                <input type="text" value={it.name} onChange={(e) => updateSuggestion(i, { name: e.target.value })}
                  className={`flex-1 min-w-[100px] ${inputCls}`} style={{ fontSize: "16px" }} />
                <input type="number" min={0} step="0.01" value={it.quantity ?? ""} onChange={(e) => updateSuggestion(i, { quantity: parseFloat(e.target.value) || null })}
                  className={`w-16 ${inputCls}`} style={{ fontSize: "16px" }} />
                <input type="text" value={it.unit ?? ""} onChange={(e) => updateSuggestion(i, { unit: e.target.value })}
                  placeholder={t("field_unit") as string} className={`w-20 ${inputCls}`} style={{ fontSize: "16px" }} />
                {newCategoryRowIndex === i ? (
                  <div className="flex items-center gap-1">
                    <input type="text" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)}
                      placeholder={t("category_name_placeholder") as string} autoFocus
                      className={`w-24 ${inputCls}`} style={{ fontSize: "16px" }}
                      onKeyDown={(e) => { if (e.key === "Enter") confirmNewCategory(); if (e.key === "Escape") cancelNewCategory(); }} />
                    <button type="button" onClick={confirmNewCategory} disabled={newCategorySaving || !newCategoryName.trim()}
                      className="flex-none rounded-lg p-1.5 text-teal-600 hover:bg-teal-50 disabled:opacity-40 dark:hover:bg-teal-950">
                      {newCategorySaving ? <i className="ti ti-loader-2 animate-spin text-[14px]" /> : <i className="ti ti-check text-[14px]" />}
                    </button>
                    <button type="button" onClick={cancelNewCategory}
                      className="flex-none rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
                      <i className="ti ti-x text-[14px]" />
                    </button>
                  </div>
                ) : (
                  // "+ new category" option (2026-07-19 - "wenn es keine
                  // passende Kategorie gibt, wäre es gut wenn ich sie direkt
                  // beim Artikel eintragen kann"): picking it switches this
                  // row into the inline-create input above; once created,
                  // it's appended to `categories` so every other row's
                  // dropdown offers it right away too.
                  <select value={categoryChoices[i] ?? ""} onChange={(e) => {
                      if (e.target.value === "__new__") { startNewCategory(i); return; }
                      setCategoryChoices((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)));
                    }}
                    className={`w-28 ${inputCls}`} style={{ fontSize: "16px" }}>
                    <option value="">{it.category ?? t("uncategorized")}</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    <option value="__new__">+ {t("new_category")}</option>
                  </select>
                )}
                <select value={locationChoices[i] ?? ""} onChange={(e) => setLocationChoices((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                  className={`w-28 ${inputCls}`} style={{ fontSize: "16px" }}>
                  <option value="">{t("no_location")}</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <input type="date" value={expiryChoices[i] ?? ""}
                  onChange={(e) => setExpiryChoices((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                  title={t("field_expiry_date") as string}
                  className={inputCls} style={{ fontSize: "16px" }} />
                <button type="button" onClick={() => removeSuggestion(i)}
                  className="flex-none rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
                  <i className="ti ti-x text-[14px]" />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => { setSuggestions(null); setAiMeta(null); }}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
              {t("cancel")}
            </button>
            <button type="button" onClick={handleConfirm} disabled={saving || suggestions.length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
              {saving ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-check text-[13px]" />}
              {t("scan_confirm_add", { count: suggestions.length })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── CategoriesView ────────────────────────────────────────────────────────────

function CategoriesView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCategories(await api.get<Category[]>("/categories"));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  function startNew() { setEditingId("new"); setName(""); setError(null); }
  function startEdit(cat: Category) { setEditingId(cat.id); setName(cat.name); setError(null); }
  function cancelEdit() { setEditingId(null); }

  async function handleSave() {
    if (!name.trim()) { setError(t("category_name_required")); return; }
    setSaving(true);
    setError(null);
    try {
      if (editingId === "new") await api.mutate("POST", "/categories", { name: name.trim() });
      else await api.mutate("PATCH", `/categories/${editingId}`, { name: name.trim() });
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
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t("category_name_placeholder") as string} className={`w-full ${inputCls}`}
            style={{ fontSize: "16px" }} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") cancelEdit(); }} />
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
          <div key={cat.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-800">
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

// ── LocationsView ─────────────────────────────────────────────────────────────
//
// Copy of CategoriesView's exact pattern (2026-07-18 user request: "Lagerort
// Verwaltung wie Kategorien") - only the endpoint and copy differ.

function LocationsView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLocations(await api.get<Location[]>("/locations"));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  function startNew() { setEditingId("new"); setName(""); setError(null); }
  function startEdit(loc: Location) { setEditingId(loc.id); setName(loc.name); setError(null); }
  function cancelEdit() { setEditingId(null); }

  async function handleSave() {
    if (!name.trim()) { setError(t("location_name_required")); return; }
    setSaving(true);
    setError(null);
    try {
      if (editingId === "new") await api.mutate("POST", "/locations", { name: name.trim() });
      else await api.mutate("PATCH", `/locations/${editingId}`, { name: name.trim() });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm(t("location_delete_confirm"))) return;
    try {
      await api.mutate("DELETE", `/locations/${id}`);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  const inputCls = "rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("locations_title")}</h2>
        {editingId === null && (
          <button type="button" onClick={startNew}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700">
            <i className="ti ti-plus text-[13px]" /> {t("new_location")}
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
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t("location_name_placeholder") as string} className={`w-full ${inputCls}`}
            style={{ fontSize: "16px" }} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") cancelEdit(); }} />
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

      {!loading && locations.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-10 text-center dark:border-gray-800">
          <i className="ti ti-map-pin text-[32px] text-gray-300 dark:text-gray-700" />
          <p className="mt-2 text-sm text-gray-400">{t("no_locations")}</p>
        </div>
      )}

      <div className="space-y-1.5">
        {locations.map((loc) => (
          <div key={loc.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-800">
            <span className="flex-1 text-sm font-medium">{loc.name}</span>
            <button type="button" onClick={() => startEdit(loc)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
              <i className="ti ti-pencil text-[14px]" />
            </button>
            <button type="button" onClick={() => handleDelete(loc.id)}
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
// Admin-only. Configure API keys for the three vision-capable providers used
// by receipt scanning. Structure copied near-verbatim from recipes/ui/src/
// App.tsx's AISettingsView (2026-07-18 user request: same look as recipes) -
// only the provider list and route names differ. Keys are write-only from
// here on out: GET /ai-providers never returns api_key_enc/the plaintext key,
// only has_key: true/false - so the input field always starts empty and a
// save with it left empty keeps whatever key is already stored.

const AI_PROVIDERS: { id: string; label: string; placeholder_model: string }[] = [
  { id: "openai", label: "OpenAI", placeholder_model: "gpt-5.6" },
  { id: "google", label: "Google Gemini", placeholder_model: "gemini-3.1-flash" },
  { id: "anthropic", label: "Anthropic Claude", placeholder_model: "claude-haiku-4-5" },
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
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

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
    setModelOptions([]);
    setModelsError(null);
  }
  function cancelEdit() { setEditingId(null); setError(null); }

  async function handleLoadModels(providerId: string) {
    setModelsLoading(true);
    setModelsError(null);
    const cfg = configs[providerId];
    if (apiKeyInput.trim() && !cfg?.has_key) {
      try {
        await api.mutate("PUT", `/ai-providers/${providerId}`, {
          model: modelInput.trim(),
          enabled: enabledInput,
          api_key: apiKeyInput.trim(),
        });
        await load();
      } catch {
        // proceed anyway - the fetch below fails with a clear error if this didn't work
      }
    }
    try {
      const resp = await api.get<{ models: string[] }>(`/ai-providers/${providerId}/models`);
      const models = Array.isArray(resp?.models) ? resp.models : [];
      setModelOptions(models);
      if (models.length > 0 && !models.includes(modelInput)) setModelInput(models[0]);
    } catch (e) {
      setModelsError(String(e));
    } finally {
      setModelsLoading(false);
    }
  }

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
                  <div className="mt-3 space-y-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("ai_settings_api_key")}</label>
                      <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder={cfg?.has_key ? (t("ai_settings_api_key_keep") as string) : ""}
                        className={inputCls} style={{ fontSize: "16px" }} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("ai_settings_model")}</label>
                      {modelOptions.length > 0 ? (
                        <select value={modelInput} onChange={(e) => setModelInput(e.target.value)} className={inputCls} style={{ fontSize: "16px" }}>
                          {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      ) : (
                        <input type="text" value={modelInput} onChange={(e) => setModelInput(e.target.value)} className={inputCls} style={{ fontSize: "16px" }} />
                      )}
                      <button type="button" onClick={() => handleLoadModels(meta.id)} disabled={modelsLoading}
                        className="mt-1 text-xs text-teal-600 hover:underline disabled:opacity-50 dark:text-teal-400">
                        {modelsLoading ? t("loading") : t("ai_settings_load_models")}
                      </button>
                      {modelsError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{modelsError}</p>}
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
// Copied near-verbatim from recipes/ui/src/App.tsx's ModuleInfoView
// (2026-07-18 user request: "Modul-Informationen wie bei Rezepte fehlt") -
// calls Core's GET /v1/modules/{name} directly (Core's own route, not this
// module's api/ proxy), same-origin fetch with the existing Bearer token.

interface InstalledModuleInfo {
  name: string;
  version: string;
  tier: number;
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
            (that field is a single hardcoded English string) - see
            locales/*.json's info_description for the maintained, localized
            text instead. */}
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

const MODULE_SOURCE_REPO_URL = "https://github.com/modulab-project/modulab-modules";
