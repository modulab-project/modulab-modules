// Type definitions mirroring the ModuLab Module SDK (modulab-module-sdk).
// Kept local so the module has no external dependencies at runtime.
// (Same pattern as modulab-modules/my-place/handlers/types.ts.)

export interface ModuleAuthContext {
  userId: string;
  userEmail: string;
  userName: string;
  roles: string[];
  scopes: string[];
}

export interface HandlerRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  auth: ModuleAuthContext;
  db: ModuleDbClient;
  storage: ModuleStorageClient;
  // crypto.key/hashKey stay the OLD raw shared key/hashKey (unchanged from
  // before this module's PII rotation feature existed) until POST
  // /admin/migrate-pii-key has re-encrypted every PII column and
  // recomputed every mac_hash, and Core records pii_migrated_at (see
  // docs/Modul-DB-Sandbox_Plan_2026-08-02.md Part B) - only THEN does
  // crypto switch to this module's own derived key/hashKey. Never assume
  // crypto.key/hashKey are already derived.
  crypto: ModulePiiCrypto;
  // legacyCrypto carries this module's NEW derived key/hashKey, granted
  // only during that same pre-migration window, purely as the
  // re-encryption target for the migrate-pii-key handler below - key/
  // hashKey are both null once migration is done. Nothing else in this
  // module should read legacyCrypto.
  legacyCrypto: ModulePiiCrypto;
}

// ModulePiiCrypto carries the module-scoped PII encryption key material,
// built once by Core's bootstrap script (backend/internal/modules/deno.go's
// loadPiiCrypto) from MODULAB_MODULE_PII_KEY and passed explicitly into
// every handler/job call - never read from an env var or any global by this
// module's own code. key/hashKey are null if the env var is unset or
// malformed on Core's side; module code must treat that as "not configured"
// (same contract getEncKey()/getMacHashKey() -> null had before this was
// moved to Core, 2026-07-16).
export interface ModulePiiCrypto {
  key: CryptoKey | null;
  // hashKey (HMAC-SHA256) backs mac_hash, the deterministic blind index used
  // for MAC lookups alongside probabilistic AES-GCM encryption - see
  // handlers/crypto.ts's doc comment for why this reuses the same raw key
  // material as `key` instead of a second, separate env var.
  hashKey: CryptoKey | null;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
  // restartHosts, when set, asks Core to restart this module's Deno worker
  // with an updated --allow-net host list (Core: WorkerResponse.RestartHosts
  // in backend/internal/modules/deno.go). unifi-network is the one module
  // whose outbound targets (gateway base URLs) are only known at runtime —
  // see requestEgressReload() in handlers/index.ts, called after
  // createGateway/updateGateway/deleteGateway write to the gateways table.
  restartHosts?: string[];
  // notifications, when set, asks Core to publish each one to
  // notify.AdminChannel() (Core: WorkerResponse.Notifications, deno.go) so
  // every connected admin's SSE stream picks it up live. Not currently used
  // from an HTTP handler in this module — an admin who just triggered a
  // change (e.g. approving a device) already sees the result synchronously
  // in that request's own response. Kept here for symmetry with
  // restartHosts and in case a future handler needs it; the actual
  // notification emitters today are poll-gateways.ts's job return value
  // (see ModuleJobResult in jobs/poll-gateways.ts).
  notifications?: ModuleNotification[];
}

// Mirrors Core's ModuleNotification (backend/internal/modules/deno.go).
//
// message carries the FULLY RENDERED text in every language ModuLab's UI
// supports ({de: "...", en: "..."}) — not a type key + raw data for Core to
// translate. Core has no locale entries for this module and must never
// need any: the module owns its own strings (see localizeGatewayName-style
// helpers in jobs/poll-gateways.ts) and hands Core the finished text.
export interface ModuleNotification {
  message: { de: string; en: string };
  // actionPath, when set, is where Core navigates to if the admin clicks
  // this notification (e.g. "/modules/unifi-network?view=pending"). Core
  // has no route table for this module, so it cannot derive a sensible
  // destination on its own — it previously hardcoded every module
  // notification's click target to the installed-modules list, which is
  // rarely where an admin needs to go to act on it (reported 2026-07-04).
  actionPath?: string;
}

export interface ModuleDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface ModuleStorageClient {
  write(path: string, data: Uint8Array, contentType: string): Promise<void>;
  delete(path: string): Promise<void>;
  url(path: string): string;
}

// ── Job handler contract (separate from HTTP HandlerRequest/-Response) ───────
// Jobs run on their own resources.timeout budget (Default 5 min., vs. 10s for
// API calls) and have no `path`/`method` — they are invoked directly by name.

export interface JobContext {
  db: ModuleDbClient;
  crypto: ModulePiiCrypto;
}

// ── Domain types ─────────────────────────────────────────────────────────────

export type GatewayStatus = "online" | "offline" | "config_error" | "paused" | "unknown";

