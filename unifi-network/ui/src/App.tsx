/**
 * unifi-network module — React frontend v0.1.0
 *
 * Layout/style conventions follow modulab-modules/recipes/ui/src/App.tsx:
 * Tabler icons, teal accent color, rounded-2xl cards, dark: variants,
 * explicit 16px font-size on inputs (iOS zoom prevention), useApi hook
 * pattern (get/mutate), no router — internal View union type instead.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ModuleComponentProps } from "./types";

// ── Types (mirror handlers/types.ts backend shapes, frontend view models) ───

type GatewayStatus = "online" | "offline" | "config_error" | "paused" | "unknown";

interface Gateway {
  id: string;
  name: string;
  base_url: string;
  status: GatewayStatus;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_error: string | null;
  created_by: string;
  created_at: string;
}

interface DeviceGatewayView {
  gateway_id: string;
  gateway_name: string;
  last_seen_at: string | null;
  // Ergänzt 2026-07-01: Notiz-Diskrepanz-Mechanismus (Nachfolger des
  // entfernten Namensdiskrepanz-Mechanismus, jetzt für "note" statt "name").
  note_discrepancy: boolean;
  gateway_note: string | null;
  provisioning_status: "ok" | "vlan_not_found" | "error";
  provisioning_error: string | null;
}

// Set on an active device when a non-Admin has requested an edit/delete/
// gateway change that needs Admin approval (Nutzerentscheidung 2026-07-05,
// Migration 0006). Null while no request is outstanding.
type PendingAction = "edit" | "delete" | "gateway_change" | null;

interface Device {
  id: string;
  note: string;
  mac: string;
  target_vlan_name: string;
  gateways: DeviceGatewayView[];
  pending_action: PendingAction;
}

interface PendingDevice {
  id: string;
  note: string;
  mac: string;
  target_vlan_name: string;
  target_gateway_names: string[];
  created_by: string;
  created_at: string;
}

// One row of GET /devices/pending-changes (Admin only).
interface PendingDeviceChange {
  id: string;
  note: string;
  mac: string;
  pending_action: Exclude<PendingAction, null>;
  pending_note?: string;
  pending_target_vlan_name?: string;
  pending_target_gateway_names?: string[];
  requested_by: string;
  requested_at: string;
}

interface VlanOption {
  vlan_name: string;
}

type View =
  | { type: "overview" }
  | { type: "onboard" }
  | { type: "pending" }
  | { type: "pending-changes" }
  | { type: "gateways" }
  | { type: "info" };

// ── API helper (same pattern as recipes module) ──────────────────────────────

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
    [base, token],
  );

  return { get, mutate };
}

// ── Root component ────────────────────────────────────────────────────────────

const NS = "mod_unifi-network";

// Maps the ?view= query param (see initialQuery on ModuleComponentProps) to
// a View. Only accepts known View.type values — anything else (missing
// param, typo, future param this version doesn't recognize yet) falls back
// to "overview", the same default as before this deep-link mechanism
// existed. Kept as an explicit allowlist rather than `{ type: raw } as View`
// so an unrecognized value can never produce an invalid View at runtime.
function viewFromQuery(query: URLSearchParams | undefined): View {
  const raw = query?.get("view");
  if (
    raw === "pending" ||
    raw === "pending-changes" ||
    raw === "onboard" ||
    raw === "gateways" ||
    raw === "info"
  ) {
    return { type: raw };
  }
  return { type: "overview" };
}

export default function UnifiNetworkApp({ moduleName, apiBase, token, initialQuery }: ModuleComponentProps) {
  const { t } = useTranslation(NS);
  // Deep-link support (added 2026-07-04): a notification's actionPath (e.g.
  // "/modules/unifi-network?view=pending") should open directly on the
  // relevant tab instead of always landing on the overview — reported as a
  // gap where clicking "review" on a device-approval notification never
  // even reached this module, let alone the right tab inside it. Only reads
  // initialQuery once, on mount (useState initializer) — the query string
  // is a one-time entry point, not something this component should keep
  // re-syncing to if the admin then navigates within the module themselves.
  const [view, setView] = useState<View>(() => viewFromQuery(initialQuery));
  const api = useApi(apiBase, token);
  const [pendingCount, setPendingCount] = useState(0);
  // pendingChangesCount (ergänzt 2026-07-05): /devices/pending-changes is
  // Admin-only (403 for everyone else) — same as /gateways, this module's
  // frontend has no way to know the caller's role up front (see
  // ModuleComponentProps, no roles field), so it just tries the call and
  // silently keeps the badge at 0 on failure, exactly like refreshPendingCount
  // above already does. A non-Admin simply never sees this badge.
  const [pendingChangesCount, setPendingChangesCount] = useState(0);
  // isAdmin (ergänzt 2026-07-05, Nutzerentscheidung): the Gateways tab and
  // Pending-changes tab must be fully hidden from non-Admins, not just have
  // their mutating actions rejected server-side. Since ModuleComponentProps
  // carries no role information, admin status is inferred client-side from
  // whether the Admin-only /devices/pending-changes probe succeeds — the
  // same call refreshPendingChangesCount() already makes for the badge.
  // null = not yet known (probe still in flight); both tabs stay hidden
  // during that brief window rather than flashing visible for everyone.
  // A transient network error also resolves to false (hidden) rather than
  // true — for a UI-only visibility gate (the backend enforces the real
  // permission check regardless), that is the safer default: it can at
  // worst hide an Admin's own tabs until they reload, never show them to a
  // non-Admin.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const refreshPendingCount = useCallback(() => {
    api
      .get<PendingDevice[]>("/devices/pending")
      .then((rows) => setPendingCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => {});
  }, [api]);

  const refreshPendingChangesCount = useCallback(() => {
    api
      .get<PendingDeviceChange[]>("/devices/pending-changes")
      .then((rows) => {
        setPendingChangesCount(Array.isArray(rows) ? rows.length : 0);
        setIsAdmin(true);
      })
      .catch(() => setIsAdmin(false));
  }, [api]);

  useEffect(() => {
    refreshPendingCount();
    refreshPendingChangesCount();
  }, [refreshPendingCount, refreshPendingChangesCount]);

  // Guards against a stale deep-link (e.g. an old notification's actionPath,
  // or a bookmarked ?view=gateways URL) landing a non-Admin on a tab that's
  // about to disappear from the nav — bounces back to overview once the
  // Admin probe above resolves to false. Does nothing while isAdmin is still
  // null (probe in flight) or true (nothing to guard against).
  useEffect(() => {
    if (
      isAdmin === false &&
      (view.type === "gateways" || view.type === "pending-changes" || view.type === "pending")
    ) {
      setView({ type: "overview" });
    }
  }, [isAdmin, view.type]);

  return (
    <div className="unifi-network-module">
      {/* Navigation bar — scrollable on mobile */}
      <div className="mb-4 flex items-center gap-1 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => setView({ type: "overview" })}
          className={navCls(view.type === "overview")}
          title={t("nav_overview")}
        >
          <i className="ti ti-router text-[15px]" />
          <span className="hidden sm:inline">{t("nav_overview")}</span>
        </button>
        {/* Bugfix (2026-07-05): listPendingDevices() has always been
            Admin-only server-side (Entscheidungsvorlage 4.7, "if
            (!isAdmin(auth)) return forbidden();") — this tab was just never
            hidden client-side, the same gap Gateways/Pending-changes had
            until earlier today. Gated on isAdmin exactly like those two. */}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setView({ type: "pending" })}
            className={navCls(view.type === "pending") + " relative"}
            title={t("nav_pending")}
          >
            <i className="ti ti-clock-hour-4 text-[15px]" />
            <span className="hidden sm:inline">{t("nav_pending")}</span>
            {pendingCount > 0 && (
              // min-w-[16px] ist eine Tailwind-Arbitrary-Value-Klasse, die wie
              // h-[14px]/w-[14px] oben (2026-07-02) nicht im Core-Whitelist ist
              // und beim Purge entfernt wird — per Inline-Style statt
              // Utility-Klasse gesetzt.
              <span
                className="ml-0.5 inline-flex h-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white"
                style={{ minWidth: "16px" }}
              >
                {pendingCount}
              </span>
            )}
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setView({ type: "pending-changes" })}
            className={navCls(view.type === "pending-changes") + " relative"}
            title={t("nav_pending_changes")}
          >
            <i className="ti ti-git-pull-request text-[15px]" />
            <span className="hidden sm:inline">{t("nav_pending_changes")}</span>
            {pendingChangesCount > 0 && (
              <span
                className="ml-0.5 inline-flex h-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white"
                style={{ minWidth: "16px" }}
              >
                {pendingChangesCount}
              </span>
            )}
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setView({ type: "gateways" })}
            className={navCls(view.type === "gateways")}
            title={t("nav_gateways")}
          >
            <i className="ti ti-server-2 text-[15px]" />
            <span className="hidden sm:inline">{t("nav_gateways")}</span>
          </button>
        )}
        {/* min-w-[4px] ist ebenfalls eine Arbitrary-Value-Klasse, siehe
            Kommentar beim pendingCount-Badge oben — per Inline-Style gesetzt. */}
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
          onClick={() => setView({ type: "onboard" })}
          className="flex flex-none items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
          title={t("btn_new_device")}
        >
          <i className="ti ti-plus" style={{ fontSize: "14px" }} />
          <span className="hidden sm:inline">{t("btn_new_device")}</span>
        </button>
      </div>

      {view.type === "overview" && <OverviewView api={api} />}
      {view.type === "onboard" && (
        <OnboardingForm api={api} onDone={() => setView({ type: "overview" })} />
      )}
      {view.type === "pending" && isAdmin && (
        <PendingApprovalList api={api} onChanged={refreshPendingCount} />
      )}
      {view.type === "pending-changes" && isAdmin && (
        <PendingChangesList api={api} onChanged={refreshPendingChangesCount} />
      )}
      {view.type === "gateways" && isAdmin && <GatewaysView api={api} />}
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

