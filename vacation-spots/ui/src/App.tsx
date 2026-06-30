/**
 * Vacation Spots module — React frontend v0.1.0
 *
 * Views:
 *   map        — full-screen MapLibre GL map with spot markers
 *   trips      — list + create/edit/delete trips
 *   categories — list + create/edit/delete categories
 *   settings   — Maptiler API key entry
 *
 * Spot interaction:
 *   - Hover marker  → popup (name, category, rating, note snippet)
 *   - Click marker  → detail panel (slide-in right)
 *   - Click map     → open "new spot" modal with pre-filled coordinates
 *   - [+] button    → open "new spot" modal (coordinates via GPS or map click)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ModuleComponentProps } from "./types";

// i18next namespace registered by ModulePage host before bundle mount
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
  photos?: SpotPhoto[];
  created_by: string;
  created_at: string;
}

interface SpotPhoto {
  id: string;
  file_path: string;
  position: number;
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

type View = "map" | "trips" | "categories" | "settings";

// ── API helper ─────────────────────────────────────────────────────────────────

function useApi(apiBase: string, token: string) {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;

  const get = useCallback(async <T,>(path: string): Promise<T> => {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }, [base, token]);

  const mutate = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (r.status === 204) return undefined as T;
    return r.json();
  }, [base, token]);

  return { get, mutate };
}

// ── Star rating display ────────────────────────────────────────────────────────

function Stars({ value, onChange }: { value: number | null; onChange?: (v: number) => void }) {
  return (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          onClick={() => onChange?.(n)}
          style={{
            fontSize: 20,
            cursor: onChange ? "pointer" : "default",
            color: value && n <= value ? "#EF9F27" : "#ccc",
            lineHeight: 1,
          }}
        >★</span>
      ))}
    </span>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────

export default function App({ apiBase, token }: ModuleComponentProps) {
  const { t } = useTranslation(NS);
  const api = useApi(apiBase, token);

  const [view, setView] = useState<View>("map");
  const [spots, setSpots] = useState<Spot[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [maptilerKey, setMaptilerKey] = useState<string>(() => localStorage.getItem("vs_maptiler_key") ?? "");

  const [filterTrip, setFilterTrip] = useState<string>("");
  const [filterCategory, setFilterCategory] = useState<string>("");

  const [selectedSpot, setSelectedSpot] = useState<Spot | null>(null);
  const [showSpotModal, setShowSpotModal] = useState(false);
  const [newSpotCoords, setNewSpotCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [editingSpot, setEditingSpot] = useState<Spot | null>(null);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  // Load data
  const loadAll = useCallback(async () => {
    const [s, tr, cat] = await Promise.all([
      api.get<Spot[]>(`/spots${filterTrip ? `?trip=${filterTrip}` : filterCategory ? `?category=${filterCategory}` : ""}`),
      api.get<Trip[]>("/trips"),
      api.get<Category[]>("/categories"),
    ]);
    setSpots(s);
    setTrips(tr);
    setCategories(cat);
  }, [api, filterTrip, filterCategory]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Map setup ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (view !== "map" || !mapContainerRef.current || !maptilerKey) return;
    if (mapRef.current) return; // already initialized

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${maptilerKey}`,
      center: [13, 48],
      zoom: 4,
    });

    map.addControl(new maplibregl.NavigationControl(), "bottom-right");

    map.on("click", (e) => {
      setNewSpotCoords({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      setEditingSpot(null);
      setShowSpotModal(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [view, maptilerKey]);

  // ── Markers ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || view !== "map") return;

    // Remove old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    spots.forEach((spot) => {
      const color = spot.category_color ?? "#888780";

      // Custom marker element
      const el = document.createElement("div");
      el.style.cssText = `
        width: 28px; height: 28px; border-radius: 50%;
        background: ${color}; border: 2px solid white;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      `;
      el.innerHTML = `<i class="ti ${spot.category_icon ?? "ti-map-pin"}" style="font-size:14px;color:white;"></i>`;

      // Popup on hover
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 16,
        maxWidth: "220px",
      }).setHTML(`
        <div style="font-family:sans-serif;padding:4px;">
          <div style="font-weight:500;font-size:13px;margin-bottom:4px;">${spot.name}</div>
          ${spot.category_name ? `<span style="font-size:11px;background:${color}22;color:${color};padding:2px 6px;border-radius:4px;">${spot.category_name}</span>` : ""}
          ${spot.rating ? `<div style="color:#EF9F27;font-size:13px;margin-top:4px;">${"★".repeat(spot.rating)}${"☆".repeat(5 - spot.rating)}</div>` : ""}
          ${spot.note ? `<div style="font-size:12px;color:#666;margin-top:4px;">${spot.note.slice(0, 80)}${spot.note.length > 80 ? "…" : ""}</div>` : ""}
        </div>
      `);

      el.addEventListener("mouseenter", () => popup.addTo(map));
      el.addEventListener("mouseleave", () => popup.remove());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        setSelectedSpot(spot);
      });

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([spot.lng, spot.lat])
        .addTo(map);

      markersRef.current.push(marker);
    });
  }, [spots, view]);

  // ── Spot save ────────────────────────────────────────────────────────────────

  const handleSaveSpot = useCallback(async (input: SpotFormData) => {
    if (editingSpot) {
      await api.mutate("PATCH", `/spots/${editingSpot.id}`, input);
    } else {
      await api.mutate("POST", "/spots", input);
    }
    setShowSpotModal(false);
    setEditingSpot(null);
    setNewSpotCoords(null);
    await loadAll();
  }, [api, editingSpot, loadAll]);

  const handleDeleteSpot = useCallback(async (id: string) => {
    if (!confirm(t("spot_delete_confirm"))) return;
    await api.mutate("DELETE", `/spots/${id}`);
    setSelectedSpot(null);
    await loadAll();
  }, [api, t, loadAll]);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "var(--font-sans, sans-serif)" }}>
      {/* Top nav */}
      <nav style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "0 16px", height: 48, borderBottom: "0.5px solid var(--border)",
        background: "var(--surface-2)", flexShrink: 0,
      }}>
        <i className="ti ti-map-pin" style={{ fontSize: 18, color: "var(--text-accent)", marginRight: 6 }} />
        <span style={{ fontWeight: 500, fontSize: 15, marginRight: 16 }}>Vacation Spots</span>
        {(["map", "trips", "categories", "settings"] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              padding: "4px 12px", fontSize: 13, border: "none", background: "none",
              borderRadius: "var(--radius)", cursor: "pointer",
              color: view === v ? "var(--text-accent)" : "var(--text-secondary)",
              fontWeight: view === v ? 500 : 400,
              borderBottom: view === v ? "2px solid var(--border-accent)" : "2px solid transparent",
            }}
          >
            {t(`nav_${v}`)}
          </button>
        ))}
        {view === "map" && (
          <button
            onClick={() => { setEditingSpot(null); setNewSpotCoords(null); setShowSpotModal(true); }}
            style={{
              marginLeft: "auto", padding: "4px 12px", fontSize: 13,
              border: "0.5px solid var(--border-strong)", borderRadius: "var(--radius)",
              background: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
            }}
          >
            <i className="ti ti-plus" style={{ fontSize: 14 }} /> {t("btn_new_spot")}
          </button>
        )}
      </nav>

      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>

        {/* MAP VIEW */}
        {view === "map" && (
          <div style={{ display: "flex", height: "100%" }}>
            {/* Filter sidebar */}
            <div style={{
              width: 200, borderRight: "0.5px solid var(--border)", padding: 12,
              display: "flex", flexDirection: "column", gap: 12, overflowY: "auto",
              background: "var(--surface-2)", flexShrink: 0,
            }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                  {t("nav_trips")}
                </label>
                <select
                  value={filterTrip}
                  onChange={(e) => { setFilterTrip(e.target.value); setFilterCategory(""); }}
                  style={{ width: "100%", fontSize: 13 }}
                >
                  <option value="">{t("all_trips")}</option>
                  {trips.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                  {t("nav_categories")}
                </label>
                <select
                  value={filterCategory}
                  onChange={(e) => { setFilterCategory(e.target.value); setFilterTrip(""); }}
                  style={{ width: "100%", fontSize: 13 }}
                >
                  <option value="">{t("all_categories")}</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div style={{ marginTop: "auto", fontSize: 12, color: "var(--text-muted)" }}>
                {spots.length} spot{spots.length !== 1 ? "s" : ""}
              </div>
            </div>

            {/* Map container */}
            <div style={{ flex: 1, position: "relative" }}>
              {!maptilerKey ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-secondary)", fontSize: 14, textAlign: "center", padding: 32 }}>
                  <div>
                    <i className="ti ti-key" style={{ fontSize: 32, display: "block", marginBottom: 12 }} />
                    {t("error_no_key")}
                    <br />
                    <button onClick={() => setView("settings")} style={{ marginTop: 12, padding: "6px 14px", fontSize: 13, border: "0.5px solid var(--border-strong)", borderRadius: "var(--radius)", background: "none", cursor: "pointer" }}>
                      {t("nav_settings")}
                    </button>
                  </div>
                </div>
              ) : (
                <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
              )}
            </div>

            {/* Spot form panel (new / edit) */}
            {showSpotModal && (
              <div style={{
                width: 320, borderLeft: "0.5px solid var(--border)", background: "var(--surface-2)",
                display: "flex", flexDirection: "column", overflowY: "auto", flexShrink: 0,
              }}>
                <SpotForm
                  spot={editingSpot}
                  initialCoords={newSpotCoords}
                  trips={trips}
                  categories={categories}
                  onSave={handleSaveSpot}
                  onClose={() => { setShowSpotModal(false); setEditingSpot(null); setNewSpotCoords(null); }}
                  t={t}
                />
              </div>
            )}

            {/* Detail panel */}
            {selectedSpot && !showSpotModal && (
              <div style={{
                width: 280, borderLeft: "0.5px solid var(--border)", background: "var(--surface-2)",
                display: "flex", flexDirection: "column", overflowY: "auto",
              }}>
                <SpotDetail
                  spot={selectedSpot}
                  onClose={() => setSelectedSpot(null)}
                  onEdit={() => { setEditingSpot(selectedSpot); setShowSpotModal(true); }}
                  onDelete={() => handleDeleteSpot(selectedSpot.id)}
                  apiBase={apiBase}
                  token={token}
                  t={t}
                />
              </div>
            )}
          </div>
        )}

        {/* TRIPS VIEW */}
        {view === "trips" && (
          <TripsView trips={trips} api={api} onReload={loadAll} t={t} />
        )}

        {/* CATEGORIES VIEW */}
        {view === "categories" && (
          <CategoriesView categories={categories} api={api} onReload={loadAll} t={t} />
        )}

        {/* SETTINGS VIEW */}
        {view === "settings" && (
          <SettingsView
            maptilerKey={maptilerKey}
            onSave={(key) => {
              setMaptilerKey(key);
              localStorage.setItem("vs_maptiler_key", key);
            }}
            t={t}
          />
        )}
      </div>

    </div>
  );
}

