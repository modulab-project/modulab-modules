/**
 * Vacation Spots module — React frontend v0.2.0
 *
 * Views (page-based, no modals/overlays):
 *   map        — full-screen MapLibre GL map with spot markers
 *   spot-new   — full-page spot editor (new)
 *   spot-edit  — full-page spot editor (edit existing)
 *   spot-detail — spot detail page
 *   trips      — list + create/edit/delete trips
 *   categories — list + create/edit/delete categories
 *   settings   — Maptiler API key (admin/org-admin only)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ModuleComponentProps } from "./types";

const NS = "mod_vacation-spots";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Spot {
  id: string;
  name: string;
  note: string | null;
  lat: number;
  lng: number;
  rating: number | null;
  trip_id: string | null;
  trip_name: string | null;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
  photo_paths: string[];
  created_by: string;
  created_at: string;
}

interface Trip {
  id: string;
  name: string;
  year: number | null;
  description: string;
  created_by: string;
}

interface Category {
  id: string;
  name: string;
  color: string;
  icon: string;
  sort_order: number;
  created_by: string;
}

type View =
  | { type: "map" }
  | { type: "spot-new"; lat?: number; lng?: number }
  | { type: "spot-edit"; id: string }
  | { type: "spot-detail"; id: string }
  | { type: "trips" }
  | { type: "categories" }
  | { type: "settings" };

// ── API helper ─────────────────────────────────────────────────────────────────

function useApi(apiBase: string, token: string) {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;

  const get = useCallback(async <T,>(path: string): Promise<T> => {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { const txt = await r.text(); throw new Error(txt || `HTTP ${r.status}`); }
    return r.json();
  }, [base, token]);

  const mutate = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) { const txt = await r.text(); throw new Error(txt || `HTTP ${r.status}`); }
    if (r.status === 204) return undefined as T;
    return r.json();
  }, [base, token]);

  return { get, mutate };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function navCls(active: boolean) {
  return `flex flex-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
    active
      ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
      : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
  }`;
}

const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900";
const labelCls = "mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300";

function Stars({ value, onChange }: { value: number | null; onChange?: (v: number) => void }) {
  return (
    <span className="inline-flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} onClick={() => onChange?.(n)}
          className={`text-xl leading-none ${onChange ? "cursor-pointer" : ""} ${value && n <= value ? "text-amber-400" : "text-gray-300"}`}>
          ★
        </span>
      ))}
    </span>
  );
}

// ── Root App ───────────────────────────────────────────────────────────────────

export default function App({ apiBase, token }: ModuleComponentProps) {
  const { t } = useTranslation(NS);
  const api = useApi(apiBase, token);

  const [view, setView] = useState<View>({ type: "map" });
  const [spots, setSpots] = useState<Spot[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [mapStyleUrl, setMapStyleUrl] = useState<string | null>(null);
  const [mapConfigured, setMapConfigured] = useState<boolean | null>(null);

  // Load config on mount
  useEffect(() => {
    api.get<{ map_configured: boolean; map_style_url: string | null }>("/config")
      .then((cfg) => { setMapConfigured(cfg.map_configured); setMapStyleUrl(cfg.map_style_url); })
      .catch(() => setMapConfigured(false));
  }, [api]);

  const loadAll = useCallback(async () => {
    const [s, tr, cat] = await Promise.all([
      api.get<Spot[]>("/spots"),
      api.get<Trip[]>("/trips"),
      api.get<Category[]>("/categories"),
    ]);
    setSpots(s);
    setTrips(tr);
    setCategories(cat);
  }, [api]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const vt = view.type;

  return (
    <div className="vacation-spots-module flex flex-col" style={{ height: "100vh" }}>
      {/* Nav */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-200 px-3 py-1 dark:border-gray-800 flex-shrink-0">
        <i className="ti ti-map-pin text-teal-600 text-base mr-1 flex-shrink-0" />
        <button type="button" onClick={() => setView({ type: "map" })} className={navCls(vt === "map")} title={t("nav_map")}>
          <i className="ti ti-map text-[15px]" />
          <span className="hidden sm:inline">{t("nav_map")}</span>
        </button>
        <button type="button" onClick={() => setView({ type: "trips" })} className={navCls(vt === "trips")} title={t("nav_trips")}>
          <i className="ti ti-route text-[15px]" />
          <span className="hidden sm:inline">{t("nav_trips")}</span>
        </button>
        <button type="button" onClick={() => setView({ type: "categories" })} className={navCls(vt === "categories")} title={t("nav_categories")}>
          <i className="ti ti-tag text-[15px]" />
          <span className="hidden sm:inline">{t("nav_categories")}</span>
        </button>
        <button type="button" onClick={() => setView({ type: "settings" })} className={navCls(vt === "settings")} title={t("nav_settings")}>
          <i className="ti ti-settings text-[15px]" />
          <span className="hidden sm:inline">{t("nav_settings")}</span>
        </button>
        <div className="flex-1 min-w-[4px]" />
        <button
          type="button"
          onClick={() => setView({ type: "spot-new" })}
          className="flex flex-none items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
        >
          <i className="ti ti-plus text-[14px]" />
          <span className="hidden sm:inline">{t("btn_new_spot")}</span>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {vt === "map" && (
          <MapView
            spots={spots}
            mapStyleUrl={mapStyleUrl}
            mapConfigured={mapConfigured}
            trips={trips}
            categories={categories}
            onSpotClick={(id) => setView({ type: "spot-detail", id })}
            onMapClick={(lat, lng) => setView({ type: "spot-new", lat, lng })}
            t={t}
          />
        )}
        {(vt === "spot-new" || vt === "spot-edit") && (
          <SpotEditor
            api={api}
            id={vt === "spot-edit" ? view.id : undefined}
            initialCoords={vt === "spot-new" ? { lat: view.lat, lng: view.lng } : undefined}
            trips={trips}
            categories={categories}
            onDone={(id) => { loadAll(); setView({ type: "spot-detail", id }); }}
            onCancel={() => setView({ type: "map" })}
            t={t}
          />
        )}
        {vt === "spot-detail" && (
          <SpotDetail
            api={api}
            id={view.id}
            onBack={() => setView({ type: "map" })}
            onEdit={(id) => setView({ type: "spot-edit", id })}
            onDeleted={() => { loadAll(); setView({ type: "map" }); }}
            t={t}
          />
        )}
        {vt === "trips" && (
          <TripsView trips={trips} api={api} onReload={loadAll} t={t} />
        )}
        {vt === "categories" && (
          <CategoriesView categories={categories} api={api} onReload={loadAll} t={t} />
        )}
        {vt === "settings" && (
          <SettingsView
            api={api}
            onSaved={(styleUrl) => { setMapStyleUrl(styleUrl); setMapConfigured(!!styleUrl); }}
            t={t}
          />
        )}
      </div>
    </div>
  );
}

