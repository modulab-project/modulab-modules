/**
 * Pantry module — React frontend  v0.1.0
 *
 * Visual/structural pattern deliberately mirrors recipes/ui/src/App.tsx
 * (2026-07-18 user request: "same look as recipes' AI integration") -
 * the sparkles-icon AI action button, the Admin-only Settings tab
 * (AISettingsView) for provider API keys, the useApi/extractErrorMessage
 * helpers, and the isAdmin visibility-probe pattern are all carried over
 * near-verbatim. What's specific to this module: item list with low-stock/
 * expiry badges, and the receipt-scan review flow (upload -> AI suggests
 * items -> user edits/confirms -> bulk-create) instead of recipes'
 * per-recipe "estimate nutrition" call.
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
  quantity: number;
  unit: string | null;
  location: string | null;
  expiry_date: string | null;
  min_stock: number | null;
  notes: string | null;
  image_path: string | null;
  added_via: "manual" | "ai_scan";
  is_low_stock: boolean;
  is_expired: boolean;
  days_until_expiry: number | null;
  updated_at: string;
}

interface Category {
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
  | { type: "settings" };

const UNITS = ["pcs", "kg", "g", "l", "ml", "pack", "can", "bottle"];

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

export default function PantryApp({ apiBase, token }: ModuleComponentProps) {
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

  return (
    <div className="p-4 sm:p-6">
      <nav className="mb-5 flex flex-wrap items-center gap-1 border-b border-gray-100 pb-3 dark:border-gray-800">
        <TabButton active={view.type === "list"} onClick={() => setView({ type: "list" })} icon="ti-shopping-cart" label={t("nav_items")} />
        <TabButton active={view.type === "scan"} onClick={() => setView({ type: "scan" })} icon="ti-camera" label={t("nav_scan")} />
        <TabButton active={view.type === "categories"} onClick={() => setView({ type: "categories" })} icon="ti-tag" label={t("nav_categories")} />
        {isAdmin && (
          <TabButton active={view.type === "settings"} onClick={() => setView({ type: "settings" })} icon="ti-settings" label={t("nav_settings")} />
        )}
      </nav>

      {view.type === "list" && (
        <ItemList
          api={api}
          onNew={() => setView({ type: "editor" })}
          onEdit={(id) => setView({ type: "editor", id })}
        />
      )}
      {view.type === "editor" && (
        <ItemEditor api={api} id={view.id} onDone={() => setView({ type: "list" })} onBack={() => setView({ type: "list" })} />
      )}
      {view.type === "scan" && <ScanView api={api} onDone={() => setView({ type: "list" })} />}
      {view.type === "categories" && <CategoriesView api={api} />}
      {view.type === "settings" && isAdmin && <AISettingsView api={api} />}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
        active
          ? "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
          : "text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900"
      }`}
    >
      <i className={`ti ${icon} text-[15px]`} /> {label}
    </button>
  );
}

// ── ItemList ──────────────────────────────────────────────────────────────────

function ItemList({
  api,
  onNew,
  onEdit,
}: {
  api: ReturnType<typeof useApi>;
  onNew: () => void;
  onEdit: (id: string) => void;
}) {
  const { t } = useTranslation(NS);
  const [items, setItems] = useState<PantryItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
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
      if (lowStockOnly) params.set("low_stock", "true");
      if (expiringSoonOnly) params.set("expiring_soon", "true");
      const [itemsResp, cats] = await Promise.all([
        api.get<{ items: PantryItem[]; total: number }>(`/items?${params.toString()}`),
        api.get<Category[]>("/categories"),
      ]);
      setItems(itemsResp.items);
      setCategories(cats);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [api, search, categoryFilter, lowStockOnly, expiringSoonOnly]);

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

  const lowStockCount = items.filter((i) => i.is_low_stock).length;
  const expiringCount = items.filter((i) => i.days_until_expiry != null && i.days_until_expiry <= 3).length;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("nav_items")}</h1>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
        >
          <i className="ti ti-plus text-[13px]" /> {t("btn_new_item")}
        </button>
      </div>

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
            className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 dark:border-gray-800"
          >
            <i className="ti ti-package text-[18px] text-gray-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">{item.name}</p>
                {item.added_via === "ai_scan" && (
                  <i className="ti ti-sparkles text-[12px] text-teal-500" title={t("added_via_ai_scan") as string} />
                )}
              </div>
              <p className="truncate text-xs text-gray-400">
                {item.category_name ?? t("uncategorized")}
                {item.location && ` · ${item.location}`}
              </p>
            </div>
            <span className="flex-none text-sm text-gray-500 dark:text-gray-400">
              {item.quantity} {item.unit ?? ""}
            </span>
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
        ))}
      </div>
    </div>
  );
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
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("");
  const [location, setLocation] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [minStock, setMinStock] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(!!id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories).catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!id) return;
    api
      .get<PantryItem>(`/items/${id}`)
      .then((it) => {
        setName(it.name);
        setCategoryId(it.category_id ?? "");
        setQuantity(String(it.quantity));
        setUnit(it.unit ?? "");
        setLocation(it.location ?? "");
        setExpiryDate(it.expiry_date ?? "");
        setMinStock(it.min_stock != null ? String(it.min_stock) : "");
        setNotes(it.notes ?? "");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [api, id]);

  async function handleSave() {
    if (!name.trim()) { setError(t("name_required")); return; }
    setSaving(true);
    setError(null);
    const payload = {
      name: name.trim(),
      category_id: categoryId || null,
      quantity: parseFloat(quantity) || 0,
      unit: unit.trim() || null,
      location: location.trim() || null,
      expiry_date: expiryDate || null,
      min_stock: minStock.trim() ? parseFloat(minStock) : null,
      notes: notes.trim() || null,
    };
    try {
      if (id) await api.mutate("PATCH", `/items/${id}`, payload);
      else await api.mutate("POST", "/items", payload);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";

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
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_location")}</label>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t("field_location_placeholder") as string} className={inputCls} style={{ fontSize: "16px" }} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_quantity")}</label>
            <input type="number" min={0} step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls} style={{ fontSize: "16px" }} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_unit")}</label>
            <input type="text" list="pantry-units" value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls} style={{ fontSize: "16px" }} />
            <datalist id="pantry-units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_expiry_date")}</label>
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className={inputCls} style={{ fontSize: "16px" }} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_min_stock")}</label>
            <input type="number" min={0} step="0.01" value={minStock} onChange={(e) => setMinStock(e.target.value)} placeholder={t("field_min_stock_placeholder") as string} className={inputCls} style={{ fontSize: "16px" }} />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("field_notes")}</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} style={{ fontSize: "16px" }} />
        </div>
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
// Upload a receipt photo -> POST /scan (multipart; Core writes the file and
// re-dispatches to the handler with { file_path } filled in, same pattern as
// recipes' image upload) -> AI returns suggested items -> user edits/removes
// rows -> POST /items/bulk to actually persist. Nothing is written to the
// database until the user confirms.

function ScanView({ api, onDone }: { api: ReturnType<typeof useApi>; onDone: () => void }) {
  const { t } = useTranslation(NS);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ScannedItem[] | null>(null);
  const [aiMeta, setAiMeta] = useState<{ provider: string; model: string } | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryChoices, setCategoryChoices] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories).catch(() => {});
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
          quantity: it.quantity ?? 1,
          unit: it.unit,
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
        accept="image/jpeg,image/png,image/webp"
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

          <div className="space-y-2">
            {suggestions.map((it, i) => (
              <div key={i} className="flex items-center gap-2 rounded-xl border border-gray-200 p-2.5 dark:border-gray-800">
                <input type="text" value={it.name} onChange={(e) => updateSuggestion(i, { name: e.target.value })}
                  className={`flex-1 ${inputCls}`} style={{ fontSize: "16px" }} />
                <input type="number" min={0} step="0.01" value={it.quantity ?? ""} onChange={(e) => updateSuggestion(i, { quantity: parseFloat(e.target.value) || null })}
                  className={`w-16 ${inputCls}`} style={{ fontSize: "16px" }} />
                <input type="text" value={it.unit ?? ""} onChange={(e) => updateSuggestion(i, { unit: e.target.value })}
                  placeholder={t("field_unit") as string} className={`w-20 ${inputCls}`} style={{ fontSize: "16px" }} />
                <select value={categoryChoices[i] ?? ""} onChange={(e) => setCategoryChoices((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                  className={`w-32 ${inputCls}`} style={{ fontSize: "16px" }}>
                  <option value="">{it.category ?? t("uncategorized")}</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
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