// ── Spot detail panel ──────────────────────────────────────────────────────────

function SpotDetail({ spot, onClose, onEdit, onDelete, apiBase, token, t }: {
  spot: Spot;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  apiBase: string;
  token: string;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "14px 16px 10px", borderBottom: "0.5px solid var(--border)" }}>
        <div>
          <p style={{ fontWeight: 500, fontSize: 15, margin: "0 0 4px" }}>{spot.name}</p>
          {spot.category_name && (
            <span style={{
              fontSize: 11, padding: "2px 6px", borderRadius: 4,
              background: (spot.category_color ?? "#888") + "22",
              color: spot.category_color ?? "#888",
            }}>{spot.category_name}</span>
          )}
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 18, padding: 2 }}>
          <i className="ti ti-x" />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {spot.rating && <Stars value={spot.rating} />}

        {/* Photos */}
        {spot.photo_paths?.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {spot.photo_paths.map((p, i) => (
              <img
                key={i}
                src={`${base}/storage/${p}`}
                alt=""
                style={{ width: 72, height: 60, objectFit: "cover", borderRadius: 4 }}
              />
            ))}
          </div>
        )}

        {spot.note && (
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>{spot.note}</p>
        )}

        <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 4 }}>
          {spot.trip_name && (
            <span><i className="ti ti-route" style={{ fontSize: 13, marginRight: 5 }} />{spot.trip_name}</span>
          )}
          <span><i className="ti ti-map-pin" style={{ fontSize: 13, marginRight: 5 }} />{spot.lat.toFixed(5)}, {spot.lng.toFixed(5)}</span>
          <span><i className="ti ti-calendar" style={{ fontSize: 13, marginRight: 5 }} />{new Date(spot.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ padding: "10px 16px", borderTop: "0.5px solid var(--border)", display: "flex", gap: 8 }}>
        <button onClick={onEdit} style={{ flex: 1, padding: "6px 0", fontSize: 13, border: "0.5px solid var(--border-strong)", borderRadius: "var(--radius)", background: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
          <i className="ti ti-edit" style={{ fontSize: 13 }} /> {t("btn_edit")}
        </button>
        <button onClick={onDelete} style={{ padding: "6px 10px", fontSize: 13, border: "0.5px solid var(--border-danger)", borderRadius: "var(--radius)", background: "none", cursor: "pointer", color: "var(--text-danger)" }}>
          <i className="ti ti-trash" style={{ fontSize: 13 }} />
        </button>
      </div>
    </div>
  );
}

