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
}

export interface HandlerResponse {
  status: number;
  body: unknown;
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
}

// ── Domain types ─────────────────────────────────────────────────────────────

export type GatewayStatus = "online" | "offline" | "config_error" | "paused" | "unknown";

export interface GatewayRow {
  id: string;
  name: string;
  base_url: string;
  api_key_enc: string;
  status: GatewayStatus;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type DeviceStatus = "pending_approval" | "active" | "rejected";

export interface DeviceRow {
  id: string;
  mac_enc: string;
  mac_hash: string;
  alias_enc: string;      // UniFi-Feld "name" — kanonischer Alias, Namensdiskrepanz-Sync-Ziel
  note_enc: string;       // UniFi-Feld "note" — freier Kommentar, z.B. "iPhone Kay". Pflichtfeld, nicht Teil des Namensdiskrepanz-Mechanismus
  target_vlan_name: string;
  status: DeviceStatus;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ProvisioningStatus = "ok" | "vlan_not_found" | "error";

export interface DeviceGatewayRow {
  device_id: string;
  gateway_id: string;
  radius_account_id: string;
  user_alias_id: string | null;
  resolved_vlan_id: string | null;
  last_seen_at: string | null;
  name_discrepancy: boolean;
  gateway_alias_enc: string | null; // AES-256-GCM verschlüsselt — auf diesem Gateway tatsächlich gesetzter Name, NULL falls nie gesetzt
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
  alias: string;                // -> UniFi "name" field
  note: string;                  // -> UniFi "note" field, required, e.g. "iPhone Kay"
  target_vlan_name: string;
  target_gateway_ids: string[]; // checkboxes in the form
}

// Result of provisioning a single gateway during the onboarding loop.
export interface GatewayProvisionResult {
  gateway_id: string;
  gateway_name: string;
  status: ProvisioningStatus;
  error?: string;
}
