// ── Cron poll job ─────────────────────────────────────────────────────────────
//
// Scheduled via manifest.yaml (`jobs: poll_gateways`, every minute). Scatter-
// gathers over all non-`paused` gateways in parallel, using Promise.allSettled
// so a single hanging/unreachable gateway cannot block the others
// (Entscheidungsvorlage Abschnitt 1.3 / 4.12).
//
// Responsibilities per run:
//   1. For each gateway: fetch VLANs, RADIUS accounts, users, client history;
//      update gateways.status/consecutive_failures/last_error, vlan_cache,
//      device_gateways.last_seen_at + name_discrepancy.
//   2. Process pending_deletions: retry failed deletes, escalate at max_retries.
//
// NOTE: MAC matching across RADIUS/user/client-history data happens in-memory
// per gateway (small per-gateway result sets), then persisted via mac_hash
// lookups against `devices` — see matchDeviceByMac() below. This avoids ever
// decrypting more than the current gateway's rows at once.

import type { JobContext, GatewayRow, DeviceRow } from "../handlers/types.ts";
import { getEncKey, getMacHashKey, decrypt, macHash, sanitizeMac } from "../handlers/crypto.ts";
import {
  fetchVlans,
  fetchRadiusAccounts,
  fetchUsers,
  fetchClientHistory,
  deleteRadiusAccount,
  deleteUserAlias,
  type GatewayConn,
} from "../handlers/unifi-client.ts";

const CIRCUIT_BREAKER_THRESHOLD = 5; // consecutive failures before pausing a gateway (Entscheidungsvorlage 4.12)

export default async function pollGateways(ctx: JobContext): Promise<void> {
  const { db } = ctx;

  const gateways = await db.query<GatewayRow>(
    `SELECT * FROM gateways WHERE status != 'paused'`,
  );

  await Promise.allSettled(gateways.map((gw) => pollSingleGateway(ctx, gw)));
  await processPendingDeletions(ctx);
}

