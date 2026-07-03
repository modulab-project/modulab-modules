/**
 * unifi-network module — Deno Tier 2 handler
 *
 * Routes (all under /v1/modules/unifi-network/api/):
 *
 * Gateways (Super-Admin / Org-Admin only — Entscheidungsvorlage 4.7)
 *   GET    /gateways                       list all (status, no decrypted API keys)
 *   POST   /gateways                       create
 *   PATCH  /gateways/:id                   update (name, base_url, api_key)
 *   DELETE /gateways/:id                   delete
 *   POST   /gateways/:id/refresh           manual poll for a single gateway
 *   POST   /gateways/refresh-all           manual poll for all gateways
 *
 * VLANs (read-only, from vlan_cache)
 *   GET    /vlans                          distinct VLAN names across all gateways (onboarding form dropdown)
 *   GET    /gateways/:id/vlans             VLAN names known on a single gateway
 *
 * Devices (RADIUS table)
 *   GET    /devices                        list all (global RADIUS table, joined view)
 *   POST   /devices                        onboarding form submit -> pending_approval
 *   PATCH  /devices/:id                    edit note/VLAN (own pending devices, or Admin for active ones)
 *   PATCH  /devices/:id/gateways           change target gateways of an already-active device (checkbox UI, like onboarding)
 *   DELETE /devices/:id                    delete everywhere it's provisioned
 *   DELETE /devices/:id/gateways/:gatewayId  partial delete (remove from a single gateway)
 *
 * Onboarding approval (Super-Admin / Org-Admin only)
 *   GET    /devices/pending                list devices awaiting approval
 *   POST   /devices/:id/approve            approve -> run gateway provisioning loop
 *   POST   /devices/:id/reject             reject -> discard, no API calls ever made
 *
 * Note discrepancy resolution
 *   POST   /devices/:id/resolve-note       set canonical note, sync to all gateways
 *
 * HINWEIS (2026-07-01): das Name-Konzept (UniFi-Feld "name", kanonischer
 * Alias) wurde vollständig entfernt. Das Modul nutzt ausschließlich die
 * Notiz (UniFi-Feld "note") als einziges Freitextfeld — der Diskrepanz-
 * Mechanismus wurde dafür direkt danach wieder eingeführt (siehe oben).
 */

import type {
  HandlerRequest,
  HandlerResponse,
  ModuleDbClient,
  ModuleAuthContext,
  GatewayRow,
  DeviceRow,
  DeviceGatewayRow,
  DeviceInput,
  DeviceGatewaysInput,
  GatewayProvisionResult,
} from "./types.ts";
import { getEncKey, getMacHashKey, encrypt, decrypt, macHash, sanitizeMac, InvalidMacError } from "./crypto.ts";
import {
  createRadiusAccount,
  updateRadiusAccount,
  deleteRadiusAccount,
  fetchRadiusAccounts,
  fetchUsers,
  createUserNote,
  updateUserNote,
  deleteUserAlias,
  isAlreadyGoneError,
  isDuplicateError,
  type GatewayConn,
  type UnifiRadiusAccount,
  type UnifiUser,
} from "./unifi-client.ts";

const ADMIN_ROLES = ["super-admin", "org-admin"];

function isAdmin(auth: ModuleAuthContext): boolean {
  return auth.roles.some((r) => ADMIN_ROLES.includes(r));
}

function ok(body: unknown): HandlerResponse {
  return { status: 200, body };
}
function created(body: unknown): HandlerResponse {
  return { status: 201, body };
}
function badRequest(message: string): HandlerResponse {
  return { status: 400, body: { error: message } };
}
function forbidden(): HandlerResponse {
  return { status: 403, body: { error: "Forbidden" } };
}
function notFound(): HandlerResponse {
  return { status: 404, body: { error: "Not found" } };
}