// ── MapView ────────────────────────────────────────────────────────────────────

function MapView({ spots, mapStyleUrl, mapConfigured, trips, categories, onSpotClick, onMapClick, t }: {
  spots: Spot[];
  mapStyleUrl: string | null;
  mapConfigured: boolean | null;
  trips: Trip[];
  categories: Category[];
  onSpotClick: (id: string) => void;
  onMapClick: (lat: number, lng: number) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [filterTrip, setFilterTrip] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  const filtered = spots.filter((s) => {
    if (filterTrip && s.trip_id !== filterTrip) return false;
    if (filterCategory && s.category_id !== filterCategory) return false;
    return true;
  });

  // Init map
  useEffect(() => {
    if (!mapContainerRef.current || !mapStyleUrl) return;
    if (mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: mapStyleUrl,
      center: [13, 48],
      zoom: 4,
    });
    map.addControl(new maplibregl.NavigationControl(), "bottom-right");
    map.on("click", (e) => onMapClick(e.lngLat.lat, e.lngLat.lng));
    mapRef.current = map;

    return () => { map.remove(); mapRef.current = null; };
  }, [mapStyleUrl]);

  // Markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    filtered.forEach((spot) => {
      const color = spot.category_color ?? "#888780";
      const el = document.createElement("div");
      el.style.cssText = `width:28px;height:28px;border-radius:50%;background:${color};border:2px solid white;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3)`;
      el.innerHTML = `<i class="ti ${spot.category_icon ?? "ti-map-pin"}" style="font-size:13px;color:white;pointer-events:none"></i>`;

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 16, maxWidth: "220px" })
        .setHTML(`<div style="font-family:sans-serif;padding:4px"><div style="font-weight:500;font-size:13px;margin-bottom:4px">${spot.name}</div>${spot.category_name ? `<span style="font-size:11px;background:${color}22;color:${color};padding:2px 6px;border-radius:4px">${spot.category_name}</span>` : ""}${spot.rating ? `<div style="color:#EF9F27;margin-top:4px">${"★".repeat(spot.rating)}${"☆".repeat(5 - spot.rating)}</div>` : ""}${spot.note ? `<div style="font-size:12px;color:#666;margin-top:4px">${spot.note.slice(0, 80)}${spot.note.length > 80 ? "…" : ""}</div>` : ""}</div>`);

      el.addEventListener("mouseenter", () => popup.addTo(map));
      el.addEventListener("mouseleave", () => popup.remove());
      el.addEventListener("click", (e) => { e.stopPropagation(); onSpotClick(spot.id); });

      markersRef.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([spot.lng, spot.lat]).addTo(map)
      );
    });
  }, [filtered, mapStyleUrl]);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-44 flex-shrink-0 border-r border-gray-200 bg-gray-50 p-3 flex flex-col gap-3 overflow-y-auto dark:border-gray-800 dark:bg-gray-900">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{t("nav_trips")}</label>
          <select value={filterTrip} onChange={(e) => { setFilterTrip(e.target.value); setFilterCategory(""); }}
            className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800" style={{ fontSize: "14px" }}>
            <option value="">{t("all_trips")}</option>
            {trips.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{t("nav_categories")}</label>
          <select value={filterCategory} onChange={(e) => { setFilterCategory(e.target.value); setFilterTrip(""); }}
            className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800" style={{ fontSize: "14px" }}>
            <option value="">{t("all_categories")}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="mt-auto text-xs text-gray-400">{filtered.length} spot{filtered.length !== 1 ? "s" : ""}</div>
      </div>

      {/* Map */}
      <div className="flex-1">
        {mapConfigured === false ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-gray-500 px-8">
            <div>
              <i className="ti ti-key block text-4xl mb-3 text-gray-300" />
              {t("error_no_key")}
            </div>
          </div>
        ) : (
          <div ref={mapContainerRef} className="w-full h-full" />
        )}
      </div>
    </div>
  );
}

