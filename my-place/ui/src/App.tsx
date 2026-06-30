/**
 * My Places module — React frontend v0.1.0
 *
 * Views: map | spots | spot-new | spot-edit | spot-detail | trips | categories | settings
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type * as GeoJSON from "geojson";
import type { ModuleComponentProps } from "./types";

const NS = "mod_my-places";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SpotPhoto {
  id: string;
  file_path: string;
  position: number;
}

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
  // listSpots returns photo_paths (string[]); getSpot returns photos (SpotPhoto[])
  photo_paths?: string[];
  photos?: SpotPhoto[];
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
  | { type: "spots" }
  | { type: "spot-new" }
  | { type: "spot-edit"; id: string }
  | { type: "spot-detail"; id: string }
  | { type: "trips" }
  | { type: "categories" }
  | { type: "settings" };

// ── Shared styles ──────────────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder:text-gray-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500";
const labelCls = "mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300";
const btnPrimary =
  "flex items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50";
const btnSecondary =
  "flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800";
const btnDanger =
  "flex items-center justify-center gap-1.5 rounded-lg border border-red-300 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950";

// ── API helper ─────────────────────────────────────────────────────────────────

// Module-level storage base — same pattern as Recipes module
let _storageBase = "";
let _token = "";

function setStorageBase(apiBase: string, token: string) {
  _storageBase = apiBase.replace(/\/api\/?$/, "") + "/storage";
  _token = token;
}

function storageUrl(path: string): string {
  if (!path) return "";
  const storageIdx = path.indexOf("/storage/");
  const rel = storageIdx !== -1 ? path.slice(storageIdx + 9) : path;
  return `${_storageBase}/${rel}?t=${encodeURIComponent(_token)}`;
}

function useApi(apiBase: string, token: string) {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;

  const get = useCallback(async <T,>(path: string): Promise<T> => {
    const r = await fetch(base + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
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

  // Upload a file via multipart/form-data — Core intercepts and saves the file,
  // then forwards { file_path } to the Deno handler which does the DB insert.
  const upload = useCallback(async <T = { file_path: string },>(path: string, formData: FormData): Promise<T> => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!r.ok) { const txt = await r.text(); throw new Error(txt || `HTTP ${r.status}`); }
    return r.json();
  }, [base, token]);

  return useMemo(() => ({ get, mutate, upload }), [get, mutate, upload]);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function navCls(active: boolean) {
  return `flex flex-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
    active
      ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
      : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
  }`;
}

function Stars({ value, onChange }: { value: number | null; onChange?: (v: number) => void }) {
  return (
    <span className="inline-flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} onClick={() => onChange?.(n)}
          className={`text-2xl leading-none ${onChange ? "cursor-pointer" : ""} ${value && n <= value ? "text-amber-400" : "text-gray-300 dark:text-gray-600"}`}>
          ★
        </span>
      ))}
    </span>
  );
}

// ── PhotoGrid — reusable photo upload/delete grid ──────────────────────────────

function PhotoGrid({ photos, uploading, uploadErr, onUpload, onDelete, fileInputRef }: {
  photos: SpotPhoto[];
  uploading: boolean;
  uploadErr: string | null;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDelete: (id: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onUpload} />
      {uploadErr && <p className="mb-2 text-xs text-red-500">{uploadErr}</p>}
      {uploading && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-teal-600">
          <i className="ti ti-loader-2 animate-spin" /> Hochladen…
        </p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {photos.map((p) => (
          <div key={p.id}>
            <div className="aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
              <img src={storageUrl(p.file_path)} alt="" className="w-full h-full object-cover" loading="lazy" />
            </div>
            {/* Delete-Button: below the image, not overlaid — avoids relying on
                Tailwind utility classes (e.g. absolute positioning offsets)
                that aren't used anywhere in Core's own frontend source and
                therefore get purged from Core's built CSS (Core's Tailwind
                content scan only covers frontend/src, not module repos). */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
              className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg py-1 text-xs text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400 transition-colors"
              aria-label="Foto löschen"
            >
              <i className="ti ti-trash text-xs" /> Löschen
            </button>
          </div>
        ))}
        {/* Add button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="aspect-square rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-400 hover:border-teal-400 hover:text-teal-500 active:bg-teal-50 transition-colors disabled:opacity-50"
        >
          <i className="ti ti-plus text-xl" />
        </button>
      </div>
    </div>
  );
}

// ── Root App ───────────────────────────────────────────────────────────────────

export default function App({ apiBase, token }: ModuleComponentProps) {
  const { t } = useTranslation(NS);
  const api = useApi(apiBase, token);
  setStorageBase(apiBase, token);

  const [view, setView] = useState<View>({ type: "map" });
  const [spots, setSpots] = useState<Spot[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [mapStyleUrl, setMapStyleUrl] = useState<string | null>(null);
  const [mapConfigured, setMapConfigured] = useState<boolean | null>(null);

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
    setSpots(s); setTrips(tr); setCategories(cat);
  }, [api]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const vt = view.type;

  return (
    <div className="my-places-module flex flex-col" style={{ height: "100vh" }}>
      {/* Nav */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-200 px-3 py-1 dark:border-gray-800 flex-shrink-0">
        <i className="ti ti-map-pin text-teal-600 text-base mr-1 flex-shrink-0" />
        <button type="button" onClick={() => setView({ type: "map" })} className={navCls(vt === "map")}>
          <i className="ti ti-map text-[15px]" />
          <span className="hidden sm:inline">{t("nav_map")}</span>
        </button>
        <button type="button" onClick={() => setView({ type: "spots" })} className={navCls(vt === "spots")}>
          <i className="ti ti-list text-[15px]" />
          <span className="hidden sm:inline">{t("nav_spots")}</span>
        </button>
        <button type="button" onClick={() => setView({ type: "trips" })} className={navCls(vt === "trips")}>
          <i className="ti ti-route text-[15px]" />
          <span className="hidden sm:inline">{t("nav_trips")}</span>
        </button>
        <button type="button" onClick={() => setView({ type: "categories" })} className={navCls(vt === "categories")}>
          <i className="ti ti-tag text-[15px]" />
          <span className="hidden sm:inline">{t("nav_categories")}</span>
        </button>
        <button type="button" onClick={() => setView({ type: "settings" })} className={navCls(vt === "settings")}>
          <i className="ti ti-settings text-[15px]" />
          <span className="hidden sm:inline">{t("nav_settings")}</span>
        </button>
        <div className="flex-1 min-w-[4px]" />
        <button type="button" onClick={() => setView({ type: "spot-new" })}
          className="flex flex-none items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700">
          <i className="ti ti-plus text-[14px]" />
          <span className="hidden sm:inline">{t("btn_new_spot")}</span>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {vt === "map" && (
          <MapView spots={spots} mapStyleUrl={mapStyleUrl} mapConfigured={mapConfigured}
            trips={trips} categories={categories}
            onSpotClick={(id) => setView({ type: "spot-detail", id })} t={t} />
        )}
        {vt === "spots" && (
          <SpotsListView spots={spots} trips={trips} categories={categories}
            onSpotClick={(id) => setView({ type: "spot-detail", id })}
            onNewSpot={() => setView({ type: "spot-new" })} t={t} />
        )}
        {(vt === "spot-new" || vt === "spot-edit") && (
          <SpotEditor api={api}
            id={vt === "spot-edit" ? view.id : undefined}
            trips={trips} categories={categories}
            onDone={(id) => { loadAll(); setView({ type: "spot-detail", id }); }}
            onCancel={() => setView({ type: "map" })} t={t} />
        )}
        {vt === "spot-detail" && (
          <SpotDetail api={api} id={view.id}
            onBack={() => setView({ type: "spots" })}
            onEdit={(id) => setView({ type: "spot-edit", id })}
            onDeleted={() => { loadAll(); setView({ type: "spots" }); }} t={t} />
        )}
        {vt === "trips" && <TripsView trips={trips} api={api} onReload={loadAll} t={t} />}
        {vt === "categories" && <CategoriesView categories={categories} api={api} onReload={loadAll} t={t} />}
        {vt === "settings" && (
          <SettingsView api={api}
            onSaved={(styleUrl) => { setMapStyleUrl(styleUrl); setMapConfigured(!!styleUrl); }} t={t} />
        )}
      </div>
    </div>
  );
}