// Small, local {de, en} text builders for the two HTTP-handler-triggered
// notification events (onboarding submit + approval outcome). Mirrors
// jobs/poll-gateways.ts's own notificationText — kept separate rather than
// shared, since handler code and job code are two different Deno entrypoints
// with no shared module-local state; duplicating four short template
// functions is simpler than introducing a shared import just for this.
// Every text builder below includes: who did it (actor email), the device's
// note (its human-readable identity — there's no name field, see the header
// comment on ADOPTED_NOTE_PLACEHOLDER-style history), the MAC where
// relevant, the VLAN where relevant, and a per-gateway breakdown wherever
// more than one gateway could be involved — rather than just a count.
// Reported 2026-07-04: prefer too much detail in a notification over too
// little, since the admin reading it may not have the device list open at
// the same time to cross-reference.
const handlerNotificationText = {
  deviceWaitingApproval: (note: string, mac: string, vlanName: string, actor: string): { de: string; en: string } => ({
    de: `Neues Gerät wartet auf Freigabe: ${note} (${mac}, VLAN "${vlanName || "?"}") — eingereicht von ${actor}`,
    en: `New device waiting for approval: ${note} (${mac}, VLAN "${vlanName || "?"}") — submitted by ${actor}`,
  }),
  deviceRejected: (note: string, mac: string, actor: string): { de: string; en: string } => ({
    de: `Gerät abgelehnt: ${note} (${mac}) — von ${actor}`,
    en: `Device rejected: ${note} (${mac}) — by ${actor}`,
  }),
  deviceDeleted: (note: string, mac: string, gatewayNames: string[], actor: string): { de: string; en: string } => {
    const gwList = gatewayNames.length > 0 ? gatewayNames.join(", ") : (gatewayNames.length === 0 ? "-" : "?");
    return {
      de: `Gerät gelöscht: ${note} (${mac}) — von allen Gateways entfernt (${gwList}), von ${actor}`,
      en: `Device deleted: ${note} (${mac}) — removed from all gateways (${gwList}), by ${actor}`,
    };
  },
  deviceApproved: (note: string, mac: string, vlanName: string, results: GatewayProvisionResult[], actor: string): { de: string; en: string } => {
    const failed = results.filter((r) => r.status !== "ok");
    const okNames = results.filter((r) => r.status === "ok").map((r) => r.gateway_name).join(", ") || "-";
    if (failed.length === 0) {
      return {
        de: `Gerät freigegeben: ${note} (${mac}, VLAN "${vlanName || "?"}") — erfolgreich eingerichtet auf: ${okNames}. Freigegeben von ${actor}`,
        en: `Device approved: ${note} (${mac}, VLAN "${vlanName || "?"}") — provisioned successfully on: ${okNames}. Approved by ${actor}`,
      };
    }
    const failedDetail = failed.map((r) => `${r.gateway_name} (${r.status}${r.error ? ": " + r.error : ""})`).join("; ");
    return {
      de: `Gerät freigegeben: ${note} (${mac}, VLAN "${vlanName || "?"}") — erfolgreich auf: ${okNames}. Problem auf: ${failedDetail}. Freigegeben von ${actor}`,
      en: `Device approved: ${note} (${mac}, VLAN "${vlanName || "?"}") — succeeded on: ${okNames}. Issue on: ${failedDetail}. Approved by ${actor}`,
    };
  },
  deviceUpdated: (
    note: string,
    mac: string,
    changedFields: string[],
    syncResults: { gateway_id: string; status: "ok" | "skipped_no_user_alias" | "error"; error?: string }[],
    gatewayNames: Map<string, string>,
    actor: string,
  ): { de: string; en: string } => {
    const fieldsDe = changedFields.map((f) => (f === "note" ? "Notiz" : f === "target_vlan_name" ? "VLAN" : f)).join(", ");
    const fieldsEn = changedFields.join(", ");
    const failed = syncResults.filter((r) => r.status === "error");
    let syncDe = "";
    let syncEn = "";
    if (syncResults.length > 0) {
      if (failed.length === 0) {
        syncDe = ` — auf allen ${syncResults.length} Gateway(s) synchronisiert`;
        syncEn = ` — synced to all ${syncResults.length} gateway(s)`;
      } else {
        const failedNames = failed.map((r) => gatewayNames.get(r.gateway_id) ?? r.gateway_id).join(", ");
        syncDe = ` — Problem beim Synchronisieren auf: ${failedNames}`;
        syncEn = ` — issue syncing to: ${failedNames}`;
      }
    }
    return {
      de: `Gerät bearbeitet: ${note} (${mac}) — geändert: ${fieldsDe}${syncDe}. Von ${actor}`,
      en: `Device edited: ${note} (${mac}) — changed: ${fieldsEn}${syncEn}. By ${actor}`,
    };
  },
  deviceGatewaysChanged: (
    note: string,
    mac: string,
    added: string[],
    removed: string[],
    failedAdds: { gateway_name: string; error?: string }[],
    actor: string,
  ): { de: string; en: string } => {
    const parts: string[] = [];
    const partsEn: string[] = [];
    if (added.length > 0) {
      parts.push(`hinzugefügt: ${added.join(", ")}`);
      partsEn.push(`added: ${added.join(", ")}`);
    }
    if (removed.length > 0) {
      parts.push(`entfernt: ${removed.join(", ")}`);
      partsEn.push(`removed: ${removed.join(", ")}`);
    }
    if (failedAdds.length > 0) {
      const failedDetail = failedAdds.map((f) => `${f.gateway_name}${f.error ? " (" + f.error + ")" : ""}`).join(", ");
      parts.push(`Problem bei: ${failedDetail}`);
      partsEn.push(`issue on: ${failedDetail}`);
    }
    return {
      de: `Gateway-Zuordnung geändert für ${note} (${mac}) — ${parts.join("; ")}. Von ${actor}`,
      en: `Gateway assignment changed for ${note} (${mac}) — ${partsEn.join("; ")}. By ${actor}`,
    };
  },
  deviceRemovedFromGateway: (note: string, mac: string, gatewayName: string, actor: string): { de: string; en: string } => ({
    de: `Gerät ${note} (${mac}) von Gateway "${gatewayName}" entfernt — von ${actor}`,
    en: `Device ${note} (${mac}) removed from gateway "${gatewayName}" — by ${actor}`,
  }),
  noteDiscrepancyResolved: (
    note: string,
    canonicalNote: string,
    results: { gateway_id: string; status: "ok" | "skipped_no_user_alias" | "error"; error?: string }[],
    gatewayNames: Map<string, string>,
    actor: string,
  ): { de: string; en: string } => {
    const failed = results.filter((r) => r.status === "error");
    const okNames = results.filter((r) => r.status === "ok").map((r) => gatewayNames.get(r.gateway_id) ?? r.gateway_id).join(", ") || "-";
    let detailDe = ` — übernommen auf: ${okNames}`;
    let detailEn = ` — applied to: ${okNames}`;
    if (failed.length > 0) {
      const failedNames = failed.map((r) => gatewayNames.get(r.gateway_id) ?? r.gateway_id).join(", ");
      detailDe += `. Problem bei: ${failedNames}`;
      detailEn += `. Issue on: ${failedNames}`;
    }
    return {
      de: `Notiz-Diskrepanz aufgelöst: ${note} — neue Notiz "${canonicalNote}"${detailDe}. Von ${actor}`,
      en: `Note discrepancy resolved: ${note} — new note "${canonicalNote}"${detailEn}. By ${actor}`,
    };
  },
};

async function audit(
  db: ModuleDbClient,
  actor: string,
  action: string,
  targetType: "gateway" | "device",
  targetId: string | null,
  detail?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, targetType, targetId, detail ?? null],
  );
}

export default async function handler(req: HandlerRequest): Promise<HandlerResponse> {
  const { method, path, body, auth, db } = req;

  const qIdx = path.indexOf("?");
  const pathname = qIdx === -1 ? path : path.slice(0, qIdx);
  const route = `${method} ${pathname}`;

  // ── Gateways ────────────────────────────────────────────────────────────

  if (route === "GET /gateways") return listGateways(db);
  if (route === "POST /gateways") return createGateway(db, auth, body);
  if (method === "PATCH" && pathname.match(/^\/gateways\/[^/]+$/))
    return updateGateway(db, auth, segId(pathname), body);
  if (method === "DELETE" && pathname.match(/^\/gateways\/[^/]+$/))
    return deleteGateway(db, auth, segId(pathname));
  if (method === "POST" && pathname.match(/^\/gateways\/[^/]+\/refresh$/))
    return refreshGateway(db, segId(pathname, -2));
  if (route === "POST /gateways/refresh-all") return refreshAllGateways(db);

  // ── VLANs (Dropdown-Datengrundlage fürs Onboarding-Formular) ─────────────

  if (route === "GET /vlans") return listVlanNames(db);
  if (method === "GET" && pathname.match(/^\/gateways\/[^/]+\/vlans$/))
    return listVlanNamesForGateway(db, segId(pathname, -2));

  // ── Devices (global RADIUS table) ────────────────────────────────────────

  if (route === "GET /devices") return listDevices(db);
  if (route === "POST /devices") return createDevice(db, auth, body as DeviceInput);
  if (method === "PATCH" && pathname.match(/^\/devices\/[^/]+\/gateways$/))
    return updateDeviceGateways(db, auth, segId(pathname, -2), body as DeviceGatewaysInput);
  if (method === "PATCH" && pathname.match(/^\/devices\/[^/]+$/))
    return updateDevice(db, auth, segId(pathname), body);
  if (method === "DELETE" && pathname.match(/^\/devices\/[^/]+$/))
    return deleteDevice(db, auth, segId(pathname));
  if (method === "DELETE" && pathname.match(/^\/devices\/[^/]+\/gateways\/[^/]+$/))
    return deleteDeviceFromGateway(db, auth, segId(pathname, -3), segId(pathname));

  // ── Onboarding approval ───────────────────────────────────────────────────

  if (route === "GET /devices/pending") return listPendingDevices(db, auth);
  if (method === "POST" && pathname.match(/^\/devices\/[^/]+\/approve$/))
    return approveDevice(db, auth, segId(pathname, -2));
  if (method === "POST" && pathname.match(/^\/devices\/[^/]+\/reject$/))
    return rejectDevice(db, auth, segId(pathname, -2));

  // ── Note discrepancy resolution ──────────────────────────────────────────

  if (method === "POST" && pathname.match(/^\/devices\/[^/]+\/resolve-note$/))
    return resolveNoteDiscrepancy(db, auth, segId(pathname, -2), body);

  return notFound();
}

function segId(pathname: string, fromEnd = -1): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.at(fromEnd) ?? "";
}

// ── Gateway handlers (Admin only, Entscheidungsvorlage 4.7) ─────────────────