// ── Spot modal (new / edit) ────────────────────────────────────────────────────

interface SpotFormData {
  name: string;
  note: string | null;
  lat: number;
  lng: number;
  rating: number | null;
  trip_id: string | null;
  category_id: string | null;
}

function SpotForm({ spot, initialCoords, trips, categories, onSave, onClose, t }: {
  spot: Spot | null;
  initialCoords: { lat: number; lng: number } | null;
  trips: Trip[];
  categories: Category[];
  onSave: (data: SpotFormData) => Promise<void>;
  onClose: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const [name, setName] = useState(spot?.name ?? "");
  const [note, setNote] = useState(spot?.note ?? "");
  const [lat, setLat] = useState<string>(String(spot?.lat ?? initialCoords?.lat ?? ""));
  const [lng, setLng] = useState<string>(String(spot?.lng ?? initialCoords?.lng ?? ""));
  const [rating, setRating] = useState<number | null>(spot?.rating ?? null);
  const [tripId, setTripId] = useState<string>(spot?.trip_id ?? "");
  const [categoryId, setCategoryId] = useState<string>(spot?.category_id ?? "");
  const [saving, setSaving] = useState(false);
  const [nameErr, setNameErr] = useState(false);

  const handleGps = () => {
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLat(String(pos.coords.latitude)); setLng(String(pos.coords.longitude)); },
      () => alert(t("error_location")),
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setNameErr(true); return; }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        note: note.trim() || null,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        rating,
        trip_id: tripId || null,
        category_id: categoryId || null,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 10px", borderBottom: "0.5px solid var(--border)", flexShrink: 0 }}>
        <span style={{ fontWeight: 500, fontSize: 15 }}>{spot ? t("btn_edit") : t("btn_new_spot")}</span>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--text-muted)", padding: 2 }}>
          <i className="ti ti-x" />
        </button>
      </div>

      {/* Form body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Name */}
        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("spot_name")} *</label>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setNameErr(false); }}
            placeholder={t("spot_name_placeholder")}
            style={{ width: "100%", fontSize: 16, boxSizing: "border-box", borderColor: nameErr ? "var(--border-danger)" : undefined }}
          />
          {nameErr && <span style={{ fontSize: 12, color: "var(--text-danger)" }}>{t("spot_name_required")}</span>}
        </div>

        {/* Trip + Category */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("spot_trip")}</label>
            <select value={tripId} onChange={(e) => setTripId(e.target.value)} style={{ width: "100%", fontSize: 14 }}>
              <option value="">—</option>
              {trips.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("spot_category")}</label>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ width: "100%", fontSize: 14 }}>
              <option value="">—</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        {/* Rating */}
        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("spot_rating")}</label>
          <Stars value={rating} onChange={setRating} />
        </div>

        {/* Note */}
        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("spot_note")}</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("spot_note_placeholder")}
            style={{ width: "100%", height: 72, fontSize: 16, resize: "none", boxSizing: "border-box" }}
          />
        </div>

        {/* Coordinates */}
        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("spot_location")}</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
            <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="Lat" style={{ fontSize: 14 }} />
            <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="Lng" style={{ fontSize: 14 }} />
          </div>
          <button onClick={handleGps} style={{ fontSize: 12, padding: "4px 10px", border: "0.5px solid var(--border-strong)", borderRadius: "var(--radius)", background: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <i className="ti ti-current-location" style={{ fontSize: 13 }} /> {t("btn_use_gps")}
          </button>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0" }}>{t("spot_location_hint")}</p>
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: "10px 16px", borderTop: "0.5px solid var(--border)", flexShrink: 0 }}>
        <button
          onClick={handleSubmit}
          disabled={saving}
          style={{ width: "100%", padding: 10, borderRadius: "var(--radius)", border: "none", background: "var(--text-primary)", color: "var(--surface-2)", fontSize: 14, fontWeight: 500, cursor: saving ? "default" : "pointer" }}
        >
          {saving ? t("saving") : t("btn_save")}
        </button>
      </div>
    </div>
  );
}