export interface GatewayRow {
  id: string;
  name_enc: string; // AES-256-GCM verschlüsselt — Standortname (ergänzt 2026-07-01, war zuvor Klartext)
  base_url_enc: string; // AES-256-GCM verschlüsselt — interner Hostname/IP (ergänzt 2026-07-01, war zuvor Klartext)
  api_key_enc: string;
  status: GatewayStatus;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_error: string | null;
  created_by_enc: string; // AES-256-GCM verschlüsselt — E-Mail-Adresse (ergänzt 2026-07-01, war zuvor Klartext)
  created_at: string;
  updated_at: string;
}

export type DeviceStatus = "pending_approval" | "active" | "rejected";

// PendingAction is set on an active device when a non-Admin has requested a
// change that needs Admin approval (Migration 0006). Null on every device
// with no outstanding request, including all pending_approval/rejected
// devices — this mechanism only ever applies to already-active devices.
export type PendingAction = "edit" | "delete" | "gateway_change" | null;

export interface DeviceRow {
  id: string;
  mac_enc: string;
  mac_hash: string;
  // alias_enc entfernt (2026-07-01): Name-Konzept komplett gestrichen,
  // note_enc ist jetzt das einzige Freitextfeld, sowohl kanonisch als auch
  // beim Zurückschreiben auf UniFi (Nutzerentscheidung: "nur noch Notiz").
  note_enc: string;       // UniFi-Feld "note" — einziges Freitextfeld, z.B. "iPhone Kay". Pflichtfeld.
  target_vlan_name: string;
  status: DeviceStatus;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  // pending_* (Migration 0006): a change request awaiting Admin approval,
  // only ever set on an active device. See PendingAction's doc comment and
  // the migration's own header comment for the full mechanism.
  pending_action: PendingAction;
  pending_note_enc: string | null;
  pending_target_vlan_name: string | null;
  pending_target_gateway_ids: string[] | null;
  pending_requested_by: string | null;
  pending_requested_at: string | null;
}

export type ProvisioningStatus = "ok" | "vlan_not_found" | "error";

export interface DeviceGatewayRow {
  device_id: string;
  gateway_id: string;
  radius_account_id: string;
  user_alias_id: string | null;
  resolved_vlan_id: string | null;
  last_seen_at: string | null;
  // name_discrepancy/gateway_alias_enc entfernt (2026-07-01): der
  // ursprüngliche Namensdiskrepanz-Mechanismus entfiel zusammen mit dem
  // UniFi-name-Feld. Direkt danach aber wieder eingeführt für "note" (die
  // Notiz kann ebenso pro Gateway auseinanderlaufen, wenn sie direkt im
  // UniFi-WebIF geändert wird statt über das Modul) — siehe Migration
  // 0005_note_discrepancy.sql.
  note_discrepancy: boolean;
  gateway_note_enc: string | null; // AES-256-GCM verschlüsselt — auf diesem Gateway tatsächlich gesetzte Notiz, NULL falls noch nie gepollt
  provisioning_status: ProvisioningStatus;
  provisioning_error: string | null;
  provisioned_at: string;
}

export interface VlanCacheRow {
  gateway_id: string;
  unifi_vlan_uid: string;
  vlan_name: string;
  vlan_number: number;
  fetched_at: string;
}

export interface PendingDeletionRow {
  id: string;
  device_id: string;
  gateway_id: string;
  radius_account_id: string;
  user_alias_id: string | null;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  created_at: string;
  last_attempted_at: string | null;
}

// Input shape for the onboarding form (POST /devices).
export interface DeviceInput {
  mac: string;                 // raw, will be run through sanitizeMac()
  // alias entfernt (2026-07-01): kein UniFi "name" mehr, nur noch note.
  note: string;                  // -> UniFi "note" field, required, e.g. "iPhone Kay"
  target_vlan_name: string;
  target_gateway_ids: string[]; // checkboxes in the form
}

// Input shape for changing an existing device's target gateways
// (PATCH /devices/:id/gateways) — same checkbox UI as onboarding, but for
// an already-active device. Newly checked gateways get provisioned, unchecked
// ones go through the existing partial-delete flow (Entscheidungsvorlage 4.6).
export interface DeviceGatewaysInput {
  target_gateway_ids: string[];
}

// Result of provisioning a single gateway during the onboarding loop.
export interface GatewayProvisionResult {
  gateway_id: string;
  gateway_name: string;
  status: ProvisioningStatus;
  error?: string;
}

// Input shape for requesting a change to a device's note/VLAN
// (PATCH /devices/:id) — same body as the direct-edit path; whether it is
// applied immediately or turned into a pending request depends on the
// caller's role and the device's current status (see updateDevice()).
export interface DeviceEditInput {
  note?: string;
  target_vlan_name?: string;
}

// One row of GET /devices/pending-changes (Admin only) — a device with a
// non-null pending_action, decrypted and shaped for the review UI.
export interface PendingDeviceChange {
  id: string;
  note: string;
  mac: string;
  pending_action: Exclude<PendingAction, null>;
  // Populated only when pending_action = 'edit' and that field was part of
  // the request (undefined otherwise, not an empty string, so the UI can
  // tell "no change requested here" apart from "change requested to blank").
  pending_note?: string;
  pending_target_vlan_name?: string;
  // Populated only when pending_action = 'gateway_change' - the proposed
  // full new set of gateway names (already resolved from ids for display).
  pending_target_gateway_names?: string[];
  requested_by: string;
  requested_at: string;
}