// Entschlüsselt eine GatewayRow für die API-Response (name/base_url/created_by
// waren zuvor Klartext, ergänzt 2026-07-01 — siehe Migration 0003).
async function decryptGatewayForResponse(gw: GatewayRow, encKey: CryptoKey | null) {
  return {
    id: gw.id,
    name: encKey ? await decrypt(encKey, gw.name_enc).catch(() => "???") : "???",
    base_url: encKey ? await decrypt(encKey, gw.base_url_enc).catch(() => "???") : "???",
    status: gw.status,
    consecutive_failures: gw.consecutive_failures,
    last_checked_at: gw.last_checked_at,
    last_error: gw.last_error,
    created_by: encKey ? await decrypt(encKey, gw.created_by_enc).catch(() => "???") : "???",
    created_at: gw.created_at,
  };
}

// ── Egress reload (Core Deno sandbox hardening) ─────────────────────────────
//
// This module's worker is started with no --allow-net by default (see
// Core's backend/internal/modules/deno.go, WorkerOptions/ReloadEgress).
// Gateway base URLs are entered by an admin at runtime, so the concrete
// hostnames the worker needs are not known at install time — a static
// manifest egress_allowlist cannot express "whatever the admin configures".
// Whenever a gateway is created, updated, or deleted, computeEgressHosts()
// re-reads every gateway's decrypted base_url from the DB and the calling
// handler attaches the resulting host list as HandlerResponse.restartHosts.
// Core's ModuleProxyHandler (router.go) sees that field on the response and
// restarts this worker with --allow-net scoped to exactly those hosts —
// so the worker never has broader network access than "the gateways that
// currently exist in the DB", and a deleted gateway's host is dropped from
// the allowlist on the very next mutation.
//
// isPrivateHost() in unifi-client.ts remains a second, independent check
// inside the handler itself (defense in depth): even if this list were
// ever wrong, the handler still refuses to contact non-private hosts.
export async function computeEgressHosts(db: ModuleDbClient, encKey: CryptoKey | null): Promise<string[]> {
  if (!encKey) return [];
  const rows = await db.query<GatewayRow>(`SELECT base_url_enc FROM gateways`);
  const hosts = new Set<string>();
  for (const row of rows) {
    try {
      const baseUrl = await decrypt(encKey, row.base_url_enc);
      hosts.add(new URL(baseUrl).hostname);
    } catch {
      // Skip rows that fail to decrypt/parse rather than failing the whole
      // reload — a single bad row should not take every other gateway's
      // network access down with it.
    }
  }
  return [...hosts];
}

async function listGateways(db: ModuleDbClient): Promise<HandlerResponse> {
  const rows = await db.query<GatewayRow>(`SELECT * FROM gateways`);
  const encKey = await getEncKey();
  const result = await Promise.all(rows.map((gw) => decryptGatewayForResponse(gw, encKey)));
  result.sort((a, b) => a.name.localeCompare(b.name));
  return ok(result);
}