// ── Trips view ─────────────────────────────────────────────────────────────────

function TripsView({ trips, api, onReload, t }: {
  trips: Trip[];
  api: ReturnType<typeof useApi>;
  onReload: () => void;
  t: (k: string) => string;
}) {
  const [name, setName] = useState("");
  const [year, setYear] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const reset = () => { setName(""); setYear(""); setDesc(""); setEditId(null); };

  const startEdit = (tr: Trip) => { setEditId(tr.id); setName(tr.name); setYear(String(tr.year ?? "")); setDesc(tr.description); };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body = { name: name.trim(), year: year ? parseInt(year) : null, description: desc };
      if (editId) await api.mutate("PATCH", `/trips/${editId}`, body);
      else await api.mutate("POST", "/trips", body);
      reset(); onReload();
    } finally { setSaving(false); }
  };

  const del = async (id: string) => {
    if (!confirm(t("trip_delete_confirm"))) return;
    await api.mutate("DELETE", `/trips/${id}`);
    onReload();
  };

  return (
    <div style={{ padding: 24, maxWidth: 560 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 16px" }}>{t("nav_trips")}</h2>

      {/* Form */}
      <div style={{ background: "var(--surface-2)", border: "0.5px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("trip_name_placeholder")} style={{ fontSize: 16 }} />
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8 }}>
          <input value={year} onChange={(e) => setYear(e.target.value)} placeholder={t("trip_year")} type="number" style={{ fontSize: 14 }} />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("trip_description_placeholder")} style={{ fontSize: 14 }} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ padding: "6px 14px", fontSize: 13, border: "0.5px solid var(--border-strong)", borderRadius: "var(--radius)", background: "none", cursor: "pointer" }}>
            {saving ? t("saving") : editId ? t("btn_save") : t("btn_new_trip")}
          </button>
          {editId && <button onClick={reset} style={{ padding: "6px 14px", fontSize: 13, border: "0.5px solid var(--border)", borderRadius: "var(--radius)", background: "none", cursor: "pointer" }}>{t("btn_cancel")}</button>}
        </div>
      </div>

      {/* List */}
      {trips.length === 0
        ? <p style={{ color: "var(--text-muted)", fontSize: 14 }}>{t("no_trips")}</p>
        : trips.map((tr) => (
          <div key={tr.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "0.5px solid var(--border)" }}>
            <div>
              <span style={{ fontWeight: 500, fontSize: 14 }}>{tr.name}</span>
              {tr.year && <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>{tr.year}</span>}
              {tr.description && <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "2px 0 0" }}>{tr.description}</p>}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => startEdit(tr)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", fontSize: 16 }}><i className="ti ti-edit" /></button>
              <button onClick={() => del(tr.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-danger)", fontSize: 16 }}><i className="ti ti-trash" /></button>
            </div>
          </div>
        ))
      }
    </div>
  );
}