// ── SpotDetail ─────────────────────────────────────────────────────────────────

function SpotDetail({ api, id, onBack, onEdit, onDeleted, t }: {
  api: ReturnType<typeof useApi>;
  id: string;
  onBack: () => void;
  onEdit: (id: string) => void;
  onDeleted: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Spot>(`/spots/${id}`).then(setSpot).finally(() => setLoading(false));
  }, [api, id]);

  async function handleDelete() {
    if (!window.confirm(t("spot_delete_confirm"))) return;
    await api.mutate("DELETE", `/spots/${id}`);
    onDeleted();
  }

  if (loading) return <div className="p-6 text-sm text-gray-400">{t("loading")}</div>;
  if (!spot) return <div className="p-6 text-sm text-red-500">{t("error_load")}</div>;

  return (
    <div className="mx-auto max-w-xl overflow-y-auto h-full px-4 py-6">
      <button type="button" onClick={onBack}
        className="mb-4 flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
        <i className="ti ti-arrow-left text-[14px]" /> {t("back")}
      </button>

      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{spot.name}</h1>
          {spot.category_name && (
            <span className="mt-1 inline-block rounded-full px-2 py-0.5 text-xs"
              style={{ background: (spot.category_color ?? "#888") + "22", color: spot.category_color ?? "#888" }}>
              {spot.category_name}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => onEdit(id)}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
            <i className="ti ti-pencil text-[14px]" /> {t("btn_edit")}
          </button>
          <button type="button" onClick={handleDelete}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400">
            <i className="ti ti-trash text-[14px]" />
          </button>
        </div>
      </div>

      {spot.rating && <div className="mb-4"><Stars value={spot.rating} /></div>}

      {spot.note && <p className="mb-4 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">{spot.note}</p>}

      <div className="flex flex-wrap gap-3 text-sm text-gray-500 dark:text-gray-400 mb-4">
        {spot.trip_name && <span><i className="ti ti-route mr-1" />{spot.trip_name}</span>}
        <span><i className="ti ti-map-pin mr-1" />{spot.lat.toFixed(5)}, {spot.lng.toFixed(5)}</span>
        <span><i className="ti ti-calendar mr-1" />{new Date(spot.created_at).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

// ── SpotEditor (new + edit, full page) ────────────────────────────────────────

function SpotEditor({ api, id, initialCoords, trips, categories, onDone, onCancel, t }: {
  api: ReturnType<typeof useApi>;
  id?: string;
  initialCoords?: { lat?: number; lng?: number };
  trips: Trip[];
  categories: Category[];
  onDone: (id: string) => void;
  onCancel: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const isEdit = !!id;
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [lat, setLat] = useState(initialCoords?.lat?.toFixed(6) ?? "");
  const [lng, setLng] = useState(initialCoords?.lng?.toFixed(6) ?? "");
  const [rating, setRating] = useState<number | null>(null);
  const [tripId, setTripId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.get<Spot>(`/spots/${id}`).then((s) => {
      setName(s.name);
      setNote(s.note ?? "");
      setLat(s.lat.toFixed(6));
      setLng(s.lng.toFixed(6));
      setRating(s.rating);
      setTripId(s.trip_id ?? "");
      setCategoryId(s.category_id ?? "");
    }).catch(() => setError(t("error_load")));
  }, [api, id]);

  const handleGps = () => {
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLat(pos.coords.latitude.toFixed(6)); setLng(pos.coords.longitude.toFixed(6)); },
      () => setError(t("error_location")),
    );
  };

  const handleSave = async () => {
    if (!name.trim()) { setNameErr(true); return; }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        note: note.trim() || null,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        rating,
        trip_id: tripId || null,
        category_id: categoryId || null,
      };
      let resultId: string;
      if (isEdit) {
        await api.mutate("PATCH", `/spots/${id}`, body);
        resultId = id!;
      } else {
        const created = await api.mutate<{ id: string }>("POST", "/spots", body);
        resultId = created.id;
      }
      onDone(resultId);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl overflow-y-auto h-full px-4 py-6">
      <button type="button" onClick={onCancel}
        className="mb-4 flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:text-gray-400">
        <i className="ti ti-arrow-left text-[14px]" /> {t("btn_cancel")}
      </button>

      <h1 className="mb-5 text-xl font-semibold">
        {isEdit ? t("btn_edit") : t("btn_new_spot")}
      </h1>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {/* Name */}
        <div>
          <label className={labelCls}>{t("spot_name")} *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameErr(false); }}
            placeholder={t("spot_name_placeholder")}
            className={`${inputCls} ${nameErr ? "border-red-400 ring-red-300" : ""}`}
            style={{ fontSize: "16px" }}
            autoFocus
          />
          {nameErr && <p className="mt-1 text-xs text-red-500">{t("spot_name_required")}</p>}
        </div>

        {/* Trip + Category */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t("spot_trip")}</label>
            <select value={tripId} onChange={(e) => setTripId(e.target.value)} className={inputCls} style={{ fontSize: "16px" }}>
              <option value="">—</option>
              {trips.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t("spot_category")}</label>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputCls} style={{ fontSize: "16px" }}>
              <option value="">—</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        {/* Rating */}
        <div>
          <label className={labelCls}>{t("spot_rating")}</label>
          <Stars value={rating} onChange={setRating} />
          {rating && (
            <button type="button" onClick={() => setRating(null)}
              className="ml-3 text-xs text-gray-400 hover:text-gray-600">×</button>
          )}
        </div>

        {/* Note */}
        <div>
          <label className={labelCls}>{t("spot_note")}</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("spot_note_placeholder")}
            className={inputCls}
            rows={4}
            style={{ fontSize: "16px" }}
          />
        </div>

        {/* Coordinates */}
        <div>
          <label className={labelCls}>{t("spot_location")}</label>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="Lat"
              className={inputCls} style={{ fontSize: "16px" }} />
            <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="Lng"
              className={inputCls} style={{ fontSize: "16px" }} />
          </div>
          <button type="button" onClick={handleGps}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
            <i className="ti ti-current-location text-[13px]" /> {t("btn_use_gps")}
          </button>
          <p className="mt-1.5 text-xs text-gray-400">{t("spot_location_hint")}</p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
            {t("btn_cancel")}
          </button>
          <button type="button" onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
            {saving
              ? <><i className="ti ti-loader-2 animate-spin text-[13px]" /> {t("saving")}</>
              : t("btn_save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── TripsView ──────────────────────────────────────────────────────────────────

function TripsView({ trips, api, onReload, t }: {
  trips: Trip[];
  api: ReturnType<typeof useApi>;
  onReload: () => void;
  t: (k: string) => string;
}) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [year, setYear] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startNew() { setEditingId("new"); setName(""); setYear(""); setDesc(""); setError(null); }
  function startEdit(tr: Trip) { setEditingId(tr.id); setName(tr.name); setYear(String(tr.year ?? "")); setDesc(tr.description ?? ""); setError(null); }
  function cancelEdit() { setEditingId(null); setError(null); }

  const save = async () => {
    if (!name.trim()) { setError(t("trip_name_required")); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), year: year ? parseInt(year) : null, description: desc };
      if (editingId === "new") await api.mutate("POST", "/trips", body);
      else await api.mutate("PATCH", `/trips/${editingId}`, body);
      cancelEdit();
      onReload();
    } catch (e) {
      setError(String(e));
    } finally { setSaving(false); }
  };

  const del = async (id: string) => {
    if (!window.confirm(t("trip_delete_confirm"))) return;
    await api.mutate("DELETE", `/trips/${id}`);
    onReload();
  };

  return (
    <div className="mx-auto max-w-lg overflow-y-auto h-full px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("nav_trips")}</h2>
        {editingId === null && (
          <button type="button" onClick={startNew}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700">
            <i className="ti ti-plus text-[13px]" /> {t("btn_new_trip")}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {editingId !== null && (
        <div className="mb-4 rounded-2xl border border-teal-200 bg-teal-50 p-4 dark:border-teal-800 dark:bg-teal-950 space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("trip_name_placeholder")}
            className={inputCls} style={{ fontSize: "16px" }} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancelEdit(); }} />
          <div className="grid grid-cols-3 gap-2">
            <input value={year} onChange={(e) => setYear(e.target.value)} placeholder={t("trip_year")}
              type="number" className={inputCls} style={{ fontSize: "16px" }} />
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("trip_description_placeholder")}
              className={`${inputCls} col-span-2`} style={{ fontSize: "16px" }} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={cancelEdit}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">{t("btn_cancel")}</button>
            <button type="button" onClick={save} disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
              {saving ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-check text-[13px]" />}
              {t("btn_save")}
            </button>
          </div>
        </div>
      )}

      {trips.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-10 text-center dark:border-gray-800">
          <i className="ti ti-route text-[32px] text-gray-300 dark:text-gray-700 block" />
          <p className="mt-2 text-sm text-gray-400">{t("no_trips")}</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {trips.map((tr) => (
            <div key={tr.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-800">
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm">{tr.name}</span>
                {tr.year && <span className="ml-2 text-xs text-gray-400">{tr.year}</span>}
                {tr.description && <p className="text-xs text-gray-500 truncate mt-0.5">{tr.description}</p>}
              </div>
              <button type="button" onClick={() => startEdit(tr)}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
                <i className="ti ti-pencil text-[14px]" />
              </button>
              <button type="button" onClick={() => del(tr.id)}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
                <i className="ti ti-trash text-[14px]" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── CategoriesView ─────────────────────────────────────────────────────────────

function CategoriesView({ categories, api, onReload, t }: {
  categories: Category[];
  api: ReturnType<typeof useApi>;
  onReload: () => void;
  t: (k: string) => string;
}) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#888780");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startNew() { setEditingId("new"); setName(""); setColor("#888780"); setError(null); }
  function startEdit(c: Category) { setEditingId(c.id); setName(c.name); setColor(c.color); setError(null); }
  function cancelEdit() { setEditingId(null); setError(null); }

  const save = async () => {
    if (!name.trim()) { setError(t("category_name_required")); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), color };
      if (editingId === "new") await api.mutate("POST", "/categories", body);
      else await api.mutate("PATCH", `/categories/${editingId}`, body);
      cancelEdit();
      onReload();
    } catch (e) {
      setError(String(e));
    } finally { setSaving(false); }
  };

  const del = async (id: string) => {
    if (!window.confirm(t("category_delete_confirm"))) return;
    await api.mutate("DELETE", `/categories/${id}`);
    onReload();
  };

  return (
    <div className="mx-auto max-w-lg overflow-y-auto h-full px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("nav_categories")}</h2>
        {editingId === null && (
          <button type="button" onClick={startNew}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700">
            <i className="ti ti-plus text-[13px]" /> {t("btn_new_category")}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {editingId !== null && (
        <div className="mb-4 rounded-2xl border border-teal-200 bg-teal-50 p-4 dark:border-teal-800 dark:bg-teal-950 space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("category_name_placeholder")}
            className={inputCls} style={{ fontSize: "16px" }} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancelEdit(); }} />
          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-600 dark:text-gray-400">{t("category_color")}</label>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
              className="h-9 w-14 cursor-pointer rounded border border-gray-300 p-1 dark:border-gray-700" />
            <span className="text-sm text-gray-500 font-mono">{color}</span>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={cancelEdit}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">{t("btn_cancel")}</button>
            <button type="button" onClick={save} disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
              {saving ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-check text-[13px]" />}
              {t("btn_save")}
            </button>
          </div>
        </div>
      )}

      {categories.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-10 text-center dark:border-gray-800">
          <i className="ti ti-tag text-[32px] text-gray-300 dark:text-gray-700 block" />
          <p className="mt-2 text-sm text-gray-400">{t("no_categories")}</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {categories.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-800">
              <span className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: c.color }} />
              <span className="flex-1 text-sm font-medium">{c.name}</span>
              {c.created_by !== "system" && (
                <>
                  <button type="button" onClick={() => startEdit(c)}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
                    <i className="ti ti-pencil text-[14px]" />
                  </button>
                  <button type="button" onClick={() => del(c.id)}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
                    <i className="ti ti-trash text-[14px]" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── SettingsView ───────────────────────────────────────────────────────────────

function SettingsView({ api, onSaved, t }: {
  api: ReturnType<typeof useApi>;
  onSaved: (styleUrl: string | null) => void;
  t: (k: string) => string;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    api.get<{ map_configured: boolean; map_style_url: string | null }>("/config")
      .then((cfg) => setConfigured(cfg.map_configured))
      .catch(() => setConfigured(false));
  }, [api]);

  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.mutate("PUT", "/settings", { maptiler_api_key: key.trim() });
      const cfg = await api.get<{ map_configured: boolean; map_style_url: string | null }>("/config");
      setConfigured(cfg.map_configured);
      onSaved(cfg.map_style_url);
      setKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(t("error_save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-md overflow-y-auto h-full px-4 py-6">
      <h2 className="mb-5 text-lg font-semibold">{t("settings_title")}</h2>

      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-gray-900 space-y-4">
        {/* Status indicator */}
        <div className="flex items-center gap-2 text-sm">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${configured ? "bg-teal-500" : "bg-red-400"}`} />
          <span className="text-gray-600 dark:text-gray-400">
            {configured ? t("settings_key_active") : t("settings_key_missing")}
          </span>
        </div>

        {/* Key input */}
        <div>
          <label className={labelCls}>{t("settings_maptiler_key")}</label>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={configured ? t("settings_key_replace_placeholder") : t("settings_maptiler_key_placeholder")}
            className={inputCls}
            style={{ fontSize: "16px" }}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          <p className="mt-1.5 text-xs text-gray-400">
            {t("settings_maptiler_hint")} —{" "}
            <a href="https://maptiler.com" target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline">
              maptiler.com
            </a>
          </p>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving || !key.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {saved
              ? <><i className="ti ti-check text-[13px]" /> {t("settings_saved")}</>
              : saving
                ? <><i className="ti ti-loader-2 animate-spin text-[13px]" /> {t("saving")}</>
                : t("btn_save")}
          </button>
        </div>
      </div>
    </div>
  );
}