// ── Gateway status badge ─────────────────────────────────────────────────────

function statusBadge(status: GatewayStatus, t: (k: string) => string) {
  const map: Record<GatewayStatus, { label: string; cls: string; icon: string }> = {
    online: {
      label: t("status_online"),
      cls: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
      icon: "ti-circle-check",
    },
    offline: {
      label: t("status_offline"),
      cls: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
      icon: "ti-plug-connected-x",
    },
    config_error: {
      label: t("status_config_error"),
      cls: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
      icon: "ti-key-off",
    },
    paused: {
      label: t("status_paused"),
      cls: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
      icon: "ti-player-pause",
    },
    unknown: {
      label: t("status_unknown"),
      cls: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
      icon: "ti-help-circle",
    },
  };
  const s = map[status] ?? map.unknown;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      <i className={`ti ${s.icon} text-[12px]`} />
      {s.label}
    </span>
  );
}

// ── Overview: gateway status bar + global RADIUS table ──────────────────────

function OverviewView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [noteDialogDeviceId, setNoteDialogDeviceId] = useState<string | null>(null);
  const [editDeviceId, setEditDeviceId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // infoMessage (ergänzt 2026-07-05): a non-Admin's edit/delete/gateway-change
  // against an active device is now stored as a pending request instead of
  // applied (see requestDeviceChange() in handlers/index.ts) — the mutation
  // still returns 200, so without this the UI would silently look like the
  // change went through. Shown once, teal (not red — nothing failed).
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  // Ergänzt 2026-07-01: Suche (Notiz, MAC) + Filter (VLAN, zugewiesenes
  // Gateway) über die bereits geladene devices-Liste — rein clientseitig,
  // da listDevices() ohnehin schon alle entschlüsselten Felder liefert.
  const [search, setSearch] = useState("");
  const [filterVlan, setFilterVlan] = useState("");
  const [filterGatewayId, setFilterGatewayId] = useState("");
  // Ergänzt 2026-07-01: Sortierung nach Notiz oder VLAN per Klick auf die
  // Spaltenüberschrift (auf-/absteigend/zurücksetzen im Wechsel).
  const [sortKey, setSortKey] = useState<"note" | "vlan" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [gw, dv] = await Promise.all([
        api.get<Gateway[]>("/gateways"),
        api.get<Device[]>("/devices"),
      ]);
      setGateways(Array.isArray(gw) ? gw : []);
      setDevices(Array.isArray(dv) ? dv : []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.mutate("POST", "/gateways/refresh-all");
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [api, load]);

  const refreshOne = useCallback(
    async (gatewayId: string) => {
      await api.mutate("POST", `/gateways/${gatewayId}/refresh`);
      await load();
    },
    [api, load],
  );

  const hasNoteDiscrepancy = (d: Device) => d.gateways.some((g) => g.note_discrepancy);

  const vlanOptions = Array.from(new Set(devices.map((d) => d.target_vlan_name))).sort();
  const gatewayFilterOptions = Array.from(
    new Map(devices.flatMap((d) => d.gateways.map((g) => [g.gateway_id, g.gateway_name] as const))).entries(),
  ).sort((a, b) => a[1].localeCompare(b[1]));

  const filteredDevices = devices.filter((d) => {
    const q = search.trim().toLowerCase();
    if (q && !d.note.toLowerCase().includes(q) && !d.mac.toLowerCase().includes(q)) return false;
    if (filterVlan && d.target_vlan_name !== filterVlan) return false;
    if (filterGatewayId && !d.gateways.some((g) => g.gateway_id === filterGatewayId)) return false;
    return true;
  });

  // Ergänzt 2026-07-01: Sortierung über Notiz/VLAN per Klick auf die
  // Spaltenüberschrift — läuft nach dem Suche/Filter-Schritt auf der bereits
  // gefilterten Liste, damit "sortiert nach gefiltert" konsistent bleibt.
  const sortedDevices = [...filteredDevices].sort((a, b) => {
    if (!sortKey) return 0;
    const av = sortKey === "note" ? a.note : a.target_vlan_name;
    const bv = sortKey === "note" ? b.note : b.target_vlan_name;
    const cmp = av.localeCompare(bv, undefined, { sensitivity: "base" });
    return sortDir === "asc" ? cmp : -cmp;
  });

  const toggleSort = (key: "note" | "vlan") => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(null);
      setSortDir("asc");
    }
  };

  const removeDevice = useCallback(
    async (device: Device) => {
      if (!window.confirm(t("confirm_delete_device", { name: device.note }))) return;
      setDeletingId(device.id);
      setInfoMessage(null);
      try {
        const result = await api.mutate<{ ok: boolean; pending_action?: string }>(
          "DELETE",
          `/devices/${device.id}`,
        );
        if (result?.pending_action) {
          setInfoMessage(t("change_requested_delete", { name: device.note }));
        }
        await load();
      } finally {
        setDeletingId(null);
      }
    },
    [api, load, t],
  );

  return (
    <div>
      {/* Gateway status bar */}
      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t("gateways_heading")}</h2>
          <button
            type="button"
            onClick={refreshAll}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <i className={`ti ti-refresh text-[13px] ${refreshing ? "animate-spin" : ""}`} />
            {t("refresh_all")}
          </button>
        </div>

        {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

        {!loading && gateways.length === 0 && (
          <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-8 text-center dark:border-gray-800">
            <i className="ti ti-server-off text-[32px] text-gray-300 dark:text-gray-700" />
            <p className="mt-2 text-sm text-gray-400">{t("no_gateways")}</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {gateways.map((gw) => (
            <div
              key={gw.id}
              className="rounded-2xl border border-gray-200 p-3 dark:border-gray-800"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{gw.name}</p>
                  <p className="truncate text-xs text-gray-400">{stripHttps(gw.base_url)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => refreshOne(gw.id)}
                  className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-600 dark:hover:bg-gray-800"
                  title={t("refresh_one")}
                >
                  <i className="ti ti-refresh text-[14px]" />
                </button>
              </div>
              <div className="mt-2">{statusBadge(gw.status, t)}</div>
              {gw.status === "paused" && (
                <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">{t("paused_hint")}</p>
              )}
              {gw.last_error && (gw.status === "offline" || gw.status === "config_error") && (
                <p className="mt-1.5 truncate text-[11px] text-red-500" title={gw.last_error}>
                  {gw.last_error}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Global RADIUS table */}
      <div>
        {infoMessage && (
          <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300">
            {infoMessage}
          </div>
        )}
        <h2 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{t("devices_heading")}</h2>

        {devices.length > 0 && (
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {/* max-w-xs ist nicht Teil des Core-Tailwind-Whitelists (Module
                haben keinen eigenen Compiler, siehe Entscheidungsvorlage) und
                wurde beim Purge entfernt — daher hier per Inline-Style
                begrenzt statt per Utility-Klasse. */}
            <div className="relative flex-1" style={{ maxWidth: "20rem" }}>
              {/* Search icon removed entirely per user request (2026-07-04) —
                  previously a Tabler-font icon (rendered as an empty circle
                  for this user, fixed 2026-07-01 with an inline SVG), then
                  the inline SVG itself hit the Tailwind arbitrary-value
                  purge bug (h-[14px]/w-[14px] not in Core's whitelist, fixed
                  2026-07-02 with inline styles) — see git history on this
                  file for both. Rather than carry that fragile icon forward,
                  it's gone; pl-8 (which reserved space for it) is reverted
                  to a plain pr-3-only padding to match. */}
              <input
                type="text"
                name="unifi-network-device-search"
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("search_placeholder")}
                className="w-full rounded-lg border border-gray-300 py-1.5 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
                style={{ fontSize: "16px" }}
              />
            </div>
            <select
              value={filterVlan}
              onChange={(e) => setFilterVlan(e.target.value)}
              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
              style={{ fontSize: "16px" }}
            >
              <option value="">{t("filter_all_vlans")}</option>
              {vlanOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <select
              value={filterGatewayId}
              onChange={(e) => setFilterGatewayId(e.target.value)}
              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
              style={{ fontSize: "16px" }}
            >
              <option value="">{t("filter_all_gateways")}</option>
              {gatewayFilterOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          </div>
        )}

        {!loading && devices.length === 0 && (
          <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
            <i className="ti ti-devices-off text-[36px] text-gray-300 dark:text-gray-700" />
            <p className="mt-3 text-sm text-gray-400">{t("no_devices")}</p>
          </div>
        )}

        {devices.length > 0 && filteredDevices.length === 0 && (
          <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mx-auto h-9 w-9 text-gray-300 dark:text-gray-700"
            >
              <circle cx="10" cy="10" r="6" />
              <line x1="19" y1="19" x2="14.65" y2="14.65" />
              <line x1="7" y1="7" x2="13" y2="13" />
              <line x1="13" y1="7" x2="7" y2="13" />
            </svg>
            <p className="mt-3 text-sm text-gray-400">{t("no_devices_match_filter")}</p>
          </div>
        )}

        {filteredDevices.length > 0 && (
          <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                  <th className="px-3 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort("note")}
                      className="flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
                    >
                      {t("col_note")}
                      {sortKey === "note" && <span>{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </th>
                  <th className="px-3 py-2 font-medium">{t("col_mac")}</th>
                  <th className="px-3 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort("vlan")}
                      className="flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
                    >
                      {t("col_vlan")}
                      {sortKey === "vlan" && <span>{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </th>
                  <th className="px-3 py-2 font-medium">{t("col_gateways_assigned")}</th>
                  <th className="px-3 py-2 font-medium text-right">{t("col_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedDevices.map((d) => (
                  <tr key={d.id} className="border-b border-gray-100 last:border-0 dark:border-gray-800/60">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-gray-800 dark:text-gray-100">{d.note}</span>
                        {d.pending_action && (
                          <span
                            className="flex h-5 w-5 items-center justify-center rounded-full text-amber-500"
                            title={t("pending_change_hint")}
                          >
                            <i className="ti ti-clock-hour-4 text-[13px]" />
                          </span>
                        )}
                        {hasNoteDiscrepancy(d) && (
                          <button
                            type="button"
                            onClick={() => setNoteDialogDeviceId(d.id)}
                            className="flex h-5 w-5 items-center justify-center rounded-full text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950"
                            title={t("note_discrepancy_hint")}
                          >
                            <i className="ti ti-alert-triangle text-[13px]" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">{d.mac}</td>
                    <td className="px-3 py-2">
                      <span className="inline-block rounded-full bg-teal-50 px-2 py-0.5 text-[11px] text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                        {d.target_vlan_name}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {d.gateways.map((g) => (
                          <span
                            key={g.gateway_id}
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                              g.provisioning_status === "ok"
                                ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                                : "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-300"
                            }`}
                            title={g.provisioning_status !== "ok" ? (g.provisioning_error ?? "") : undefined}
                          >
                            {g.gateway_name}
                            {g.provisioning_status === "vlan_not_found" && ` — ${t("vlan_not_found")}`}
                            {g.provisioning_status === "error" && ` — ${t("provisioning_error")}`}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditDeviceId(d.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-600 dark:hover:bg-gray-800"
                          title={t("btn_edit")}
                        >
                          <i className="ti ti-pencil text-[14px]" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeDevice(d)}
                          disabled={deletingId === d.id}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950"
                          title={t("btn_delete")}
                        >
                          <i className="ti ti-trash text-[14px]" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {noteDialogDeviceId && (
        <NoteDiscrepancyDialog
          api={api}
          device={devices.find((d) => d.id === noteDialogDeviceId)!}
          onClose={() => setNoteDialogDeviceId(null)}
          onResolved={() => {
            setNoteDialogDeviceId(null);
            load();
          }}
        />
      )}

      {editDeviceId && (
        <EditDeviceDialog
          api={api}
          device={devices.find((d) => d.id === editDeviceId)!}
          onClose={() => setEditDeviceId(null)}
          onSaved={(pendingRequested) => {
            setEditDeviceId(null);
            if (pendingRequested) {
              const d = devices.find((d) => d.id === editDeviceId);
              setInfoMessage(t("change_requested_edit", { name: d?.note ?? "" }));
            } else {
              setInfoMessage(null);
            }
            load();
          }}
        />
      )}
    </div>
  );
}

// ── Onboarding form ───────────────────────────────────────────────────────────
// MAC-Sanitizer läuft serverseitig (Entscheidungsvorlage 4.5); hier nur eine
// client-seitige Live-Vorschau, keine eigene Validierungslogik, die von der
// Backend-Regel abweichen könnte.

// Bekannte Backend-Fehlercodes (badRequest("device_mac_pending") etc., siehe
// createDevice() in handlers/index.ts) werden auf i18n-Keys gemappt; alles
// andere (z. B. Netzwerkfehler) wird unverändert als Rohtext angezeigt.
const KNOWN_ERROR_CODES: Record<string, string> = {
  device_mac_pending: "error_device_mac_pending",
  device_mac_rejected: "error_device_mac_rejected",
  device_mac_exists: "error_device_mac_exists",
};

function translateApiError(err: unknown, t: (k: string) => string): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Backend-Fehler kommen als HTTP-Response-Body (JSON) durch useApi.mutate(),
  // z. B. {"error":"device_mac_rejected"} — nicht als reiner Code-String.
  // Bug gefunden 2026-07-01: der Lookup verglich raw direkt gegen die Codes
  // und traf nie, weil raw tatsächlich das ganze JSON-Objekt als Text war.
  let code = raw.trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === "string") code = parsed.error;
  } catch {
    // kein JSON (z. B. Netzwerkfehler, HTTP-Statustext) — raw bleibt wie es ist
  }

  const key = KNOWN_ERROR_CODES[code];
  return key ? t(key) : raw;
}

function previewSanitizedMac(input: string): { value: string; valid: boolean } {
  const stripped = input.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  const valid = /^[0-9a-f]{12}$/.test(stripped);
  const value = valid ? stripped.match(/.{2}/g)!.join(":") : stripped;
  return { value, valid };
}

function OnboardingForm({
  api,
  onDone,
}: {
  api: ReturnType<typeof useApi>;
  onDone: () => void;
}) {
  const { t } = useTranslation(NS);
  const [mac, setMac] = useState("");
  const [note, setNote] = useState("");
  const [targetVlanName, setTargetVlanName] = useState("");
  const [vlanOptions, setVlanOptions] = useState<string[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<string[]>("/vlans").then((rows) => setVlanOptions(Array.isArray(rows) ? rows : [])).catch(() => {});
    api.get<Gateway[]>("/gateways").then((rows) => setGateways(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [api]);

  const macPreview = previewSanitizedMac(mac);

  const toggleGateway = (id: string) => {
    setSelectedGatewayIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = async () => {
    setError(null);
    if (!macPreview.valid) {
      setError(t("error_invalid_mac"));
      return;
    }
    if (!note.trim()) {
      setError(t("error_note_required"));
      return;
    }
    if (!targetVlanName) {
      setError(t("error_vlan_required"));
      return;
    }
    if (selectedGatewayIds.length === 0) {
      setError(t("error_gateway_required"));
      return;
    }

    setSubmitting(true);
    try {
      await api.mutate("POST", "/devices", {
        mac,
        note: note.trim(),
        target_vlan_name: targetVlanName,
        target_gateway_ids: selectedGatewayIds,
      });
      onDone();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-4 text-base font-semibold text-gray-800 dark:text-gray-100">{t("onboard_heading")}</h2>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
        <i className="ti ti-info-circle mr-1 text-[13px]" />
        {t("onboard_approval_hint")}
      </div>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
          {t("label_mac")} <span className="text-red-500">*</span>
        </span>
        <input
          type="text"
          value={mac}
          onChange={(e) => setMac(e.target.value)}
          placeholder="aa:bb:cc:dd:ee:ff"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
        />
        {mac.length > 0 && (
          <span className={`mt-1 block text-xs ${macPreview.valid ? "text-teal-600" : "text-red-500"}`}>
            {macPreview.valid ? macPreview.value : t("error_invalid_mac")}
          </span>
        )}
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
          {t("label_note")} <span className="text-red-500">*</span>
        </span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("placeholder_note")}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
          {t("label_vlan")} <span className="text-red-500">*</span>
        </span>
        <select
          value={targetVlanName}
          onChange={(e) => setTargetVlanName(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
        >
          <option value="">{t("select_vlan")}</option>
          {vlanOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </label>

      <div className="mb-5">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
          {t("label_target_gateways")} <span className="text-red-500">*</span>
        </span>
        {gateways.length === 0 && <p className="text-sm text-gray-400">{t("no_gateways")}</p>}
        <div className="flex flex-col gap-1.5">
          {gateways.map((gw) => (
            <label key={gw.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-800">
              <input
                type="checkbox"
                checked={selectedGatewayIds.includes(gw.id)}
                onChange={() => toggleGateway(gw.id)}
                className="h-4 w-4"
              />
              <span className="text-gray-700 dark:text-gray-200">{gw.name}</span>
              {statusBadge(gw.status, t)}
            </label>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {submitting ? t("submitting") : t("btn_submit_onboard")}
      </button>
    </div>
  );
}

// ── Note discrepancy dialog ───────────────────────────────────────────────────
// Zeigt die pro Gateway abweichende Notiz und lässt den Nutzer einen
// einheitlichen Wert wählen/eingeben; Sync erfolgt automatisch auf alle
// Gateways. Nachfolger des entfernten NameDiscrepancyDialog (2026-07-01),
// jetzt für "note" statt "name" — note ist das einzige Freitextfeld, kann
// aber weiterhin pro Gateway auseinanderlaufen, wenn direkt im UniFi-WebIF
// geändert statt über das Modul.

function NoteDiscrepancyDialog({
  api,
  device,
  onClose,
  onResolved,
}: {
  api: ReturnType<typeof useApi>;
  device: Device;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { t } = useTranslation(NS);
  const [canonicalNote, setCanonicalNote] = useState(device.note);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!canonicalNote.trim()) {
      setError(t("error_note_required"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.mutate("POST", `/devices/${device.id}/resolve-note`, {
        canonical_note: canonicalNote.trim(),
      });
      onResolved();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            {t("note_discrepancy_dialog_heading")}
          </h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <i className="ti ti-x text-[16px]" />
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400 font-mono">{device.mac}</p>

        <div className="mb-4 flex flex-col gap-1.5">
          {device.gateways.map((g) => (
            <button
              key={g.gateway_id}
              type="button"
              onClick={() => g.gateway_note && setCanonicalNote(g.gateway_note)}
              disabled={!g.gateway_note}
              className={`flex items-center justify-between rounded-lg border px-3 py-1.5 text-left text-xs disabled:cursor-default ${
                g.note_discrepancy
                  ? "border-amber-200 bg-amber-50 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:hover:bg-amber-900"
                  : "border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800"
              }`}
              title={g.gateway_note ? t("use_this_note_hint") : ""}
            >
              <span className="text-gray-500">{g.gateway_name}</span>
              <span className="flex items-center gap-1">
                <span className={g.note_discrepancy ? "font-medium text-amber-700 dark:text-amber-300" : "text-gray-700 dark:text-gray-200"}>
                  {g.gateway_note ?? t("no_note_set")}
                </span>
                {g.note_discrepancy && <i className="ti ti-alert-triangle text-[12px] text-amber-600 dark:text-amber-400" />}
              </span>
            </button>
          ))}
        </div>
        <p className="mb-4 -mt-2 text-[11px] text-gray-400">{t("note_discrepancy_click_hint")}</p>

        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">{t("label_canonical_note")}</span>
          <input
            type="text"
            value={canonicalNote}
            onChange={(e) => setCanonicalNote(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
            style={{ fontSize: "16px" }}
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t("btn_cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {submitting ? t("submitting") : t("btn_resolve_sync")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit device dialog ─────────────────────────────────────────────────────────
// Bearbeitet note/target_vlan_name eines bereits aktiven Geräts über
// PATCH /devices/:id, sowie die Ziel-Gateways über die neue
// PATCH /devices/:id/gateways (ergänzt 2026-07-01) — gleiche Checkbox-UI wie
// beim Onboarding, aktuell zugeordnete Gateways vorausgewählt. Neu angehakte
// Gateways werden provisioniert, abgewählte über den bestehenden
// Teil-Lösch-Mechanismus entfernt (Entscheidungsvorlage 4.6).

function EditDeviceDialog({
  api,
  device,
  onClose,
  onSaved,
}: {
  api: ReturnType<typeof useApi>;
  device: Device;
  onClose: () => void;
  // onSaved(pendingRequested): true if either PATCH call came back as a
  // pending change request rather than an applied edit (Nutzerentscheidung
  // 2026-07-05) — a non-Admin acting on an active device — so the caller
  // can show "awaiting approval" instead of assuming the change is live.
  onSaved: (pendingRequested: boolean) => void;
}) {
  const { t } = useTranslation(NS);
  const [note, setNote] = useState(device.note);
  const [targetVlanName, setTargetVlanName] = useState(device.target_vlan_name);
  const [vlanOptions, setVlanOptions] = useState<string[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>(
    device.gateways.map((g) => g.gateway_id),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<string[]>("/vlans").then((rows) => setVlanOptions(Array.isArray(rows) ? rows : [])).catch(() => {});
    api.get<Gateway[]>("/gateways").then((rows) => setGateways(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [api]);

  const toggleGateway = (id: string) => {
    setSelectedGatewayIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (!note.trim()) {
      setError(t("error_note_required"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const noteResult = await api.mutate<{ ok: boolean; pending_action?: string }>(
        "PATCH",
        `/devices/${device.id}`,
        { note: note.trim(), target_vlan_name: targetVlanName },
      );
      let pendingRequested = Boolean(noteResult?.pending_action);

      // Ziel-Gateways nur mit anfragen, wenn sich die Auswahl gegenüber dem
      // aktuellen Stand tatsächlich geändert hat — vermeidet einen
      // unnötigen Provisionierungs-/Löschdurchlauf bei reinem Notiz-Edit.
      const currentIds = new Set(device.gateways.map((g) => g.gateway_id));
      const newIds = new Set(selectedGatewayIds);
      const changed =
        currentIds.size !== newIds.size || [...currentIds].some((id) => !newIds.has(id));
      if (changed) {
        const gwResult = await api.mutate<{ ok: boolean; pending_action?: string }>(
          "PATCH",
          `/devices/${device.id}/gateways`,
          { target_gateway_ids: selectedGatewayIds },
        );
        pendingRequested = pendingRequested || Boolean(gwResult?.pending_action);
      }
      onSaved(pendingRequested);
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{t("edit_device_heading")}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <i className="ti ti-x text-[16px]" />
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400 font-mono">{device.mac}</p>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            {t("label_note")} <span className="text-red-500">*</span>
          </span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
            style={{ fontSize: "16px" }}
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">{t("label_vlan")}</span>
          <select
            value={targetVlanName}
            onChange={(e) => setTargetVlanName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            style={{ fontSize: "16px" }}
          >
            <option value="">{t("select_vlan")}</option>
            {vlanOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>

        <div className="mb-4">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            {t("label_target_gateways")}
          </span>
          {gateways.length === 0 && <p className="text-sm text-gray-400">{t("no_gateways")}</p>}
          <div className="flex flex-col gap-1.5">
            {gateways.map((gw) => (
              <label
                key={gw.id}
                className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-800"
              >
                <input
                  type="checkbox"
                  checked={selectedGatewayIds.includes(gw.id)}
                  onChange={() => toggleGateway(gw.id)}
                  className="h-4 w-4"
                />
                <span className="text-gray-700 dark:text-gray-200">{gw.name}</span>
                {statusBadge(gw.status, t)}
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t("btn_cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {submitting ? t("submitting") : t("btn_save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pending approval list ─────────────────────────────────────────────────────

function PendingApprovalList({
  api,
  onChanged,
}: {
  api: ReturnType<typeof useApi>;
  onChanged: () => void;
}) {
  const { t } = useTranslation(NS);
  const [rows, setRows] = useState<PendingDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resultsByDevice, setResultsByDevice] = useState<Record<string, DeviceGatewayView[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<PendingDevice[]>("/devices/pending");
      setRows(Array.isArray(rows) ? rows : []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const approve = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      // Backend (approveDevice) liefert { status: "active", results: [...] },
      // nicht "gateways" — vorheriger Feldname-Mismatch verschluckte das
      // Provisioning-Ergebnis stillschweigend (Array blieb immer leer).
      const result = await api.mutate<{ status: string; results: DeviceGatewayView[] }>(
        "POST",
        `/devices/${id}/approve`,
      );
      setResultsByDevice((prev) => ({ ...prev, [id]: result?.results ?? [] }));
      setRows((prev) => prev.filter((r) => r.id !== id));
      onChanged();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.mutate("POST", `/devices/${id}/reject`);
      setRows((prev) => prev.filter((r) => r.id !== id));
      onChanged();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{t("nav_pending")}</h2>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      {!loading && rows.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
          <i className="ti ti-checklist text-[36px] text-gray-300 dark:text-gray-700" />
          <p className="mt-3 text-sm text-gray-400">{t("no_pending")}</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.id} className="rounded-2xl border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{r.note}</p>
                <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{r.mac}</p>
                <p className="mt-1 text-[11px] text-gray-400">
                  {t("requested_by", { user: r.created_by })} · {t("col_vlan")}: {r.target_vlan_name}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-gray-400">{t("label_target_gateways")}:</span>
                  {r.target_gateway_names.length === 0 && (
                    <span className="text-[11px] text-gray-400">—</span>
                  )}
                  {r.target_gateway_names.map((name) => (
                    <span
                      key={name}
                      className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-none gap-1.5">
                <button
                  type="button"
                  onClick={() => approve(r.id)}
                  disabled={busyId === r.id}
                  className="flex items-center gap-1 rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  <i className="ti ti-check text-[13px]" />
                  {t("btn_approve")}
                </button>
                <button
                  type="button"
                  onClick={() => reject(r.id)}
                  disabled={busyId === r.id}
                  className="flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <i className="ti ti-x text-[13px]" />
                  {t("btn_reject")}
                </button>
              </div>
            </div>

            {resultsByDevice[r.id] && (
              <div className="mt-2 flex flex-col gap-0.5 border-t border-gray-100 pt-2 text-xs dark:border-gray-800">
                {resultsByDevice[r.id].map((g) => (
                  <div key={g.gateway_id} className="flex items-center gap-1">
                    <span className="text-gray-400">{g.gateway_name}:</span>
                    {g.provisioning_status === "ok" && (
                      <span className="text-teal-600 dark:text-teal-400">{t("provisioning_ok")}</span>
                    )}
                    {g.provisioning_status === "vlan_not_found" && (
                      <span className="text-red-500">{t("vlan_not_found")}</span>
                    )}
                    {g.provisioning_status === "error" && (
                      <span className="text-red-500" title={g.provisioning_error ?? ""}>
                        {t("provisioning_error")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Pending change requests (Admin only, Nutzerentscheidung 2026-07-05) ─────
// Mirrors PendingApprovalList's structure above (same load/approve/reject
// pattern), but for edit/delete/gateway-change requests against already-
// active devices (Migration 0006) rather than brand-new device submissions.
// Approving applies the request exactly as if an Admin had made the change
// directly; rejecting discards it, leaving the device untouched.

function actionLabel(action: PendingDeviceChange["pending_action"], t: (k: string) => string): string {
  if (action === "edit") return t("pending_change_edit");
  if (action === "delete") return t("pending_change_delete");
  return t("pending_change_gateway_change");
}

function PendingChangesList({
  api,
  onChanged,
}: {
  api: ReturnType<typeof useApi>;
  onChanged: () => void;
}) {
  const { t } = useTranslation(NS);
  const [rows, setRows] = useState<PendingDeviceChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // forbidden (ergänzt 2026-07-05): this view has no client-side Admin check
  // (see nav button comment on pendingChangesCount) — a non-Admin who
  // navigates here directly gets a 403 on load, shown as a plain hint
  // instead of the usual red error banner, since it's an expected outcome
  // for this role, not a failure.
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const rows = await api.get<PendingDeviceChange[]>("/devices/pending-changes");
      setRows(Array.isArray(rows) ? rows : []);
    } catch (err) {
      if (err instanceof Error && /403/.test(err.message)) {
        setForbidden(true);
      } else {
        setError(translateApiError(err, t));
      }
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    load();
  }, [load]);

  const approve = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.mutate("POST", `/devices/${id}/approve-change`);
      setRows((prev) => prev.filter((r) => r.id !== id));
      onChanged();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.mutate("POST", `/devices/${id}/reject-change`);
      setRows((prev) => prev.filter((r) => r.id !== id));
      onChanged();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  if (forbidden) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
        <i className="ti ti-lock text-[36px] text-gray-300 dark:text-gray-700" />
        <p className="mt-3 text-sm text-gray-400">{t("pending_changes_admin_only")}</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{t("nav_pending_changes")}</h2>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      {!loading && rows.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
          <i className="ti ti-git-pull-request text-[36px] text-gray-300 dark:text-gray-700" />
          <p className="mt-3 text-sm text-gray-400">{t("no_pending_changes")}</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.id} className="rounded-2xl border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{r.note}</p>
                  <span className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    {actionLabel(r.pending_action, t)}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{r.mac}</p>
                <p className="mt-1 text-[11px] text-gray-400">
                  {t("requested_by", { user: r.requested_by })}
                </p>

                {r.pending_action === "edit" && (
                  <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-300">
                    {r.pending_note !== undefined && (
                      <>
                        {t("label_note")}: <span className="font-medium">{r.pending_note}</span>
                        {r.pending_target_vlan_name && " · "}
                      </>
                    )}
                    {r.pending_target_vlan_name && (
                      <>
                        {t("label_vlan")}: <span className="font-medium">{r.pending_target_vlan_name}</span>
                      </>
                    )}
                  </p>
                )}

                {r.pending_action === "gateway_change" && r.pending_target_gateway_names && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <span className="text-[11px] text-gray-400">{t("label_target_gateways")}:</span>
                    {r.pending_target_gateway_names.length === 0 && (
                      <span className="text-[11px] text-gray-400">—</span>
                    )}
                    {r.pending_target_gateway_names.map((name, i) => (
                      <span
                        key={`${name}-${i}`}
                        className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-none gap-1.5">
                <button
                  type="button"
                  onClick={() => approve(r.id)}
                  disabled={busyId === r.id}
                  className="flex items-center gap-1 rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  <i className="ti ti-check text-[13px]" />
                  {t("btn_approve")}
                </button>
                <button
                  type="button"
                  onClick={() => reject(r.id)}
                  disabled={busyId === r.id}
                  className="flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <i className="ti ti-x text-[13px]" />
                  {t("btn_reject")}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Gateways view (Admin-only CRUD) ───────────────────────────────────────────
//
// Backend erwartet weiterhin eine vollständige URL in base_url (isPrivateHost()
// macht new URL(baseUrl).hostname, siehe unifi-client.ts). Im UI wird aber nur
// die IP-Adresse ohne https:// abgefragt und angezeigt — das https:// wird
// hier ein-/ausgeblendet, nicht im Backend geändert.
//
// Seit 2026-07-02 nur noch IP, kein Hostname mehr: isPrivateHost() im
// Backend hat den DNS-Auflösungspfad für Hostnamen entfernt (siehe
// unifi-client.ts) — ein hier eingegebener Hostname würde dort ohnehin
// fail-closed abgelehnt. isValidPrivateIPv4 spiegelt exakt die
// Backend-Prüfung (isPrivateIPv4 in unifi-client.ts), damit der Fehler
// direkt im Formular auftaucht statt erst nach dem Absenden.

function stripHttps(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function toBaseUrl(ip: string): string {
  return `https://${stripHttps(ip.trim())}`;
}

function isValidPrivateIPv4(value: string): boolean {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function GatewaysView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Gateway | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<Gateway[]>("/gateways");
      setGateways(Array.isArray(rows) ? rows : []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setName("");
    setHost("");
    setApiKey("");
    setError(null);
    setShowForm(true);
  };

  const openEdit = (gw: Gateway) => {
    setEditing(gw);
    setName(gw.name);
    setHost(stripHttps(gw.base_url));
    setApiKey("");
    setError(null);
    setShowForm(true);
  };

  const submit = async () => {
    if (!name.trim() || !host.trim()) {
      setError(t("error_name_url_required"));
      return;
    }
    if (!isValidPrivateIPv4(host)) {
      setError(t("error_invalid_gateway_ip"));
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError(t("error_api_key_required"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const base_url = toBaseUrl(host);
      if (editing) {
        const body: Record<string, unknown> = { name: name.trim(), base_url };
        if (apiKey.trim()) body.api_key = apiKey.trim();
        await api.mutate("PATCH", `/gateways/${editing.id}`, body);
      } else {
        await api.mutate("POST", "/gateways", {
          name: name.trim(),
          base_url,
          api_key: apiKey.trim(),
        });
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (gw: Gateway) => {
    if (!window.confirm(t("confirm_delete_gateway", { name: gw.name }))) return;
    await api.mutate("DELETE", `/gateways/${gw.id}`);
    await load();
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t("nav_gateways")}</h2>
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
        >
          <i className="ti ti-plus text-[14px]" />
          {t("btn_new_gateway")}
        </button>
      </div>

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}

      {!loading && gateways.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
          <i className="ti ti-server-off text-[36px] text-gray-300 dark:text-gray-700" />
          <p className="mt-3 text-sm text-gray-400">{t("no_gateways")}</p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {gateways.map((gw) => (
          <div key={gw.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-200 p-3 dark:border-gray-800">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{gw.name}</p>
                {statusBadge(gw.status, t)}
              </div>
              <p className="truncate text-xs text-gray-400">{stripHttps(gw.base_url)}</p>
              <p className="text-[11px] text-gray-400">{t("created_by_label", { user: gw.created_by })}</p>
            </div>
            <div className="flex flex-none gap-1.5">
              <button
                type="button"
                onClick={() => openEdit(gw)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-600 dark:hover:bg-gray-800"
                title={t("btn_edit")}
              >
                <i className="ti ti-pencil text-[14px]" />
              </button>
              <button
                type="button"
                onClick={() => remove(gw)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                title={t("btn_delete")}
              >
                <i className="ti ti-trash text-[14px]" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 dark:bg-gray-900">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                {editing ? t("edit_gateway_heading") : t("new_gateway_heading")}
              </h3>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                <i className="ti ti-x text-[16px]" />
              </button>
            </div>

            {error && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                {error}
              </div>
            )}

            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">{t("label_gateway_name")}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
                style={{ fontSize: "16px" }}
              />
            </label>

            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">{t("label_base_url")}</span>
              <input
                type="text"
                inputMode="decimal"
                value={host}
                onChange={(e) => setHost(stripHttps(e.target.value))}
                placeholder="10.5.1.1"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
                style={{ fontSize: "16px" }}
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                {t("label_api_key")} {editing && <span className="text-gray-400">({t("leave_blank_unchanged")})</span>}
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
                style={{ fontSize: "16px" }}
              />
            </label>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {t("btn_cancel")}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
              >
                {submitting ? t("submitting") : t("btn_save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ModuleInfoView ────────────────────────────────────────────────────────────
//
// Same component as recipes/ui/src/App.tsx's ModuleInfoView — see that
// file's doc comment for the full rationale (calls Core's GET
// /v1/modules/{name} directly, description is localized via
// de.json/en.json rather than manifest.description, source repo link is a
// fixed constant rather than fetched from the registry). Duplicated here
// rather than shared because @modulab/ui doesn't exist as a real package
// yet (see Task #13, iframe module-rendering migration) — once it does,
// this and recipes' copy should be consolidated into one component there.

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
  // Runtime egress hosts (actual gateway IPs currently allowed), separate
  // from info.manifest.egress_allowlist which is the static manifest value
  // — deliberately empty for this module (see manifest.yaml's dynamic_egress
  // comment) since real network access here is 100% admin-configured at
  // runtime, not something a static manifest field can express. Without
  // this, the info card showed "no network access" even with gateways
  // configured and successfully polling — reported by the user 2026-07-04.
  const [runtimeEgressHosts, setRuntimeEgressHosts] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [infoRes, egressRes] = await Promise.all([
          fetch(`/v1/modules/${encodeURIComponent(moduleName)}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`/v1/modules/${encodeURIComponent(moduleName)}/egress-hosts`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        if (!infoRes.ok) throw new Error(`HTTP ${infoRes.status}`);
        const data = await infoRes.json();
        if (!cancelled) setInfo(data);
        // Best-effort: if this fails for any reason, fall back to the
        // static manifest.egress_allowlist further down rather than
        // failing the whole info card over a secondary field.
        if (egressRes.ok) {
          const egressData = await egressRes.json();
          if (!cancelled) setRuntimeEgressHosts(egressData.egress_hosts ?? []);
        }
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
  // Prefer the runtime-queried hosts (actual current gateway IPs) over the
  // static manifest.egress_allowlist — see runtimeEgressHosts state comment
  // above. runtimeEgressHosts is null only while that secondary fetch is
  // still pending or failed; in that transient case fall back to the
  // manifest value so the row never appears empty due to a timing gap.
  const egressHosts = runtimeEgressHosts ?? manifest.egress_allowlist ?? [];

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
        {/* This module's UI never talks to gateways directly — all gateway
            communication (RADIUS/VLAN/client-history polling, isPrivateHost()
            enforcement, TLS handling) happens server-side in the Deno worker;
            see unifi-client.ts's unifiFetch(). The browser only ever calls
            same-origin /v1/modules/unifi-network/api/... (Core). Verified: no
            fetch()/XHR to any gateway IP or external host exists in this
            file. */}
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