async function pollSingleGateway(ctx: JobContext, gw: GatewayRow): Promise<void> {
  const { db } = ctx;
  const encKey = await getEncKey();

  if (!encKey) {
    await markGatewayError(db, gw.id, "MODULAB_ENCRYPTION_KEY not configured on server");
    return;
  }

  let apiKey: string;
  try {
    apiKey = await decrypt(encKey, gw.api_key_enc);
  } catch {
    // Entscheidungsvorlage Abschnitt 2: a key that fails to decrypt must never
    // be sent to the UniFi API as a literal string — mark config_error and
    // skip the call entirely.
    await markGatewayError(db, gw.id, "Failed to decrypt API key (config_error)", "config_error");
    return;
  }

  const conn: GatewayConn = { name: gw.name, baseUrl: gw.base_url, apiKey };

  try {
    const [vlans, radiusAccounts, users, history] = await Promise.all([
      fetchVlans(conn),
      fetchRadiusAccounts(conn),
      fetchUsers(conn),
      fetchClientHistory(conn),
    ]);

    // Upsert vlan_cache
    for (const v of vlans) {
      if (v.vlan === undefined) continue;
      await db.query(
        `INSERT INTO vlan_cache (gateway_id, unifi_vlan_uid, vlan_name, vlan_number, fetched_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (gateway_id, unifi_vlan_uid)
         DO UPDATE SET vlan_name = EXCLUDED.vlan_name, vlan_number = EXCLUDED.vlan_number, fetched_at = now()`,
        [gw.id, v._id, v.name, v.vlan],
      );
    }

    // Build in-memory lookup: MAC -> { radiusAccountId, userAlias, lastSeen }
    const userByMac = new Map(users.map((u) => [u.mac.toLowerCase(), u]));
    const historyByMac = new Map(history.map((h) => [h.mac.toLowerCase(), h]));

    const macHashKey = await getMacHashKey();

    for (const acc of radiusAccounts) {
      let sanitized: string;
      try {
        sanitized = sanitizeMac(acc.name);
      } catch {
        continue; // RADIUS entry whose `name` isn't a MAC — not something this module created, skip
      }

      const user = userByMac.get(sanitized);
      const hist = historyByMac.get(sanitized);
      const lastSeen = hist?.last_seen ? new Date(hist.last_seen * 1000).toISOString() : null;

      if (!macHashKey) continue;
      const hash = await macHash(macHashKey, sanitized);

      const [device] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE mac_hash = $1`, [hash]);
      if (!device) continue; // device not managed by this module (no matching devices row)

      const encKeyForAlias = await getEncKey();
      let canonicalAlias = "";
      if (encKeyForAlias) {
        canonicalAlias = await decrypt(encKeyForAlias, device.alias_enc).catch(() => "");
      }
      const gatewayAlias = user?.name ?? null;
      const discrepancy = gatewayAlias !== null && gatewayAlias !== canonicalAlias;

      await db.query(
        `UPDATE device_gateways
         SET last_seen_at = $1, name_discrepancy = $2, user_alias_id = COALESCE($3, user_alias_id)
         WHERE device_id = $4 AND gateway_id = $5`,
        [lastSeen, discrepancy, user?._id ?? null, device.id, gw.id],
      );
    }

    await db.query(
      `UPDATE gateways
       SET status = 'online', consecutive_failures = 0, last_checked_at = now(), last_error = NULL
       WHERE id = $1`,
      [gw.id],
    );
  } catch (err) {
    await markGatewayError(ctx.db, gw.id, String(err));
  }
}

async function markGatewayError(
  db: JobContext["db"],
  gatewayId: string,
  errorMessage: string,
  explicitStatus?: "config_error",
): Promise<void> {
  const [gw] = await db.query<GatewayRow>(`SELECT consecutive_failures FROM gateways WHERE id = $1`, [gatewayId]);
  const failures = (gw?.consecutive_failures ?? 0) + 1;
  const status = explicitStatus ?? (failures >= CIRCUIT_BREAKER_THRESHOLD ? "paused" : "offline");

  await db.query(
    `UPDATE gateways
     SET status = $1, consecutive_failures = $2, last_checked_at = now(), last_error = $3
     WHERE id = $4`,
    [status, failures, errorMessage, gatewayId],
  );
}

// ── Pending deletions retry (Entscheidungsvorlage Abschnitt 4.3) ────────────

async function processPendingDeletions(ctx: JobContext): Promise<void> {
  const { db } = ctx;
  const encKey = await getEncKey();
  if (!encKey) return;

  const pending = await db.query<{
    id: string;
    device_id: string;
    gateway_id: string;
    radius_account_id: string;
    user_alias_id: string | null;
    retry_count: number;
    max_retries: number;
  }>(`SELECT * FROM pending_deletions WHERE retry_count < max_retries`);

  for (const p of pending) {
    const [gw] = await db.query<GatewayRow>(`SELECT * FROM gateways WHERE id = $1`, [p.gateway_id]);
    if (!gw) {
      await db.query(`DELETE FROM pending_deletions WHERE id = $1`, [p.id]);
      continue;
    }

    try {
      const apiKey = await decrypt(encKey, gw.api_key_enc);
      const conn: GatewayConn = { name: gw.name, baseUrl: gw.base_url, apiKey };

      await deleteRadiusAccount(conn, p.radius_account_id);
      if (p.user_alias_id) await deleteUserAlias(conn, p.user_alias_id);

      await db.query(`DELETE FROM pending_deletions WHERE id = $1`, [p.id]);
      await db.query(
        `DELETE FROM device_gateways WHERE device_id = $1 AND gateway_id = $2`,
        [p.device_id, p.gateway_id],
      );
    } catch (err) {
      await db.query(
        `UPDATE pending_deletions
         SET retry_count = retry_count + 1, last_error = $1, last_attempted_at = now()
         WHERE id = $2`,
        [String(err), p.id],
      );
      // At max_retries the row is left in place (not deleted) — the UI surfaces
      // it as "manuelles Eingreifen nötig" (Entscheidungsvorlage 4.3).
    }
  }
}