async function createGateway(db: ModuleDbClient, auth: ModuleAuthContext, body: unknown): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  const encKey = await getEncKey();
  if (!encKey) return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };

  const { name, base_url, api_key } = body as { name?: string; base_url?: string; api_key?: string };
  if (!name || !base_url || !api_key) return badRequest("name, base_url and api_key are required");

  const nameEnc = await encrypt(encKey, name);
  const baseUrlEnc = await encrypt(encKey, base_url);
  const createdByEnc = await encrypt(encKey, auth.userEmail);
  const apiKeyEnc = await encrypt(encKey, api_key);
  const [row] = await db.query<GatewayRow>(
    `INSERT INTO gateways (name_enc, base_url_enc, api_key_enc, created_by_enc)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [nameEnc, baseUrlEnc, apiKeyEnc, createdByEnc],
  );

  await audit(db, auth.userEmail, "gateway.create", "gateway", row.id, name);
  const resp = created(await decryptGatewayForResponse(row, encKey));
  resp.restartHosts = await computeEgressHosts(db, encKey);
  return resp;
}

async function updateGateway(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  id: string,
  body: unknown,
): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  const { name, base_url, api_key } = body as { name?: string; base_url?: string; api_key?: string };

  const encKey = await getEncKey();
  if (!encKey) return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };

  const nameEnc = name ? await encrypt(encKey, name) : null;
  const baseUrlEnc = base_url ? await encrypt(encKey, base_url) : null;

  // Reset the circuit breaker on every save. An admin editing a gateway's
  // config (fixing a URL, rotating a key) is exactly the "operator
  // intervention" the pause was waiting for — see status.go's CircuitBreaker
  // comment and poll_gateways's `WHERE status != 'paused'` filter, which
  // otherwise excludes a paused gateway from polling forever with no other
  // way back in (found 2026-07-02: gateways paused during the sandbox
  // rollout stayed paused after the underlying network issue was fixed,
  // because nothing ever cleared status/consecutive_failures). This can
  // reset a gateway that was paused for a still-unfixed reason too — the
  // next poll will just re-fail and re-pause it after CIRCUIT_BREAKER_THRESHOLD
  // more failures, so that's a wasted poll cycle at worst, not a new risk.
  if (api_key) {
    const apiKeyEnc = await encrypt(encKey, api_key);
    await db.query(
      `UPDATE gateways SET name_enc = COALESCE($1, name_enc), base_url_enc = COALESCE($2, base_url_enc), api_key_enc = $3, status = 'unknown', consecutive_failures = 0, updated_at = now() WHERE id = $4`,
      [nameEnc, baseUrlEnc, apiKeyEnc, id],
    );
  } else {
    await db.query(
      `UPDATE gateways SET name_enc = COALESCE($1, name_enc), base_url_enc = COALESCE($2, base_url_enc), status = 'unknown', consecutive_failures = 0, updated_at = now() WHERE id = $3`,
      [nameEnc, baseUrlEnc, id],
    );
  }

  await audit(db, auth.userEmail, "gateway.update", "gateway", id, name);
  const resp = ok({ ok: true });
  // base_url may have changed — recompute even if only api_key/name changed,
  // computeEgressHosts is cheap (one query + N decrypts for a homelab-sized
  // gateway list) and staying correct here matters more than saving a reload.
  resp.restartHosts = await computeEgressHosts(db, encKey);
  return resp;
}

async function deleteGateway(db: ModuleDbClient, auth: ModuleAuthContext, id: string): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  await db.query(`DELETE FROM gateways WHERE id = $1`, [id]);
  await audit(db, auth.userEmail, "gateway.delete", "gateway", id);
  const encKey = await getEncKey();
  const resp = ok({ ok: true });
  resp.restartHosts = await computeEgressHosts(db, encKey);
  return resp;
}

async function refreshGateway(db: ModuleDbClient, id: string): Promise<HandlerResponse> {
  // Delegates to the same poll logic used by the cron job (Entscheidungsvorlage 1.3).
  // NOTE: this polls ALL gateways, not just `id` — pollGateways() has no
  // single-gateway mode. Pre-existing behavior, left as-is here; the id
  // lookup above only serves to 404 on an unknown id before doing so.
  const { default: pollGateways } = await import("../jobs/poll-gateways.ts");
  const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [id]);
  if (!gw) return notFound();
  // includePaused: true — see refreshAllGateways() for why a manual refresh
  // click should retry paused gateways instead of skipping them.
  await pollGateways({ db }, { includePaused: true });
  return ok({ ok: true });
}

async function refreshAllGateways(db: ModuleDbClient): Promise<HandlerResponse> {
  const { default: pollGateways } = await import("../jobs/poll-gateways.ts");
  // includePaused: true — an explicit admin click on "refresh all" is a
  // deliberate retry, unlike the every-minute cron tick which must keep
  // skipping paused gateways (circuit breaker, Entscheidungsvorlage 4.12).
  // A gateway that responds successfully this time un-pauses itself
  // automatically (pollSingleGateway resets consecutive_failures on
  // success) — no need to open and re-save each paused gateway by hand.
  await pollGateways({ db }, { includePaused: true });
  return ok({ ok: true });
}

// ── VLAN name lookups (fürs Onboarding-Formular-Dropdown) ────────────────────
// vlan_cache wird vom Cron-Poll-Job befüllt (→ 1.3); hier nur lesend distinct
// Namen aggregiert, da VLAN-Namen laut Ursprungs-Spec über alle Gateways
// identisch benannt sind (Dropdown zeigt Namen, nicht gateway-spezifische IDs).

async function listVlanNames(db: ModuleDbClient): Promise<HandlerResponse> {
  const rows = await db.query<{ vlan_name: string }>(
    `SELECT DISTINCT vlan_name FROM vlan_cache ORDER BY vlan_name`,
  );
  return ok(rows.map((r) => r.vlan_name));
}

async function listVlanNamesForGateway(db: ModuleDbClient, gatewayId: string): Promise<HandlerResponse> {
  const rows = await db.query<{ vlan_name: string }>(
    `SELECT vlan_name FROM vlan_cache WHERE gateway_id = $1 ORDER BY vlan_name`,
    [gatewayId],
  );
  return ok(rows.map((r) => r.vlan_name));
}

// ── Device handlers ──────────────────────────────────────────────────────────

async function listDevices(db: ModuleDbClient): Promise<HandlerResponse> {
  const devices = await db.query<DeviceRow>(`SELECT * FROM devices WHERE status = 'active' ORDER BY created_at DESC`);
  const encKey = await getEncKey();

  const result = [];
  for (const d of devices) {
    const gatewayRows = await db.query<DeviceGatewayRow & { gateway_name_enc: string }>(
      `SELECT dg.*, g.name_enc AS gateway_name_enc FROM device_gateways dg JOIN gateways g ON g.id = dg.gateway_id WHERE dg.device_id = $1`,
      [d.id],
    );
    result.push({
      id: d.id,
      // "name" entfernt (2026-07-01): note ist jetzt das einzige Freitextfeld.
      note: encKey ? await decrypt(encKey, d.note_enc).catch(() => "") : "",
      mac: encKey ? await decrypt(encKey, d.mac_enc).catch(() => "???") : "???",
      target_vlan_name: d.target_vlan_name,
      gateways: await Promise.all(
        gatewayRows.map(async (g) => ({
          gateway_id: g.gateway_id,
          gateway_name: encKey ? await decrypt(encKey, g.gateway_name_enc).catch(() => "???") : "???",
          last_seen_at: g.last_seen_at,
          note_discrepancy: g.note_discrepancy,
          // Ergänzt 2026-07-01: die tatsächlich auf diesem Gateway gesetzte
          // Notiz, damit der Diskrepanz-Dialog die konkreten Werte
          // nebeneinander zeigen kann (gleiches Muster wie zuvor gateway_alias
          // für "name", jetzt für "note").
          gateway_note:
            g.gateway_note_enc && encKey ? await decrypt(encKey, g.gateway_note_enc).catch(() => null) : null,
          provisioning_status: g.provisioning_status,
          provisioning_error: g.provisioning_error,
        })),
      ),
    });
  }
  return ok(result);
}

async function createDevice(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  input: DeviceInput,
): Promise<HandlerResponse> {
  let sanitized: string;
  try {
    sanitized = sanitizeMac(input.mac);
  } catch (err) {
    if (err instanceof InvalidMacError) return badRequest(err.message);
    throw err;
  }

  // note ist Pflichtfeld beim Anlegen (Entscheidungsvorlage 4.13). Kein
  // alias/Name-Feld mehr (2026-07-01) — note ist das einzige Freitextfeld.
  if (!input.note || input.note.trim().length === 0) {
    return badRequest("note is required");
  }

  const encKey = await getEncKey();
  const macHashKey = await getMacHashKey();
  if (!encKey || !macHashKey) {
    return { status: 500, body: { error: "Encryption keys not configured on server" } };
  }

  const macEnc = await encrypt(encKey, sanitized);
  const hash = await macHash(macHashKey, sanitized);
  const noteEnc = await encrypt(encKey, input.note);

  // Vorab-Check statt blindem INSERT (2026-07-01 ergänzt): mac_hash ist
  // UNIQUE — ohne diesen Check schlug ein INSERT für eine bereits bekannte
  // MAC (z. B. schon per Auto-Adopt übernommen, → 4.14, oder schon einmal
  // onboarded) mit einem rohen Postgres-Fehler durch statt einer
  // verständlichen Meldung.
  const [existing] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE mac_hash = $1`, [hash]);
  if (existing) {
    if (existing.status === "pending_approval") {
      return badRequest("device_mac_pending");
    }
    if (existing.status === "rejected") {
      return badRequest("device_mac_rejected");
    }
    return badRequest("device_mac_exists");
  }

  // Entscheidungsvorlage 4.7: onboarding never provisions immediately.
  // The device is stored as pending_approval; no RADIUS/user API calls happen
  // until an Org-Admin/Super-Admin approves it (see approveDevice()).
  const [row] = await db.query<DeviceRow>(
    `INSERT INTO devices (mac_enc, mac_hash, note_enc, target_vlan_name, status, created_by)
     VALUES ($1, $2, $3, $4, 'pending_approval', $5) RETURNING id`,
    [macEnc, hash, noteEnc, input.target_vlan_name, auth.userEmail],
  );

  // Store the requested target gateways as device_gateways rows with a
  // placeholder provisioning_status; the actual RADIUS/alias creation happens
  // in approveDevice().
  for (const gatewayId of input.target_gateway_ids) {
    await db.query(
      `INSERT INTO device_gateways (device_id, gateway_id, radius_account_id, provisioning_status)
       VALUES ($1, $2, '', 'ok')
       ON CONFLICT (device_id, gateway_id) DO NOTHING`,
      [row.id, gatewayId],
    );
  }

  await audit(db, auth.userEmail, "device.create", "device", row.id, input.note);

  // Notify admins live, the same way a new user account waiting for
  // approval already does (Core: auth.EventsHandler/"user.pending") —
  // reported 2026-07-04 as a gap: a submitted device previously sat
  // invisible in "pending" until an admin happened to check the list.
  const resp = created({ id: row.id, status: "pending_approval" });
  resp.notifications = [{
    message: handlerNotificationText.deviceWaitingApproval(input.note, sanitized, input.target_vlan_name, auth.userEmail),
    actionPath: "/modules/unifi-network?view=pending",
  }];
  return resp;
}