// ── MapView ────────────────────────────────────────────────────────────────────

const SOURCE_ID = "spots";
const LAYER_ID = "spots-circles";
const LAYER_LABEL_ID = "spots-labels";

function spotsToGeoJSON(spots: Spot[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: spots.map((s) => ({
      type: "Feature",
      id: s.id,
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      properties: {
        id: s.id,
        name: s.name,
        note: s.note ?? "",
        rating: s.rating ?? 0,
        color: s.category_color ?? "#0d9488",
        category_name: s.category_name ?? "",
      },
    })),
  };
}

function MapView({ spots, mapStyleUrl, mapConfigured, trips, categories, onSpotClick, t }: {
  spots: Spot[];
  mapStyleUrl: string | null;
  mapConfigured: boolean | null;
  trips: Trip[];
  categories: Category[];
  onSpotClick: (id: string) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [filterTrip, setFilterTrip] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  const filtered = useMemo(() => spots.filter((s) => {
    if (filterTrip && s.trip_id !== filterTrip) return false;
    if (filterCategory && s.category_id !== filterCategory) return false;
    return true;
  }), [spots, filterTrip, filterCategory]);

  const onSpotClickRef = useRef(onSpotClick);
  onSpotClickRef.current = onSpotClick;

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
    popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "240px" });

    map.on("load", () => {
      map.addSource(SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: LAYER_ID, type: "circle", source: SOURCE_ID,
        paint: { "circle-radius": 10, "circle-color": ["get", "color"], "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" },
      });
      map.addLayer({
        id: LAYER_LABEL_ID, type: "symbol", source: SOURCE_ID,
        layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"], "text-size": 12, "text-offset": [0, 1.4], "text-anchor": "top" },
        paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
      });
      map.on("mouseenter", LAYER_ID, (e) => {
        map.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        const { name, note, rating, category_name, color } = f.properties as Record<string, unknown>;
        const stars = typeof rating === "number" && rating > 0
          ? `<div style="color:#f59e0b;margin-top:3px">${"★".repeat(rating as number)}${"☆".repeat(5 - (rating as number))}</div>` : "";
        const cat = category_name
          ? `<span style="font-size:11px;background:${color}22;color:${color};padding:1px 6px;border-radius:4px">${category_name}</span>` : "";
        const noteHtml = note
          ? `<div style="font-size:12px;color:#555;margin-top:4px">${(note as string).slice(0, 80)}${(note as string).length > 80 ? "…" : ""}</div>` : "";
        popupRef.current!
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(`<div style="font-family:sans-serif;padding:4px"><div style="font-weight:600;font-size:13px;margin-bottom:4px">${name}</div>${cat}${stars}${noteHtml}</div>`)
          .addTo(map);
      });
      map.on("mouseleave", LAYER_ID, () => { map.getCanvas().style.cursor = ""; popupRef.current!.remove(); });
      map.on("click", LAYER_ID, (e) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) onSpotClickRef.current(id);
      });
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, [mapStyleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const geoJSON = spotsToGeoJSON(filtered);
    if (map.isStyleLoaded()) {
      (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(geoJSON);
    } else {
      const onLoad = () => { (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(geoJSON); };
      map.once("load", onLoad);
      return () => { map.off("load", onLoad); };
    }
  }, [filtered]);

  return (
    <div className="flex h-full">
      <div className="w-40 flex-shrink-0 border-r border-gray-200 bg-gray-50 p-3 flex flex-col gap-3 overflow-y-auto dark:border-gray-800 dark:bg-gray-900">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{t("nav_trips")}</label>
          <select value={filterTrip} onChange={(e) => { setFilterTrip(e.target.value); setFilterCategory(""); }}
            className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" style={{ fontSize: "16px" }}>
            <option value="">{t("all_trips")}</option>
            {trips.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{t("nav_categories")}</label>
          <select value={filterCategory} onChange={(e) => { setFilterCategory(e.target.value); setFilterTrip(""); }}
            className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" style={{ fontSize: "16px" }}>
            <option value="">{t("all_categories")}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="mt-auto text-xs text-gray-400">{filtered.length} {filtered.length !== 1 ? t("spot_count_many") : t("spot_count_one")}</div>
      </div>
      <div className="flex-1 relative">
        {mapConfigured === false ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-gray-500 px-8">
            <div><i className="ti ti-key block text-4xl mb-3 text-gray-300" />{t("error_no_key")}</div>
          </div>
        ) : (
          <div ref={mapContainerRef} className="w-full h-full" />
        )}
      </div>
    </div>
  );
}

