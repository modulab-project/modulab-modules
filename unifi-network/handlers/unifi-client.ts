// ── UniFi API client ──────────────────────────────────────────────────────────
//
// Thin fetch wrapper per gateway, kept strictly separate from handler/UI logic
// (Ursprungs-Spec, technische Anforderungen: "Trenne API-Aufrufe und
// Verschlüsselungslogik strikt von der UI-Darstellung").
//
// VERIFIED (2026-07-01) against a working reference implementation (a real
// Next.js/Prisma project using the same pattern): the legacy local `/rest/`
// API DOES accept X-API-KEY auth on current UDM controllers, despite not
// being part of the newer official developer.ui.com Cloud API (that Cloud API
// — Networks/Firewall/ACLs/etc. — has no endpoint for individual RADIUS
// MAC-auth users or client aliases at all; it was a dead end for this
// module's core feature). So: only the new UDM proxy path prefix is used
// (Entscheidungsvorlage 4.1 confirmed correct), auth is X-API-KEY (confirmed),
// but the RADIUS account's VLAN is assigned via a plain `vlan` field (the
// VLAN number), NOT `tunnel_private_group_id` as originally assumed from the
// Ursprungs-Spec — `tunnel_type`/`tunnel_medium_type` are still sent alongside
// it, per the reference implementation.
//
// Still unverified: /rest/networkconf, /rest/user, /stat/alluser exact
// response shapes (the reference implementation only covered /rest/account).

const API_PREFIX = "/proxy/network/api/s/default";
const DEFAULT_TIMEOUT_MS = 5000; // per-gateway timeout, independent from the job/handler resources.timeout

export class GatewayUnreachableError extends Error {
  constructor(gatewayName: string, cause: unknown) {
    super(`Gateway "${gatewayName}" unreachable: ${String(cause)}`);
    this.name = "GatewayUnreachableError";
  }
}

export class PrivateHostViolationError extends Error {
  constructor(baseUrl: string) {
    super(`Gateway base URL "${baseUrl}" does not resolve to a private IP range — refusing to connect`);
    this.name = "PrivateHostViolationError";
  }
}

// ── Private-IP validation (Entscheidungsvorlage Abschnitt 1.2) ──────────────
//
// Application-level check, NOT a real Deno sandbox boundary (Deno's
// --allow-net has no CIDR matching). Prevents accidental/malicious
// configuration of public hosts; a compromised handler could bypass this.
// RFC1918 ranges + .local/mDNS hostnames are treated as private.

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true; // loopback, harmless to allow
  return false;
}

export function isPrivateHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  if (host.endsWith(".local")) return true;
  return isPrivateIPv4(host);
}

// ── Low-level request helper ────────────────────────────────────────────────

interface GatewayConn {
  name: string;
  baseUrl: string;
  apiKey: string; // already decrypted by caller
}