async function updateDevice(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  id: string,
  body: unknown,
): Promise<HandlerResponse> {
  const [device] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return notFound();

  // Entscheidungsvorlage 4.7: editing an already-approved device requires
  // Admin; a user can still amend their own not-yet-approved submission.
  if (device.status === "active" && !isAdmin(auth)) return forbidden();
  if (device.status === "pending_approval" && device.created_by !== auth.userEmail && !isAdmin(auth)) return forbidden();

  // "alias" entfernt (2026-07-01): note ist das einzige Freitextfeld.
  const { note, target_vlan_name } = body as { note?: string; target_vlan_name?: string };

  // note ist Pflichtfeld — darf beim Bearbeiten nicht auf leer gesetzt werden
  // (Entscheidungsvorlage 4.13). Ein explizit übergebenes, aber leeres note
  // wird abgelehnt; wird note im Body gar nicht mitgeschickt, bleibt der
  // bestehende Wert unverändert.
  if (note !== undefined && note.trim().length === 0) {
    return badRequest("note cannot be empty");
  }

  const encKey = await getEncKey();

  // Bugfix (2026-07-01): updateDevice() speicherte die Notiz bisher nur in
  // der eigenen DB (note_enc), schrieb sie aber nie an UniFi zurück — ein
  // Edit über die UI änderte im UniFi-WebIF nichts, obwohl dasselbe PUT per
  // Skript direkt funktioniert (bestätigt). Jetzt wird nach dem DB-Update
  // note per PUT /rest/user/{userAliasId} auf jedes Gateway geschrieben, auf
  // dem das Gerät bereits provisioniert ist (nur für aktive Geräte relevant
  // — bei pending_approval gibt es noch keine UniFi-Seite, die man
  // aktualisieren könnte).
  const syncResults: { gateway_id: string; status: "ok" | "skipped_no_user_alias" | "error"; error?: string }[] = [];

  if (note !== undefined && encKey) {
    const noteEnc = await encrypt(encKey, note);
    await db.query(`UPDATE devices SET note_enc = $1, updated_at = now() WHERE id = $2`, [noteEnc, id]);

    if (device.status === "active") {
      const gatewayRows = await db.query<DeviceGatewayRow>(
        `SELECT * FROM device_gateways WHERE device_id = $1`,
        [id],
      );
      for (const dg of gatewayRows) {
        if (!dg.user_alias_id) {
          syncResults.push({ gateway_id: dg.gateway_id, status: "skipped_no_user_alias" });
          continue;
        }
        const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [dg.gateway_id]);
        if (!gw) continue;
        try {
          const apiKey = await decrypt(encKey, gw.api_key_enc);
          const gwName = await decrypt(encKey, gw.name_enc).catch(() => "???");
          const baseUrl = await decrypt(encKey, gw.base_url_enc);
          const conn: GatewayConn = { name: gwName, baseUrl, apiKey };
          await updateUserNote(conn, dg.user_alias_id, note);
          // note_discrepancy sofort zurücksetzen, statt bis zum nächsten
          // Cron-Poll zu warten (gleiches Muster wie resolveNoteDiscrepancy()).
          const noteEncForGateway = await encrypt(encKey, note);
          await db.query(
            `UPDATE device_gateways SET note_discrepancy = false, gateway_note_enc = $1 WHERE device_id = $2 AND gateway_id = $3`,
            [noteEncForGateway, id, dg.gateway_id],
          );
          syncResults.push({ gateway_id: dg.gateway_id, status: "ok" });
        } catch (err) {
          // Fehler nicht verschlucken (gleicher Bugfix-Grundsatz wie in der
          // inzwischen entfernten resolveNameDiscrepancy() — ein
          // fehlgeschlagenes Zurückschreiben muss sichtbar sein statt
          // stillschweigend nichts zu tun).
          syncResults.push({ gateway_id: dg.gateway_id, status: "error", error: String(err) });
        }
      }
    }
  }

  if (target_vlan_name) {
    await db.query(`UPDATE devices SET target_vlan_name = $1, updated_at = now() WHERE id = $2`, [target_vlan_name, id]);
  }

  await audit(db, auth.userEmail, "device.update", "device", id);

  // Reported 2026-07-04: editing a device's note/VLAN produced no
  // notification at all. Only fires if something actually changed (note
  // and/or target_vlan_name present in the body) — a no-op PATCH shouldn't
  // notify anyone.
  const changedFields: string[] = [];
  if (note !== undefined) changedFields.push("note");
  if (target_vlan_name) changedFields.push("target_vlan_name");

  const resp = ok({ ok: true, results: syncResults });
  if (changedFields.length > 0 && encKey) {
    const finalNote = note ?? (await decrypt(encKey, device.note_enc).catch(() => "?"));
    const mac = await decrypt(encKey, device.mac_enc).catch(() => "?");
    const gatewayNames = new Map<string, string>();
    for (const r of syncResults) {
      const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [r.gateway_id]);
      if (gw) gatewayNames.set(gw.id, await decrypt(encKey, gw.name_enc).catch(() => "???"));
    }
    resp.notifications = [{
      message: handlerNotificationText.deviceUpdated(finalNote, mac, changedFields, syncResults, gatewayNames, auth.userEmail),
      actionPath: "/modules/unifi-network",
    }];
  }
  return resp;
}

// Ergänzt 2026-07-01: Ziel-Gateways eines bereits aktiven Geräts ändern —
// gleiche Checkbox-UI wie beim Onboarding, aktuell zugeordnete Gateways
// vorausgewählt. Neu angehakte Gateways werden provisioniert (wie beim
// Erstanlegen über approveDevice()/provisionOnGateway()), abgewählte über
// den bestehenden Teil-Lösch-Mechanismus entfernt (Entscheidungsvorlage 4.6,
// inkl. pending_deletions-Fallback bei nicht erreichbarem Gateway).
async function updateDeviceGateways(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  id: string,
  input: DeviceGatewaysInput,
): Promise<HandlerResponse> {
  const [device] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return notFound();

  // Gleiche Berechtigungslogik wie updateDevice()/deleteDevice() (→ 4.7):
  // Ändern der Provisionierung eines aktiven Geräts erfordert Admin.
  if (device.status === "active" && !isAdmin(auth)) return forbidden();
  if (device.status === "pending_approval" && device.created_by !== auth.userEmail && !isAdmin(auth)) return forbidden();

  const encKey = await getEncKey();
  if (!encKey) return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };

  const currentRows = await db.query<DeviceGatewayRow>(`SELECT * FROM device_gateways WHERE device_id = $1`, [id]);
  const currentGatewayIds = new Set(currentRows.map((r) => r.gateway_id));
  const newGatewayIds = new Set(input.target_gateway_ids);

  const toAdd = [...newGatewayIds].filter((gid) => !currentGatewayIds.has(gid));
  const toRemove = currentRows.filter((r) => !newGatewayIds.has(r.gateway_id));

  const results: GatewayProvisionResult[] = [];

  // Nur für bereits aktive Geräte wird tatsächlich provisioniert/gelöscht —
  // bei pending_approval-Geräten passiert (wie beim Erstanlegen) noch kein
  // API-Call, die Zuordnung wird nur als Platzhalterzeile vorgemerkt.
  if (device.status === "active") {
    const mac = await decrypt(encKey, device.mac_enc);
    const note = await decrypt(encKey, device.note_enc).catch(() => undefined);

    for (const gatewayId of toAdd) {
      results.push(await provisionOnGateway(db, gatewayId, id, mac, device.target_vlan_name, note));
    }
    for (const dg of toRemove) {
      await queueOrExecuteDeletion(db, id, dg.gateway_id, dg.radius_account_id, dg.user_alias_id);
      const [removedGw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [dg.gateway_id]);
      const removedGwName = removedGw ? await decrypt(encKey, removedGw.name_enc).catch(() => "???") : "?";
      results.push({ gateway_id: dg.gateway_id, gateway_name: removedGwName, status: "ok" });
    }
  } else {
    for (const gatewayId of toAdd) {
      await db.query(
        `INSERT INTO device_gateways (device_id, gateway_id, radius_account_id, provisioning_status)
         VALUES ($1, $2, '', 'ok')
         ON CONFLICT (device_id, gateway_id) DO NOTHING`,
        [id, gatewayId],
      );
    }
    for (const dg of toRemove) {
      await db.query(`DELETE FROM device_gateways WHERE device_id = $1 AND gateway_id = $2`, [id, dg.gateway_id]);
    }
  }

  await audit(db, auth.userEmail, "device.gateways_update", "device", id);

  const resp = ok({ ok: true, results });
  // Reported 2026-07-04: changing a device's target gateways produced no
  // notification. Only meaningful (and only actually calls the gateway
  // APIs) for already-active devices — a pending device's gateway checkbox
  // change is just bookkeeping ahead of approval, nothing an admin needs
  // to be told about live.
  if (device.status === "active" && (toAdd.length > 0 || toRemove.length > 0)) {
    const note = await decrypt(encKey, device.note_enc).catch(() => "?");
    const mac = await decrypt(encKey, device.mac_enc).catch(() => "?");
    const addedNames: string[] = [];
    const failedAdds: { gateway_name: string; error?: string }[] = [];
    for (const r of results) {
      if (toAdd.includes(r.gateway_id)) {
        if (r.status === "ok") addedNames.push(r.gateway_name);
        else failedAdds.push({ gateway_name: r.gateway_name, error: r.error });
      }
    }
    const removedNames = toRemove.map((dg) => {
      const r = results.find((res) => res.gateway_id === dg.gateway_id);
      return r?.gateway_name ?? dg.gateway_id;
    });
    resp.notifications = [{
      message: handlerNotificationText.deviceGatewaysChanged(note, mac, addedNames, removedNames, failedAdds, auth.userEmail),
      actionPath: "/modules/unifi-network",
    }];
  }
  return resp;
}