// ── SpotsListView ──────────────────────────────────────────────────────────────

function SpotsListView({ spots, trips, categories, onSpotClick, onNewSpot, t }: {
  spots: Spot[];
  trips: Trip[];
  categories: Category[];
  onSpotClick: (id: string) => void;
  onNewSpot: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const [search, setSearch] = useState("");
  const [filterTrip, setFilterTrip] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "name" | "rating">("date");

  const filtered = useMemo(() => {
    let list = spots;
    if (filterTrip) list = list.filter((s) => s.trip_id === filterTrip);
    if (filterCategory) list = list.filter((s) => s.category_id === filterCategory);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) || (s.note ?? "").toLowerCase().includes(q) ||
        (s.trip_name ?? "").toLowerCase().includes(q) || (s.category_name ?? "").toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "rating") return (b.rating ?? 0) - (a.rating ?? 0);
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [spots, filterTrip, filterCategory, search, sortBy]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-wrap gap-2 border-b border-gray-200 dark:border-gray-800 px-4 py-2.5 bg-gray-50 dark:bg-gray-900 flex-shrink-0">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={t("spots_search_placeholder")}
          className="flex-1 min-w-[140px] rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
          style={{ fontSize: "16px" }} />
        <select value={filterTrip} onChange={(e) => setFilterTrip(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" style={{ fontSize: "16px" }}>
          <option value="">{t("all_trips")}</option>
          {trips.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
        </select>
        <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" style={{ fontSize: "16px" }}>
          <option value="">{t("all_categories")}</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as "date" | "name" | "rating")}
          className="rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" style={{ fontSize: "16px" }}>
          <option value="date">{t("sort_date")}</option>
          <option value="name">{t("sort_name")}</option>
          <option value="rating">{t("sort_rating")}</option>
        </select>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <i className="ti ti-map-pin-off text-[40px] text-gray-300 dark:text-gray-700 mb-3" />
            <p className="text-sm text-gray-400">{spots.length === 0 ? t("no_spots") : t("no_spots_filter")}</p>
            {spots.length === 0 && (
              <button type="button" onClick={onNewSpot} className={`mt-4 ${btnPrimary}`}>
                <i className="ti ti-plus text-[13px]" /> {t("btn_new_spot")}
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-gray-400">{filtered.length} {filtered.length === 1 ? t("spot_count_one") : t("spot_count_many")}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((spot) => {
                const color = spot.category_color ?? "#0d9488";
                return (
                  <button key={spot.id} type="button" onClick={() => onSpotClick(spot.id)}
                    className="text-left rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 hover:border-teal-400 dark:hover:border-teal-600 hover:shadow-sm transition-all">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: color + "22" }}>
                        <i className={`ti ${spot.category_icon ?? "ti-map-pin"} text-base`} style={{ color }} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">{spot.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {spot.trip_name && <span className="text-xs text-gray-400"><i className="ti ti-route text-[10px] mr-0.5" />{spot.trip_name}</span>}
                          {spot.category_name && (
                            <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: color + "22", color }}>
                              {spot.category_name}
                            </span>
                          )}
                        </div>
                        {spot.rating != null && (
                          <div className="mt-1 text-amber-400 text-xs">
                            {"★".repeat(spot.rating)}<span className="text-gray-200 dark:text-gray-700">{"★".repeat(5 - spot.rating)}</span>
                          </div>
                        )}
                        {spot.note && <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2 leading-relaxed">{spot.note}</p>}
                        <div className="mt-2 text-[10px] text-gray-300 dark:text-gray-600">{new Date(spot.created_at).toLocaleDateString()}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
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
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    setUploadErr(null);
    api.get<Spot>(`/spots/${id}`)
      .then((s) => setSpot(s))
      .catch(() => setUploadErr("Laden fehlgeschlagen"));
  }, [api, id]);

  useEffect(() => {
    setLoading(true);
    api.get<Spot>(`/spots/${id}`)
      .then(setSpot)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [api, id]);

  async function handleDelete() {
    if (!window.confirm(t("spot_delete_confirm"))) return;
    await api.mutate("DELETE", `/spots/${id}`);
    onDeleted();
  }

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.upload(`/spots/${id}/photos`, fd);
      reload();
    } catch (err) {
      setUploadErr(String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDeletePhoto(photoId: string) {
    setUploadErr(null);
    try {
      await api.mutate<void>("DELETE", `/spots/${id}/photos/${photoId}`);
      setSpot((prev) => prev ? { ...prev, photos: (prev.photos ?? []).filter((p) => p.id !== photoId) } : prev);
    } catch (err) {
      setUploadErr(String(err));
    }
  }

  if (loading) return <div className="p-6 text-sm text-gray-400">{t("loading")}</div>;
  if (!spot) return <div className="p-6 text-sm text-red-500">{t("error_load")}</div>;

  return (
    <div className="mx-auto max-w-xl overflow-y-auto h-full px-4 py-6">
      <button type="button" onClick={onBack}
        className="mb-5 flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
        <i className="ti ti-arrow-left text-[14px]" /> {t("back")}
      </button>

      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{spot.name}</h1>
          {spot.category_name && (
            <span className="mt-1 inline-block rounded-full px-2.5 py-0.5 text-sm font-medium"
              style={{ background: (spot.category_color ?? "#888") + "22", color: spot.category_color ?? "#888" }}>
              {spot.category_name}
            </span>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button type="button" onClick={() => onEdit(id)} className={btnSecondary}>
            <i className="ti ti-pencil text-[14px]" />
            <span className="hidden sm:inline">{t("btn_edit")}</span>
          </button>
          <button type="button" onClick={handleDelete} className={btnDanger}>
            <i className="ti ti-trash text-[14px]" />
          </button>
        </div>
      </div>

      {spot.rating != null && <div className="mb-4"><Stars value={spot.rating} /></div>}

      {spot.note && <p className="mb-5 text-base text-gray-700 dark:text-gray-300 leading-relaxed">{spot.note}</p>}

      <div className="flex flex-wrap gap-4 text-sm text-gray-500 dark:text-gray-400 mb-6 pb-5 border-b border-gray-100 dark:border-gray-800">
        {spot.trip_name && <span className="flex items-center gap-1.5"><i className="ti ti-route" />{spot.trip_name}</span>}
        <span className="flex items-center gap-1.5"><i className="ti ti-map-pin" />{spot.lat.toFixed(5)}, {spot.lng.toFixed(5)}</span>
        <span className="flex items-center gap-2">
          <a href={`maps://?q=${spot.lat},${spot.lng}`}
            className="flex items-center gap-1 text-teal-600 hover:underline dark:text-teal-400">
            <i className="ti ti-brand-apple text-[13px]" /> Apple Maps
          </a>
          <a href={`https://maps.google.com/?q=${spot.lat},${spot.lng}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-teal-600 hover:underline dark:text-teal-400">
            <i className="ti ti-map-2 text-[13px]" /> Google Maps
          </a>
        </span>
        <span className="flex items-center gap-1.5"><i className="ti ti-calendar" />{new Date(spot.created_at).toLocaleDateString()}</span>
      </div>

      {/* Photos */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">{t("spot_photos")}</h2>
        <PhotoGrid
          photos={spot.photos ?? []}
          uploading={uploading}
          uploadErr={uploadErr}
          onUpload={handlePhotoUpload}
          onDelete={handleDeletePhoto}
          fileInputRef={fileInputRef}
        />
      </div>
    </div>
  );
}

// ── SpotEditor ─────────────────────────────────────────────────────────────────

function SpotEditor({ api, id, trips, categories, onDone, onCancel, t }: {
  api: ReturnType<typeof useApi>;
  id?: string;
  trips: Trip[];
  categories: Category[];
  onDone: (id: string) => void;
  onCancel: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const isEdit = !!id;
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [tripId, setTripId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState(false);

  // Photo state — available after spot is saved (new) or immediately (edit)
  const [savedId, setSavedId] = useState<string | null>(id ?? null);
  const [photos, setPhotos] = useState<SpotPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!id) return;
    api.get<Spot>(`/spots/${id}`).then((s) => {
      setName(s.name); setNote(s.note ?? ""); setLat(s.lat.toFixed(6)); setLng(s.lng.toFixed(6));
      setRating(s.rating); setTripId(s.trip_id ?? ""); setCategoryId(s.category_id ?? "");
      setPhotos(s.photos ?? []);
    }).catch(() => setError(t("error_load")));
  }, [api, id, t]);

  const reloadPhotos = useCallback((spotId: string) => {
    api.get<Spot>(`/spots/${spotId}`).then((s) => setPhotos(s.photos ?? [])).catch(() => {});
  }, [api]);

  const handleGps = () => {
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLat(pos.coords.latitude.toFixed(6)); setLng(pos.coords.longitude.toFixed(6)); },
      () => setError(t("error_location")),
    );
  };

  const handleSave = async () => {
    if (!name.trim()) { setNameErr(true); return; }
    setSaving(true); setError(null);
    try {
      const body = {
        name: name.trim(), note: note.trim() || null,
        lat: parseFloat(lat), lng: parseFloat(lng),
        rating, trip_id: tripId || null, category_id: categoryId || null,
      };
      if (isEdit) {
        await api.mutate("PATCH", `/spots/${id}`, body);
        onDone(id!);
      } else {
        const c = await api.mutate<{ id: string }>("POST", "/spots", body);
        setSavedId(c.id);
        // Stay on editor to allow photo upload — user clicks "Fertig" when done
      }
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !savedId) return;
    setUploading(true); setUploadErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.upload(`/spots/${savedId}/photos`, fd);
      reloadPhotos(savedId);
    } catch (err) {
      setUploadErr(String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDeletePhoto(photoId: string) {
    if (!savedId) return;
    setUploadErr(null);
    try {
      await api.mutate<void>("DELETE", `/spots/${savedId}/photos/${photoId}`);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      reloadPhotos(savedId);
    } catch (err) {
      setUploadErr(String(err));
    }
  }

  // After first save (new spot): show photo section + "Fertig" button
  const showPhotoSection = savedId !== null;

  return (
    <div className="mx-auto max-w-xl overflow-y-auto h-full px-4 py-6">
      <button type="button" onClick={onCancel}
        className="mb-5 flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:text-gray-400">
        <i className="ti ti-arrow-left text-[14px]" /> {t("btn_cancel")}
      </button>
      <h1 className="mb-6 text-2xl font-bold">{isEdit ? t("btn_edit") : t("btn_new_spot")}</h1>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">{error}</div>}

      {/* Form fields — hidden after first save of a new spot */}
      {!showPhotoSection || isEdit ? (
        <div className="space-y-5">
          <div>
            <label className={labelCls}>{t("spot_name")} *</label>
            <input type="text" value={name} onChange={(e) => { setName(e.target.value); setNameErr(false); }}
              placeholder={t("spot_name_placeholder")} className={`${inputCls} ${nameErr ? "border-red-400" : ""}`}
              style={{ fontSize: "16px" }} autoFocus />
            {nameErr && <p className="mt-1 text-sm text-red-500">{t("spot_name_required")}</p>}
          </div>
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
          <div>
            <label className={labelCls}>{t("spot_rating")}</label>
            <div className="flex items-center gap-3">
              <Stars value={rating} onChange={setRating} />
              {rating && <button type="button" onClick={() => setRating(null)} className="text-sm text-gray-400 hover:text-gray-600">×</button>}
            </div>
          </div>
          <div>
            <label className={labelCls}>{t("spot_note")}</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("spot_note_placeholder")}
              className={inputCls} rows={4} style={{ fontSize: "16px" }} />
          </div>
          <div>
            <label className={labelCls}>{t("spot_location")}</label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="Lat" className={inputCls} style={{ fontSize: "16px" }} />
              <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="Lng" className={inputCls} style={{ fontSize: "16px" }} />
            </div>
            <button type="button" onClick={handleGps} className={btnSecondary}>
              <i className="ti ti-current-location text-[13px]" /> {t("btn_use_gps")}
            </button>
            <p className="mt-1.5 text-sm text-gray-400">{t("spot_location_hint")}</p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onCancel} className={btnSecondary}>{t("btn_cancel")}</button>
            <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary}>
              {saving
                ? <><i className="ti ti-loader-2 animate-spin text-[13px]" /> {t("saving")}</>
                : isEdit ? t("btn_save") : t("btn_save_and_add_photos")}
            </button>
          </div>
        </div>
      ) : null}

      {/* Photo section — shown after new spot is saved */}
      {showPhotoSection && !isEdit && (
        <div className="space-y-5">
          <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
            <i className="ti ti-check mr-1.5" />{t("spot_saved_add_photos")}
          </div>
          <div>
            <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">{t("spot_photos")}</h2>
            <PhotoGrid
              photos={photos}
              uploading={uploading}
              uploadErr={uploadErr}
              onUpload={handlePhotoUpload}
              onDelete={handleDeletePhoto}
              fileInputRef={fileInputRef}
            />
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={() => onDone(savedId!)} className={btnPrimary}>
              <i className="ti ti-check text-[13px]" /> {t("btn_done")}
            </button>
          </div>
        </div>
      )}
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
      cancelEdit(); onReload();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="mx-auto max-w-lg overflow-y-auto h-full px-4 py-6">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-xl font-bold">{t("nav_trips")}</h2>
        {editingId === null && (
          <button type="button" onClick={startNew} className={btnPrimary}>
            <i className="ti ti-plus text-[13px]" /> {t("btn_new_trip")}
          </button>
        )}
      </div>
      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">{error}</div>}
      {editingId !== null && (
        <div className="mb-4 rounded-2xl border border-teal-200 bg-teal-50 p-4 dark:border-teal-800 dark:bg-teal-950 space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("trip_name_placeholder")}
            className={inputCls} style={{ fontSize: "16px" }} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancelEdit(); }} />
          <div className="grid grid-cols-3 gap-2">
            <input value={year} onChange={(e) => setYear(e.target.value)} placeholder={t("trip_year")} type="number" className={inputCls} style={{ fontSize: "16px" }} />
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("trip_description_placeholder")} className={`${inputCls} col-span-2`} style={{ fontSize: "16px" }} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={cancelEdit} className={btnSecondary}>{t("btn_cancel")}</button>
            <button type="button" onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-check text-[13px]" />} {t("btn_save")}
            </button>
          </div>
        </div>
      )}
      {trips.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
          <i className="ti ti-route text-[36px] text-gray-300 dark:text-gray-700 block mb-2" />
          <p className="text-sm text-gray-400">{t("no_trips")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {trips.map((tr) => (
            <div key={tr.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3.5 dark:border-gray-800">
              <div className="flex-1 min-w-0">
                <span className="font-medium">{tr.name}</span>
                {tr.year && <span className="ml-2 text-sm text-gray-400">{tr.year}</span>}
                {tr.description && <p className="text-sm text-gray-500 truncate mt-0.5">{tr.description}</p>}
              </div>
              <button type="button" onClick={() => startEdit(tr)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
                <i className="ti ti-pencil text-[15px]" />
              </button>
              <button type="button" onClick={async () => { if (!window.confirm(t("trip_delete_confirm"))) return; await api.mutate("DELETE", `/trips/${tr.id}`); onReload(); }}
                className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
                <i className="ti ti-trash text-[15px]" />
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
      cancelEdit(); onReload();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="mx-auto max-w-lg overflow-y-auto h-full px-4 py-6">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-xl font-bold">{t("nav_categories")}</h2>
        {editingId === null && (
          <button type="button" onClick={startNew} className={btnPrimary}>
            <i className="ti ti-plus text-[13px]" /> {t("btn_new_category")}
          </button>
        )}
      </div>
      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">{error}</div>}
      {editingId !== null && (
        <div className="mb-4 rounded-2xl border border-teal-200 bg-teal-50 p-4 dark:border-teal-800 dark:bg-teal-950 space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("category_name_placeholder")}
            className={inputCls} style={{ fontSize: "16px" }} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancelEdit(); }} />
          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-600 dark:text-gray-400">{t("category_color")}</label>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-16 cursor-pointer rounded border border-gray-300 p-1 dark:border-gray-700" />
            <span className="text-sm text-gray-500 font-mono">{color}</span>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={cancelEdit} className={btnSecondary}>{t("btn_cancel")}</button>
            <button type="button" onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? <i className="ti ti-loader-2 animate-spin text-[13px]" /> : <i className="ti ti-check text-[13px]" />} {t("btn_save")}
            </button>
          </div>
        </div>
      )}
      {categories.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
          <i className="ti ti-tag text-[36px] text-gray-300 dark:text-gray-700 block mb-2" />
          <p className="text-sm text-gray-400">{t("no_categories")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {categories.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3.5 dark:border-gray-800">
              <span className="w-5 h-5 rounded-full flex-shrink-0" style={{ background: c.color }} />
              <span className="flex-1 font-medium">{c.name}</span>
              {c.created_by !== "system" && (
                <>
                  <button type="button" onClick={() => startEdit(c)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
                    <i className="ti ti-pencil text-[15px]" />
                  </button>
                  <button type="button" onClick={async () => { if (!window.confirm(t("category_delete_confirm"))) return; await api.mutate("DELETE", `/categories/${c.id}`); onReload(); }}
                    className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
                    <i className="ti ti-trash text-[15px]" />
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
  const [removing, setRemoving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    api.get<{ map_configured: boolean; map_style_url: string | null }>("/config")
      .then((cfg) => setConfigured(cfg.map_configured))
      .catch(() => setConfigured(false));
  }, [api]);

  const save = async () => {
    if (!key.trim()) return;
    setSaving(true); setMsg(null);
    try {
      await api.mutate("PUT", "/settings", { maptiler_api_key: key.trim() });
      const cfg = await api.get<{ map_configured: boolean; map_style_url: string | null }>("/config");
      setConfigured(cfg.map_configured);
      onSaved(cfg.map_style_url);
      setKey("");
      setMsg({ ok: true, text: t("settings_saved") });
    } catch {
      setMsg({ ok: false, text: t("error_save") });
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!window.confirm(t("settings_remove_confirm"))) return;
    setRemoving(true); setMsg(null);
    try {
      await api.mutate("PUT", "/settings", { maptiler_api_key: "" });
      setConfigured(false);
      onSaved(null);
      setMsg({ ok: true, text: t("settings_removed") });
    } catch {
      setMsg({ ok: false, text: t("error_save") });
    } finally { setRemoving(false); }
  };

  return (
    <div className="mx-auto max-w-md overflow-y-auto h-full px-4 py-6">
      <h2 className="mb-1 flex items-center gap-2 text-xl font-bold">
        {t("settings_title")}
        {configured !== null && (
          <span className="flex items-center gap-1.5 text-sm font-normal text-gray-500 dark:text-gray-400">
            <span className={`h-2 w-2 rounded-full ${configured ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} />
            {configured ? t("settings_key_active_short") : t("settings_key_missing_short")}
          </span>
        )}
      </h2>
      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">{t("settings_subtitle")}</p>

      {msg && (
        <p className={`mb-4 text-sm ${msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
          {msg.text}
        </p>
      )}

      <div className="space-y-4">
        <div>
          <label className={labelCls}>{t("settings_maptiler_key")}</label>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={configured ? t("settings_key_replace_placeholder") : t("settings_maptiler_key_placeholder")}
            className={inputCls} style={{ fontSize: "16px" }}
            onKeyDown={(e) => e.key === "Enter" && save()} />
          <p className="mt-1.5 text-sm text-gray-400">
            {t("settings_maptiler_hint")} — <a href="https://maptiler.com" target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline">maptiler.com</a>
          </p>
        </div>
        <div className="flex gap-3">
          <button type="button" onClick={save} disabled={saving || !key.trim()} className={`flex-1 ${btnPrimary}`}>
            {saving ? <><i className="ti ti-loader-2 animate-spin text-[13px]" /> {t("saving")}</> : t("btn_save")}
          </button>
          {configured && (
            <button type="button" onClick={remove} disabled={removing} className={`flex-1 ${btnDanger}`}>
              {removing ? <><i className="ti ti-loader-2 animate-spin text-[13px]" /> {t("saving")}</> : t("settings_remove_key")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