async function unifiFetch<T>(
  conn: GatewayConn,
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  if (!isPrivateHost(conn.baseUrl)) {
    throw new PrivateHostViolationError(conn.baseUrl);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Entscheidungsvorlage 4.2 (revidiert 2026-07-01): kein Sonderfall für
    // self-signed-Zertifikate mehr nötig. UniFi unterstützt inzwischen
    // Let's-Encrypt-Zertifikate für den Controller; Voraussetzung für dieses
    // Modul ist, dass jedes Gateway ein über eine öffentlich vertrauenswürdige
    // CA validierbares Zertifikat nutzt (im Modul-README zu dokumentieren).
    // Damit reicht normales fetch() mit Standard-Zertifikatsvalidierung — kein
    // Deno.createHttpClient(), kein prozessweites --unsafely-ignore-*-Flag.
    const res = await fetch(`${conn.baseUrl}${API_PREFIX}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "X-API-KEY": conn.apiKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json() as T;
  } catch (err) {
    throw new GatewayUnreachableError(conn.name, err);
  } finally {
    clearTimeout(timer);
  }
}

// ── Response shapes (assumed — verify against real controller) ──────────────

export interface UnifiNetworkConf {
  _id: string;
  name: string;
  vlan_enabled: boolean;
  vlan?: number;
}

export interface UnifiRadiusAccount {
  _id: string;
  name: string; // sanitized MAC
  x_password?: string;
  tunnel_type?: number;
  tunnel_medium_type?: number;
  vlan?: number; // verified field name (2026-07-01) — NOT tunnel_private_group_id
}

export interface UnifiUser {
  _id: string;
  mac: string;
  name?: string; // verified (2026-07-01): manually set alias, only present once set via the UniFi UI/API
  note?: string; // verified (2026-07-01): separate free-text field, independent of `name` (e.g. "iPhone Kay")
  noted?: boolean; // set to true by the controller once `note` has been set
  hostname?: string; // reported by the device itself, NOT something this module writes
}

export interface UnifiClientHistoryEntry {
  mac: string;
  last_seen?: number; // unix timestamp (seconds)
}

interface UnifiListResponse<T> {
  data: T[];
}

// ── Endpoints used by this module ────────────────────────────────────────────
// (stat/sysinfo intentionally omitted — WAN-IP/ISP is out of scope for v1,
// Entscheidungsvorlage Abschnitt 3.)

export async function fetchVlans(conn: GatewayConn): Promise<UnifiNetworkConf[]> {
  const res = await unifiFetch<UnifiListResponse<UnifiNetworkConf>>(conn, "/rest/networkconf");
  return res.data.filter((n) => n.vlan_enabled);
}

export async function fetchRadiusAccounts(conn: GatewayConn): Promise<UnifiRadiusAccount[]> {
  const res = await unifiFetch<UnifiListResponse<UnifiRadiusAccount>>(conn, "/rest/account");
  return res.data;
}

export async function fetchUsers(conn: GatewayConn): Promise<UnifiUser[]> {
  const res = await unifiFetch<UnifiListResponse<UnifiUser>>(conn, "/rest/user");
  return res.data;
}

export async function fetchClientHistory(conn: GatewayConn): Promise<UnifiClientHistoryEntry[]> {
  const res = await unifiFetch<UnifiListResponse<UnifiClientHistoryEntry>>(conn, "/stat/alluser");
  return res.data;
}

export async function createRadiusAccount(
  conn: GatewayConn,
  mac: string,
  vlanNumber: number,
): Promise<UnifiRadiusAccount> {
  const res = await unifiFetch<{ data: UnifiRadiusAccount[] }>(conn, "/rest/account", {
    method: "POST",
    body: JSON.stringify({
      name: mac,
      x_password: mac, // UniFi-Standardverhalten für MAB, siehe Entscheidungsvorlage 4.9 — bewusst so übernommen
      tunnel_type: 13,
      tunnel_medium_type: 6,
      vlan: vlanNumber, // verified (2026-07-01): plain VLAN number, not tunnel_private_group_id
    }),
  });
  return res.data[0];
}

export async function updateRadiusAccount(
  conn: GatewayConn,
  accountId: string,
  mac: string,
  vlanNumber: number,
): Promise<void> {
  await unifiFetch(conn, `/rest/account/${accountId}`, {
    method: "PUT",
    body: JSON.stringify({
      name: mac,
      x_password: mac,
      tunnel_type: 13,
      tunnel_medium_type: 6,
      vlan: vlanNumber,
    }),
  });
}

export async function deleteRadiusAccount(conn: GatewayConn, accountId: string): Promise<void> {
  await unifiFetch(conn, `/rest/account/${accountId}`, { method: "DELETE" });
}

export async function createUserAlias(
  conn: GatewayConn,
  mac: string,
  name: string,
  note?: string,
): Promise<UnifiUser> {
  const res = await unifiFetch<{ data: UnifiUser[] }>(conn, "/rest/user", {
    method: "POST",
    body: JSON.stringify(note ? { mac, name, note } : { mac, name }),
  });
  return res.data[0];
}

export async function updateUserAlias(
  conn: GatewayConn,
  userId: string,
  name: string,
  note?: string,
): Promise<void> {
  await unifiFetch(conn, `/rest/user/${userId}`, {
    method: "PUT",
    body: JSON.stringify(note !== undefined ? { name, note } : { name }),
  });
}

export async function deleteUserAlias(conn: GatewayConn, userId: string): Promise<void> {
  await unifiFetch(conn, `/rest/user/${userId}`, { method: "DELETE" });
}

export type { GatewayConn };