async function deleteDevice(db: ModuleDbClient, auth: ModuleAuthContext, id: string): Promise<HandlerResponse> {
  const [device] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return notFound();

  // Entscheidungsvorlage 4.7 (ergänzt 2026-07-01): Löschen eines bereits
  // aktiven Geräts verlangt Admin, analog zu updateDevice. Ein Nutzer darf
  // weiterhin seine eigene, noch nicht freigegebene Einreichung zurückziehen.
  if (device.status === "active" && !isAdmin(auth)) return forbidden();
  if (device.status === "pending_approval" && device.created_by !== auth.userEmail && !isAdmin(auth)) return forbidden();

  const gatewayRows = await db.query<DeviceGatewayRow>(`SELECT * FROM device_gateways WHERE device_id = $1`, [id]);

  // Gateway names collected BEFORE the delete loop below — device_gateways
  // rows disappear as part of that (queueOrExecuteDeletion / the delete
  // itself), so this is the last point they're cheaply available for the
  // notification text.
  const encKeyForNotify = await getEncKey();
  const deletedGatewayNames: string[] = [];
  for (const dg of gatewayRows) {
    if (encKeyForNotify) {
      const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [dg.gateway_id]);
      if (gw) deletedGatewayNames.push(await decrypt(encKeyForNotify, gw.name_enc).catch(() => "???"));
    }
    await queueOrExecuteDeletion(db, id, dg.gateway_id, dg.radius_account_id, dg.user_alias_id);
  }

  await db.query(`DELETE FROM devices WHERE id = $1`, [id]);
  await audit(db, auth.userEmail, "device.delete", "device", id);

  // Reported 2026-07-04: deleting a device produced no notification at
  // all, unlike creating/approving one. note/mac are best-effort here —
  // the row is already gone by this point, so a decrypt failure must not
  // fail the whole delete, just fall back to a generic label.
  const noteForNotify = encKeyForNotify
    ? await decrypt(encKeyForNotify, device.note_enc).catch(() => "?")
    : "?";
  const macForNotify = encKeyForNotify
    ? await decrypt(encKeyForNotify, device.mac_enc).catch(() => "?")
    : "?";
  const resp = ok({ ok: true });
  resp.notifications = [{
    message: handlerNotificationText.deviceDeleted(noteForNotify, macForNotify, deletedGatewayNames, auth.userEmail),
    actionPath: "/modules/unifi-network",
  }];
  return resp;
}

async function deleteDeviceFromGateway(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  deviceId: string,
  gatewayId: string,
): Promise<HandlerResponse> {
  // Entscheidungsvorlage 4.6: partial delete, same workflow as full delete but
  // scoped to a single gateway.
  const [dg] = await db.query<DeviceGatewayRow>(
    `SELECT * FROM device_gateways WHERE device_id = $1 AND gateway_id = $2`,
    [deviceId, gatewayId],
  );
  if (!dg) return notFound();

  await queueOrExecuteDeletion(db, deviceId, gatewayId, dg.radius_account_id, dg.user_alias_id);
  await audit(db, auth.userEmail, "device.gateway_remove", "device", deviceId, gatewayId);

  // Reported 2026-07-04: removing a device from a single gateway (partial
  // delete) produced no notification, unlike deleting it everywhere.
  const encKey = await getEncKey();
  const resp = ok({ ok: true });
  if (encKey) {
    const [device] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
    const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [gatewayId]);
    const note = device ? await decrypt(encKey, device.note_enc).catch(() => "?") : "?";
    const mac = device ? await decrypt(encKey, device.mac_enc).catch(() => "?") : "?";
    const gwName = gw ? await decrypt(encKey, gw.name_enc).catch(() => "???") : "?";
    resp.notifications = [{
      message: handlerNotificationText.deviceRemovedFromGateway(note, mac, gwName, auth.userEmail),
      actionPath: "/modules/unifi-network",
    }];
  }
  return resp;
}

async function queueOrExecuteDeletion(
  db: ModuleDbClient,
  deviceId: string,
  gatewayId: string,
  radiusAccountId: string,
  userAliasId: string | null,
): Promise<void> {
  const encKey = await getEncKey();
  const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [gatewayId]);

  if (!encKey || !gw || gw.status === "paused" || gw.status === "config_error") {
    // Entscheidungsvorlage 4.3: gateway currently unreachable/misconfigured —
    // queue for retry by the cron job instead of failing the whole request.
    await db.query(
      `INSERT INTO pending_deletions (device_id, gateway_id, radius_account_id, user_alias_id)
       VALUES ($1, $2, $3, $4)`,
      [deviceId, gatewayId, radiusAccountId, userAliasId],
    );
    return;
  }

  try {
    const apiKey = await decrypt(encKey, gw.api_key_enc);
    const gwName = await decrypt(encKey, gw.name_enc).catch(() => "???");
    const baseUrl = await decrypt(encKey, gw.base_url_enc);
    const conn: GatewayConn = { name: gwName, baseUrl, apiKey };
    // Bugfix (2026-07-01): RADIUS-Account und User-Alias sind zwei getrennte
    // UniFi-Objekte, aber das Löschen des Accounts entfernt teils bereits das
    // verknüpfte User-Objekt mit (oder umgekehrt) — ein zweiter DELETE-Aufruf
    // auf ein bereits verschwundenes Objekt lieferte dann "api.err.IdInvalid".
    // Das ließ den ganzen try-Block fehlschlagen, bevor die device_gateways-
    // Zeile gelöscht wurde: der RADIUS-Account war auf UniFi bereits weg, aber
    // ModuLab zeigte das Gateway weiterhin als zugewiesen an. Beide Deletes
    // laufen daher jetzt unabhängig voneinander und ein "schon nicht mehr
    // vorhanden"-Fehler (IdInvalid) wird als Erfolg gewertet.
    await deleteRadiusAccount(conn, radiusAccountId).catch((err) => {
      if (!isAlreadyGoneError(err)) throw err;
    });
    if (userAliasId) {
      await deleteUserAlias(conn, userAliasId).catch((err) => {
        if (!isAlreadyGoneError(err)) throw err;
      });
    }
    await db.query(`DELETE FROM device_gateways WHERE device_id = $1 AND gateway_id = $2`, [deviceId, gatewayId]);
  } catch (err) {
    await db.query(
      `INSERT INTO pending_deletions (device_id, gateway_id, radius_account_id, user_alias_id, last_error)
       VALUES ($1, $2, $3, $4, $5)`,
      [deviceId, gatewayId, radiusAccountId, userAliasId, String(err)],
    );
  }
}

