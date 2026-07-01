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
  name_discrepancy: boolean;
  provisioning_status: "ok" | "vlan_not_found" | "error";
  provisioning_error: string | null;
}

interface Device {
  id: string;
  name: string;
  note: string;
  mac: string;
  target_vlan_name: string;
  gateways: DeviceGatewayView[];
}

interface PendingDevice {
  id: string;
  alias: string;
  note: string;
  mac: string;
  target_vlan_name: string;
  created_by: string;
  created_at: string;
}

interface VlanOption {
  vlan_name: string;
}

type View =
  | { type: "overview" }
  | { type: "onboard" }
  | { type: "pending" }
  | { type: "gateways" };

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

export default function UnifiNetworkApp({ apiBase, token }: ModuleComponentProps) {
  const { t } = useTranslation(NS);
  const [view, setView] = useState<View>({ type: "overview" });
  const api = useApi(apiBase, token);
  const [pendingCount, setPendingCount] = useState(0);

  const refreshPendingCount = useCallback(() => {
    api
      .get<PendingDevice[]>("/devices/pending")
      .then((rows) => setPendingCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    refreshPendingCount();
  }, [refreshPendingCount]);

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
        <button
          type="button"
          onClick={() => setView({ type: "pending" })}
          className={navCls(view.type === "pending") + " relative"}
          title={t("nav_pending")}
        >
          <i className="ti ti-clock-hour-4 text-[15px]" />
          <span className="hidden sm:inline">{t("nav_pending")}</span>
          {pendingCount > 0 && (
            <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
              {pendingCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setView({ type: "gateways" })}
          className={navCls(view.type === "gateways")}
          title={t("nav_gateways")}
        >
          <i className="ti ti-server-2 text-[15px]" />
          <span className="hidden sm:inline">{t("nav_gateways")}</span>
        </button>
        <div className="flex-1 min-w-[4px]" />
        <button
          type="button"
          onClick={() => setView({ type: "onboard" })}
          className="flex flex-none items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
          title={t("btn_new_device")}
        >
          <i className="ti ti-plus text-[14px]" />
          <span className="hidden sm:inline">{t("btn_new_device")}</span>
        </button>
      </div>

      {view.type === "overview" && <OverviewView api={api} />}
      {view.type === "onboard" && (
        <OnboardingForm api={api} onDone={() => setView({ type: "overview" })} />
      )}
      {view.type === "pending" && (
        <PendingApprovalList api={api} onChanged={refreshPendingCount} />
      )}
      {view.type === "gateways" && <GatewaysView api={api} />}
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
      cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
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

function relativeTime(iso: string | null, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (!iso) return t("never_seen");
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return t("just_now");
  if (diffMin < 60) return t("minutes_ago", { count: diffMin });
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return t("hours_ago", { count: diffH });
  const diffD = Math.round(diffH / 24);
  return t("days_ago", { count: diffD });
}

// ── Overview: gateway status bar + global RADIUS table ──────────────────────

function OverviewView({ api }: { api: ReturnType<typeof useApi> }) {
  const { t } = useTranslation(NS);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nameDialogDeviceId, setNameDialogDeviceId] = useState<string | null>(null);
  const [editDeviceId, setEditDeviceId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const hasDiscrepancy = (d: Device) => d.gateways.some((g) => g.name_discrepancy);

  const removeDevice = useCallback(
    async (device: Device) => {
      if (!window.confirm(t("confirm_delete_device", { name: device.name }))) return;
      setDeletingId(device.id);
      try {
        await api.mutate("DELETE", `/devices/${device.id}`);
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
        <h2 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{t("devices_heading")}</h2>

        {!loading && devices.length === 0 && (
          <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-800">
            <i className="ti ti-devices-off text-[36px] text-gray-300 dark:text-gray-700" />
            <p className="mt-3 text-sm text-gray-400">{t("no_devices")}</p>
          </div>
        )}

        {devices.length > 0 && (
          <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                  <th className="px-3 py-2 font-medium">{t("col_name")}</th>
                  <th className="px-3 py-2 font-medium">{t("col_mac")}</th>
                  <th className="px-3 py-2 font-medium">{t("col_vlan")}</th>
                  <th className="px-3 py-2 font-medium">{t("col_last_seen")}</th>
                  <th className="px-3 py-2 font-medium text-right">{t("col_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-b border-gray-100 last:border-0 dark:border-gray-800/60">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-gray-800 dark:text-gray-100">{d.name}</span>
                        {hasDiscrepancy(d) && (
                          <button
                            type="button"
                            onClick={() => setNameDialogDeviceId(d.id)}
                            className="flex h-5 w-5 items-center justify-center rounded-full text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950"
                            title={t("name_discrepancy_hint")}
                          >
                            <i className="ti ti-alert-triangle text-[13px]" />
                          </button>
                        )}
                      </div>
                      {d.note && <p className="text-xs text-gray-400">{d.note}</p>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">{d.mac}</td>
                    <td className="px-3 py-2">
                      <span className="inline-block rounded-full bg-teal-50 px-2 py-0.5 text-[11px] text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                        {d.target_vlan_name}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-0.5">
                        {d.gateways.map((g) => (
                          <div key={g.gateway_id} className="flex items-center gap-1 text-xs">
                            <span className="text-gray-400">{g.gateway_name}:</span>
                            {g.provisioning_status === "ok" && (
                              <span className="text-gray-600 dark:text-gray-300">
                                {relativeTime(g.last_seen_at, t)}
                              </span>
                            )}
                            {g.provisioning_status === "vlan_not_found" && (
                              <span className="text-red-500" title={g.provisioning_error ?? ""}>
                                {t("vlan_not_found")}
                              </span>
                            )}
                            {g.provisioning_status === "error" && (
                              <span className="text-red-500" title={g.provisioning_error ?? ""}>
                                {t("provisioning_error")}
                              </span>
                            )}
                          </div>
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

      {nameDialogDeviceId && (
        <NameDiscrepancyDialog
          api={api}
          device={devices.find((d) => d.id === nameDialogDeviceId)!}
          onClose={() => setNameDialogDeviceId(null)}
          onResolved={() => {
            setNameDialogDeviceId(null);
            load();
          }}
        />
      )}

      {editDeviceId && (
        <EditDeviceDialog
          api={api}
          device={devices.find((d) => d.id === editDeviceId)!}
          onClose={() => setEditDeviceId(null)}
          onSaved={() => {
            setEditDeviceId(null);
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
  const [alias, setAlias] = useState("");
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
        alias: alias.trim(),
        note: note.trim(),
        target_vlan_name: targetVlanName,
        target_gateway_ids: selectedGatewayIds,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
          <span className={`mt-1 block text-xs ${macPreview.valid ? "text-emerald-600" : "text-red-500"}`}>
            {macPreview.valid ? macPreview.value : t("error_invalid_mac")}
          </span>
        )}
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
          {t("label_alias")} <span className="text-gray-400">({t("optional")})</span>
        </span>
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder={t("placeholder_alias")}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-900"
          style={{ fontSize: "16px" }}
        />
        <span className="mt-1 block text-xs text-gray-400">{t("alias_fallback_hint")}</span>
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

// ── Name discrepancy dialog ───────────────────────────────────────────────────
// Zeigt die pro Gateway abweichenden Aliase und lässt den Nutzer einen
// kanonischen Namen wählen/eingeben; Sync erfolgt automatisch auf alle
// Gateways (Entscheidungsvorlage 4.4). Betrifft nur "name", nicht "note".

function NameDiscrepancyDialog({
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
  const [canonicalName, setCanonicalName] = useState(device.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!canonicalName.trim()) {
      setError(t("error_alias_required"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.mutate("POST", `/devices/${device.id}/resolve-name`, {
        canonical_name: canonicalName.trim(),
      });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            {t("discrepancy_dialog_heading")}
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
            <div key={g.gateway_id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-1.5 text-xs dark:border-gray-800">
              <span className="text-gray-500">{g.gateway_name}</span>
              {g.name_discrepancy && (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <i className="ti ti-alert-triangle text-[12px]" />
                  {t("name_discrepancy_hint")}
                </span>
              )}
            </div>
          ))}
        </div>

        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">{t("label_canonical_name")}</span>
          <input
            type="text"
            value={canonicalName}
            onChange={(e) => setCanonicalName(e.target.value)}
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
// Bearbeitet alias/note/target_vlan_name eines bereits aktiven Geräts über
// PATCH /devices/:id. Namensdiskrepanz-Sync (NameDiscrepancyDialog) bleibt
// ein separater, spezialisierter Flow — dieser Dialog ist die allgemeine
// "Gerät bearbeiten"-Aktion aus der Übersichtstabelle.

function EditDeviceDialog({
  api,
  device,
  onClose,
  onSaved,
}: {
  api: ReturnType<typeof useApi>;
  device: Device;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(NS);
  const [alias, setAlias] = useState(device.name);
  const [note, setNote] = useState(device.note);
  const [targetVlanName, setTargetVlanName] = useState(device.target_vlan_name);
  const [vlanOptions, setVlanOptions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<string[]>("/vlans").then((rows) => setVlanOptions(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [api]);

  const submit = async () => {
    if (!alias.trim()) {
      setError(t("error_alias_required"));
      return;
    }
    if (!note.trim()) {
      setError(t("error_note_required"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.mutate("PATCH", `/devices/${device.id}`, {
        alias: alias.trim(),
        note: note.trim(),
        target_vlan_name: targetVlanName,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 dark:bg-gray-900">
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
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">{t("label_alias")}</span>
          <input
            type="text"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:border-gray-700 dark:bg-gray-800"
            style={{ fontSize: "16px" }}
          />
        </label>

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

        <label className="mb-4 block">
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{r.alias}</p>
                <p className="text-xs text-gray-400">{r.note}</p>
                <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{r.mac}</p>
                <p className="mt-1 text-[11px] text-gray-400">
                  {t("requested_by", { user: r.created_by })} · {t("col_vlan")}: {r.target_vlan_name}
                </p>
              </div>
              <div className="flex flex-none gap-1.5">
                <button
                  type="button"
                  onClick={() => approve(r.id)}
                  disabled={busyId === r.id}
                  className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
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
                      <span className="text-emerald-600 dark:text-emerald-400">{t("provisioning_ok")}</span>
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

// ── Gateways view (Admin-only CRUD) ───────────────────────────────────────────
//
// Backend erwartet weiterhin eine vollständige URL in base_url (isPrivateHost()
// macht new URL(baseUrl).hostname, siehe unifi-client.ts). Im UI wird aber nur
// die IP/der FQDN ohne https:// abgefragt und angezeigt — das https:// wird
// hier ein-/ausgeblendet, nicht im Backend geändert.

function stripHttps(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function toBaseUrl(hostOrFqdn: string): string {
  return `https://${stripHttps(hostOrFqdn.trim())}`;
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
      setError(err instanceof Error ? err.message : String(err));
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
                value={host}
                onChange={(e) => setHost(stripHttps(e.target.value))}
                placeholder="udm.example.com"
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