// ── Categories view ────────────────────────────────────────────────────────────

function CategoriesView({ categories, api, onReload, t }: {
  categories: Category[];
  api: ReturnType<typeof useApi>;
  onReload: () => void;
  t: (k: string) => string;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#888780");
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const reset = () => { setName(""); setColor("#888780"); setEditId(null); };

  const startEdit = (c: Category) => { setEditId(c.id); setName(c.name); setColor(c.color); };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body = { name: name.trim(), color };
      if (editId) await api.mutate("PATCH", `/categories/${editId}`, body);
      else await api.mutate("POST", "/categories", body);
      reset(); onReload();
    } finally { setSaving(false); }
  };

  const del = async (id: string) => {
    if (!confirm(t("category_delete_confirm"))) return;
    await api.mutate("DELETE", `/categories/${id}`);
    onReload();
  };

  return (
    <div style={{ padding: 24, maxWidth: 480 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 16px" }}>{t("nav_categories")}</h2>

      <div style={{ background: "var(--surface-2)", border: "0.5px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("category_name_placeholder")} style={{ fontSize: 16 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("category_color")}</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 40, height: 32, padding: 2, border: "0.5px solid var(--border)", borderRadius: "var(--radius)", cursor: "pointer" }} />
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{color}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ padding: "6px 14px", fontSize: 13, border: "0.5px solid var(--border-strong)", borderRadius: "var(--radius)", background: "none", cursor: "pointer" }}>
            {saving ? t("saving") : editId ? t("btn_save") : t("btn_new_category")}
          </button>
          {editId && <button onClick={reset} style={{ padding: "6px 14px", fontSize: 13, border: "0.5px solid var(--border)", borderRadius: "var(--radius)", background: "none", cursor: "pointer" }}>{t("btn_cancel")}</button>}
        </div>
      </div>

      {categories.length === 0
        ? <p style={{ color: "var(--text-muted)", fontSize: 14 }}>{t("no_categories")}</p>
        : categories.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "0.5px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 14, height: 14, borderRadius: "50%", background: c.color, display: "inline-block", flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{c.name}</span>
            </div>
            {c.created_by !== "system" && (
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => startEdit(c)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", fontSize: 16 }}><i className="ti ti-edit" /></button>
                <button onClick={() => del(c.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-danger)", fontSize: 16 }}><i className="ti ti-trash" /></button>
              </div>
            )}
          </div>
        ))
      }
    </div>
  );
}

// ── Settings view ──────────────────────────────────────────────────────────────

function SettingsView({ maptilerKey, onSave, t }: {
  maptilerKey: string;
  onSave: (key: string) => void;
  t: (k: string) => string;
}) {
  const [key, setKey] = useState(maptilerKey);
  const [saved, setSaved] = useState(false);

  const save = () => {
    onSave(key.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ padding: 24, maxWidth: 480 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 20px" }}>{t("settings_title")}</h2>
      <div style={{ background: "var(--surface-2)", border: "0.5px solid var(--border)", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ fontSize: 13, fontWeight: 500 }}>{t("settings_maptiler_key")}</label>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("settings_maptiler_key_placeholder")}
          style={{ fontSize: 16, fontFamily: "var(--font-mono, monospace)" }}
        />
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
          {t("settings_maptiler_hint")} —{" "}
          <a href="https://maptiler.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-accent)" }}>maptiler.com</a>
        </p>
        <button onClick={save} style={{ padding: "8px 16px", fontSize: 14, border: "0.5px solid var(--border-strong)", borderRadius: "var(--radius)", background: "none", cursor: "pointer", alignSelf: "flex-start" }}>
          {saved ? t("settings_saved") : t("btn_save")}
        </button>
      </div>
    </div>
  );
}