// ── Onboarding approval (Entscheidungsvorlage 4.7) ──────────────────────────

async function listPendingDevices(db: ModuleDbClient, auth: ModuleAuthContext): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  const rows = await db.query<DeviceRow>(`SELECT * FROM devices WHERE status = 'pending_approval' ORDER BY created_at`);
  const encKey = await getEncKey();

  const result = [];
  for (const d of rows) {
    // Ergänzt 2026-07-01: Ziel-Gateways mitliefern, damit die
    // Freigabe-Liste zeigen kann, für welche Gateways ein Gerät angefragt
    // wurde — createDevice() legt dafür bereits Platzhalter-Zeilen in
    // device_gateways an, wurden bisher aber nie mit ausgeliefert.
    const targetGatewayRows = await db.query<{ gateway_name_enc: string }>(
      `SELECT g.name_enc AS gateway_name_enc FROM device_gateways dg JOIN gateways g ON g.id = dg.gateway_id WHERE dg.device_id = $1`,
      [d.id],
    );
    const targetGatewayNames = (
      await Promise.all(
        targetGatewayRows.map((g) => (encKey ? decrypt(encKey, g.gateway_name_enc).catch(() => "???") : Promise.resolve("???"))),
      )
    ).sort((a, b) => a.localeCompare(b));
    result.push({
      id: d.id,
      // "alias" entfernt (2026-07-01): note ist das einzige Freitextfeld.
      note: encKey ? await decrypt(encKey, d.note_enc).catch(() => "???") : "???",
      mac: encKey ? await decrypt(encKey, d.mac_enc).catch(() => "???") : "???",
      target_vlan_name: d.target_vlan_name,
      target_gateway_names: targetGatewayNames,
      created_by: d.created_by,
      created_at: d.created_at,
    });
  }
  return ok(result);
}

async function approveDevice(db: ModuleDbClient, auth: ModuleAuthContext, id: string): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();

  const [device] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return notFound();
  if (device.status !== "pending_approval") return badRequest("Device is not pending approval");

  const encKey = await getEncKey();
  if (!encKey) return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };

  const mac = await decrypt(encKey, device.mac_enc);
  const note = await decrypt(encKey, device.note_enc).catch(() => undefined);

  const targetGateways = await db.query<{ gateway_id: string }>(
    `SELECT gateway_id FROM device_gateways WHERE device_id = $1`,
    [id],
  );

  const results: GatewayProvisionResult[] = [];

  // Entscheidungsvorlage 4.8: gateway loop runs independently per gateway —
  // a VLAN-not-found (or any other) failure on one gateway does not block
  // provisioning on the others (partial success, reported per gateway).
  for (const { gateway_id } of targetGateways) {
    results.push(await provisionOnGateway(db, gateway_id, device.id, mac, device.target_vlan_name, note));
  }

  await db.query(`UPDATE devices SET status = 'active', approved_by = $1, approved_at = now() WHERE id = $2`, [
    auth.userEmail,
    id,
  ]);
  await audit(db, auth.userEmail, "device.approve", "device", id, note);

  // Notify admins only now, after every gateway in the loop has actually
  // responded (results is built from provisionOnGateway's return value per
  // gateway, above) — reported 2026-07-04: an admin approving a device
  // previously got no confirmation at all that it actually finished
  // provisioning, only the synchronous HTTP response to their own request.
  // Other admin sessions watching the notification panel had no visibility
  // into this at all.
  const resp = ok({ status: "active", results });
  resp.notifications = [{
    message: handlerNotificationText.deviceApproved(note ?? "?", mac, device.target_vlan_name, results, auth.userEmail),
    actionPath: "/modules/unifi-network",
  }];
  return resp;
}

async function provisionOnGateway(
  db: ModuleDbClient,
  gatewayId: string,
  deviceId: string,
  mac: string,
  targetVlanName: string,
  note?: string,
): Promise<GatewayProvisionResult> {
  const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [gatewayId]);
  if (!gw) return { gateway_id: gatewayId, gateway_name: "?", status: "error", error: "Gateway not found" };

  const encKey = await getEncKey();
  if (!encKey) return { gateway_id: gatewayId, gateway_name: "???", status: "error", error: "Encryption key missing" };

  const gwName = await decrypt(encKey, gw.name_enc).catch(() => "???");

  try {
    const apiKey = await decrypt(encKey, gw.api_key_enc);
    const baseUrl = await decrypt(encKey, gw.base_url_enc);
    const conn: GatewayConn = { name: gwName, baseUrl, apiKey };

    // Entscheidungsvorlage 4.5: sanitize again at the start of the gateway
    // loop (defense in depth), even though the caller already sanitized it.
    const sanitized = sanitizeMac(mac);

    const [vlan] = await db.query<{ unifi_vlan_uid: string; vlan_number: number }>(
      `SELECT unifi_vlan_uid, vlan_number FROM vlan_cache WHERE gateway_id = $1 AND vlan_name = $2`,
      [gatewayId, targetVlanName],
    );

    if (!vlan) {
      // Entscheidungsvorlage 4.8: VLAN not found on this gateway — skip only
      // this gateway, report the specific failure, do not abort the loop.
      await db.query(
        `INSERT INTO device_gateways (device_id, gateway_id, radius_account_id, provisioning_status, provisioning_error)
         VALUES ($1, $2, '', 'vlan_not_found', $3)
         ON CONFLICT (device_id, gateway_id)
         DO UPDATE SET provisioning_status = 'vlan_not_found', provisioning_error = $3`,
        [deviceId, gatewayId, `VLAN "${targetVlanName}" not found on gateway "${gwName}"`],
      );
      return {
        gateway_id: gatewayId,
        gateway_name: gwName,
        status: "vlan_not_found",
        error: `VLAN "${targetVlanName}" not found`,
      };
    }

    // Bugfix (2026-07-01, Entscheidungsvorlage 4.27): wird ein Gateway erst
    // ab- und dann wieder zugewählt (oder existierte auf UniFi bereits vorher
    // ein Account/Alias mit dieser MAC, z.B. ein Leftover aus einem zuvor
    // fehlgeschlagenen Löschvorgang), lehnt UniFi das Neuanlegen mit
    // "api.err.MacUsed" / "api.err.DuplicateAccountName" ab. Statt die ganze
    // Zuweisung fehlschlagen zu lassen, wird in diesem Fall der bestehende
    // Account/Alias per MAC gesucht und übernommen (Update statt Create).
    let radiusAccount: UnifiRadiusAccount;
    try {
      radiusAccount = await createRadiusAccount(conn, sanitized, vlan.vlan_number);
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
      const existing = (await fetchRadiusAccounts(conn)).find((a) => a.name === sanitized);
      if (!existing) throw err;
      await updateRadiusAccount(conn, existing._id, sanitized, vlan.vlan_number);
      radiusAccount = existing;
    }

    // "name" entfernt (2026-07-01): nur noch note wird bei UniFi gesetzt.
    // note ist auf devices.note_enc Pflichtfeld, kann hier also nicht leer
    // sein — der Fallback ("") ist nur eine defensive Typ-Absicherung.
    let userAlias: UnifiUser;
    try {
      userAlias = await createUserNote(conn, sanitized, note ?? "");
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
      const existingUser = (await fetchUsers(conn)).find((u) => u.mac === sanitized);
      if (!existingUser) throw err;
      await updateUserNote(conn, existingUser._id, note ?? "");
      userAlias = existingUser;
    }

    await db.query(
      `INSERT INTO device_gateways
         (device_id, gateway_id, radius_account_id, user_alias_id, resolved_vlan_id, provisioning_status, provisioning_error)
       VALUES ($1, $2, $3, $4, $5, 'ok', NULL)
       ON CONFLICT (device_id, gateway_id)
       DO UPDATE SET radius_account_id = $3, user_alias_id = $4, resolved_vlan_id = $5, provisioning_status = 'ok', provisioning_error = NULL`,
      [deviceId, gatewayId, radiusAccount._id, userAlias._id, vlan.unifi_vlan_uid],
    );

    return { gateway_id: gatewayId, gateway_name: gwName, status: "ok" };
  } catch (err) {
    await db.query(
      `UPDATE device_gateways SET provisioning_status = 'error', provisioning_error = $1 WHERE device_id = $2 AND gateway_id = $3`,
      [String(err), deviceId, gatewayId],
    );
    return { gateway_id: gatewayId, gateway_name: gwName, status: "error", error: String(err) };
  }
}

async function rejectDevice(db: ModuleDbClient, auth: ModuleAuthContext, id: string): Promise<HandlerResponse> {
  if (!isAdmin(auth)) return forbidden();
  // No API calls were ever made for a pending_approval device — safe to just discard.
  //
  // Ergänzt 2026-07-01: vorher wurde die Zeile nur auf status='rejected'
  // gesetzt, nie gelöscht — wegen des UNIQUE-Constraints auf mac_hash
  // (→ 4.18) blockierte das jede erneute Einreichung derselben MAC dauerhaft.
  // Ablehnung soll aber kein permanentes Verbot sein; die Zeile (inkl. der
  // Platzhalter-device_gateways-Zeilen aus createDevice()) wird jetzt
  // tatsächlich gelöscht. Der audit()-Eintrag bleibt als Nachweis bestehen,
  // dass die Ablehnung stattgefunden hat.
  //
  // Loaded BEFORE the delete so note/mac are available for the
  // notification below (reported 2026-07-04 as another gap, alongside
  // approve/delete — an admin rejecting a submission gave no live signal
  // to other admins either).
  const [device] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return notFound();

  await db.query(`DELETE FROM device_gateways WHERE device_id = $1`, [id]);
  await db.query(`DELETE FROM devices WHERE id = $1`, [id]);
  await audit(db, auth.userEmail, "device.reject", "device", id);

  const encKey = await getEncKey();
  const note = encKey ? await decrypt(encKey, device.note_enc).catch(() => "?") : "?";
  const mac = encKey ? await decrypt(encKey, device.mac_enc).catch(() => "?") : "?";
  const resp = ok({ status: "rejected" });
  resp.notifications = [{
    message: handlerNotificationText.deviceRejected(note, mac, auth.userEmail),
    actionPath: "/modules/unifi-network?view=pending",
  }];
  return resp;
}

// Namensdiskrepanz-Mechanismus (Entscheidungsvorlage 4.4) komplett entfernt
// (2026-07-01): baute ausschließlich auf dem UniFi-name-Feld auf, das nicht
// mehr genutzt wird — siehe Migration 0004_remove_name_use_note_only.sql.
// Direkt danach wieder eingeführt, diesmal für "note" (→ resolveNoteDiscrepancy
// unten), da note ebenfalls pro Gateway auseinanderlaufen kann, wenn direkt
// im UniFi-WebIF geändert statt über das Modul (Migration 0005_note_discrepancy.sql).

async function resolveNoteDiscrepancy(
  db: ModuleDbClient,
  auth: ModuleAuthContext,
  deviceId: string,
  body: unknown,
): Promise<HandlerResponse> {
  const { canonical_note } = body as { canonical_note?: string };
  if (!canonical_note || canonical_note.trim().length === 0) return badRequest("canonical_note is required");

  const encKey = await getEncKey();
  if (!encKey) return { status: 500, body: { error: "MODULAB_ENCRYPTION_KEY not configured on server" } };

  // Loaded before the update so the notification below can mention the
  // device's prior note, not just the new canonical one — helps an admin
  // recognize which device this was about without needing to already have
  // the device list open.
  const [deviceBefore] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
  const priorNote = deviceBefore ? await decrypt(encKey, deviceBefore.note_enc).catch(() => "?") : "?";

  const noteEnc = await encrypt(encKey, canonical_note);
  await db.query(`UPDATE devices SET note_enc = $1, updated_at = now() WHERE id = $2`, [noteEnc, deviceId]);

  const gatewayRows = await db.query<DeviceGatewayRow>(`SELECT * FROM device_gateways WHERE device_id = $1`, [deviceId]);

  // Gleiches Fehlerbehandlungs-Muster wie im ursprünglichen
  // resolveNameDiscrepancy(): Ergebnisse pro Gateway sammeln und
  // zurückgeben, statt einen Fehlschlag stillschweigend zu verschlucken.
  const results: { gateway_id: string; status: "ok" | "skipped_no_user_alias" | "error"; error?: string }[] = [];

  for (const dg of gatewayRows) {
    if (!dg.user_alias_id) {
      results.push({ gateway_id: dg.gateway_id, status: "skipped_no_user_alias" });
      continue;
    }
    const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [dg.gateway_id]);
    if (!gw) continue;

    try {
      const apiKey = await decrypt(encKey, gw.api_key_enc);
      const gwName = await decrypt(encKey, gw.name_enc).catch(() => "???");
      const baseUrl = await decrypt(encKey, gw.base_url_enc);
      const conn: GatewayConn = { name: gwName, baseUrl, apiKey };
      await updateUserNote(conn, dg.user_alias_id, canonical_note);
      const canonicalNoteEnc = await encrypt(encKey, canonical_note);
      await db.query(
        `UPDATE device_gateways SET note_discrepancy = false, gateway_note_enc = $1 WHERE device_id = $2 AND gateway_id = $3`,
        [canonicalNoteEnc, deviceId, dg.gateway_id],
      );
      results.push({ gateway_id: dg.gateway_id, status: "ok" });
    } catch (err) {
      // Fehler nicht verschlucken — bleibt note_discrepancy = true, wird
      // beim nächsten Cron-Poll erneut erkannt und kann erneut versucht werden.
      results.push({ gateway_id: dg.gateway_id, status: "error", error: String(err) });
    }
  }

  await audit(db, auth.userEmail, "device.resolve_note", "device", deviceId, canonical_note);

  // Reported 2026-07-04: resolving a note discrepancy produced no
  // notification. Uses the device's PRIOR note (before this resolution) to
  // identify it, since that's the note an admin browsing the device list
  // would have recognized it by.
  const gatewayNames = new Map<string, string>();
  for (const r of results) {
    const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [r.gateway_id]);
    if (gw) gatewayNames.set(gw.id, await decrypt(encKey, gw.name_enc).catch(() => "???"));
  }
  const resp = ok({ ok: true, results });
  resp.notifications = [{
    message: handlerNotificationText.noteDiscrepancyResolved(priorNote, canonical_note, results, gatewayNames, auth.userEmail),
    actionPath: "/modules/unifi-network",
  }];
  return resp;
}
