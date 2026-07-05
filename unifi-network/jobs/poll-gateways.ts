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
//      device_gateways.last_seen_at.
//   2. Process pending_deletions: retry failed deletes, escalate at max_retries.
//
// NAME-KONZEPT ENTFERNT (2026-07-01): das Modul nutzt ausschließlich das
// UniFi-Feld "note" als einziges Freitextfeld — "name" wird nie mehr
// gelesen oder geschrieben.
//
// NOTE-DISKREPANZ (2026-07-01, direkt danach ergänzt): note kann trotzdem
// pro Gateway auseinanderlaufen, wenn jemand direkt im UniFi-WebIF eine
// Notiz ändert statt über das Modul — der Poll-Job vergleicht daher bei
// jedem Durchlauf die tatsächlich auf dem Gateway hinterlegte note gegen
// devices.note_enc und markiert Abweichungen (device_gateways.note_discrepancy
// + gateway_note_enc, Migration 0005_note_discrepancy.sql). Gleiches Muster
// wie zuvor für name (Entscheidungsvorlage 4.4, dort entfernt).
//
// NOTE: MAC matching across RADIUS/user/client-history data happens in-memory
// per gateway (small per-gateway result sets), then persisted via mac_hash
// lookups against `devices` — see matchDeviceByMac() below. This avoids ever
// decrypting more than the current gateway's rows at once.
//
// AUTO-ADOPT (2026-07-01): RADIUS accounts that exist on the controller but
// have no matching `devices` row (created outside this module, e.g. manually
// via the UniFi UI before this module existed) are now automatically adopted
// as a new `devices` row + `device_gateways` link, status 'active' immediately
// (no approval workflow — the account already exists for real on the
// gateway, approval would be pointless). `note` is a NOT NULL column with no
// source value available for pre-existing accounts, so a fixed placeholder
// is used and surfaced in the UI so an admin can fill in a real note later.

import type { JobContext, GatewayRow, DeviceRow, ModuleNotification } from "../handlers/types.ts";
import { getEncKey, getMacHashKey, encrypt, decrypt, macHash, sanitizeMac } from "../handlers/crypto.ts";
import {
  fetchVlans,
  fetchRadiusAccounts,
  fetchUsers,
  fetchClientHistory,
  deleteRadiusAccount,
  deleteUserAlias,
  isAlreadyGoneError,
  type GatewayConn,
  type UnifiRadiusAccount,
  type UnifiUser,
} from "../handlers/unifi-client.ts";

// Placeholder for the required `note` column when adopting an account that
// was never created through this module's onboarding form (no source value
// exists). Surfaced as-is in the UI so an admin recognizes it needs editing.
const ADOPTED_NOTE_PLACEHOLDER = "(übernommen — bitte Notiz ergänzen)";

// Small, local {de, en} text builders for this job's four notification
// events. Deno job code has no i18next runtime (that's a frontend/UI-side
// concern — see the module's locales/de.json + en.json, loaded via
// GET /v1/modules/{name}/locales/{lng}), so the module renders both language
// variants itself, right here, and hands Core the already-finished text
// (ModuleNotification.message). Core never sees a type key or raw data for
// these events — see ModuleNotification's doc comment in handlers/types.ts
// for why: adding/changing a notification must never require a Core change.
const notificationText = {
  // Includes the resolved target_vlan_name (not just the MAC) since that's
  // the other piece of information an admin needs before editing the
  // placeholder note — without it they'd have to open the device just to
  // see which VLAN it landed on.
  deviceAutoAdopted: (gatewayName: string, mac: string, vlanName: string): { de: string; en: string } => ({
    de: `Neues Gerät automatisch übernommen: ${mac} auf Gateway "${gatewayName}", VLAN "${vlanName || "?"}" — bitte Notiz ergänzen`,
    en: `New device auto-adopted: ${mac} on gateway "${gatewayName}", VLAN "${vlanName || "?"}" — please add a note`,
  }),
  // failureCount included so an admin sees immediately how many consecutive
  // failures triggered the pause (matches CIRCUIT_BREAKER_THRESHOLD), not
  // just the most recent error message.
  gatewayPaused: (gatewayName: string, error: string, failureCount: number): { de: string; en: string } => ({
    de: `Gateway "${gatewayName}" pausiert nach ${failureCount} wiederholten Fehlern. Letzter Fehler: ${error}`,
    en: `Gateway "${gatewayName}" paused after ${failureCount} repeated failures. Last error: ${error}`,
  }),
  gatewayOnline: (gatewayName: string): { de: string; en: string } => ({
    de: `Gateway "${gatewayName}" ist wieder erreichbar und wurde automatisch reaktiviert`,
    en: `Gateway "${gatewayName}" is reachable again and was automatically reactivated`,
  }),
  noteDiscrepanciesFound: (gatewayName: string, count: number): { de: string; en: string } => ({
    de: `${count} abweichende Notiz(en) auf Gateway "${gatewayName}" gefunden — direkt im UniFi-WebIF geändert, weicht von ModuLab ab. Bitte prüfen und auflösen.`,
    en: `${count} note discrepancy(ies) found on gateway "${gatewayName}" — changed directly in the UniFi web UI, differs from ModuLab. Please review and resolve.`,
  }),
};

const CIRCUIT_BREAKER_THRESHOLD = 5; // consecutive failures before pausing a gateway (Entscheidungsvorlage 4.12)

// includePaused: the scheduled cron job (default, includePaused=false) must
// keep skipping paused gateways — that's the whole point of the circuit
// breaker (Entscheidungsvorlage 4.12), avoid hammering a gateway that's
// known-broken every minute forever. But a manual "refresh all" click from
// an admin (refreshAllGateways(), routed through refresh-all) is an
// explicit, deliberate retry — most commonly used exactly to recover from a
// transient outage (e.g. a Core restart resetting egress permissions, fixed
// 2026-07-03 via egress_hosts_handler) without having to open and re-save
// every paused gateway individually just to reset consecutive_failures.
// pollSingleGateway() already resets consecutive_failures to 0 on any
// successful poll, so a paused gateway that responds this time
// automatically un-pauses; one that's still actually down stays paused
// (just increments failures again, capped — see markGatewayError()).
// ModuleJobResult is what a scheduled job can return instead of void to
// additionally surface async notifications — see the Deno bootstrap script
// in Core's deno.go for how `__notifications` is pulled out of this and
// published to notify.AdminChannel(). Kept local (not in types.ts) since
// only this job currently returns anything at all.
interface ModuleJobResult {
  __notifications: ModuleNotification[];
}

export default async function pollGateways(
  ctx: JobContext,
  opts: { includePaused?: boolean } = {},
): Promise<ModuleJobResult | void> {
  const { db } = ctx;

  const gateways = await db.query<GatewayRow>(
    opts.includePaused
      ? `SELECT * FROM gateways`
      : `SELECT * FROM gateways WHERE status != 'paused'`,
  );

  // Collected across every gateway in this run and returned as one batch —
  // see runUpdateCheck/RunUpdateChecks in Core's status.go for the
  // equivalent pattern with module updates (one event per background pass,
  // not one per individual finding, to avoid a notification storm when
  // e.g. several devices get auto-adopted in the same minute).
  const notifications: ModuleNotification[] = [];

  await Promise.allSettled(gateways.map((gw) => pollSingleGateway(ctx, gw, notifications)));
  await processPendingDeletions(ctx);

  return notifications.length > 0 ? { __notifications: notifications } : undefined;
}

async function pollSingleGateway(ctx: JobContext, gw: GatewayRow, notifications: ModuleNotification[]): Promise<void> {
  const { db } = ctx;
  const encKey = await getEncKey();

  if (!encKey) {
    await markGatewayError(db, gw.id, "MODULAB_ENCRYPTION_KEY not configured on server", undefined, notifications);
    return;
  }

  let apiKey: string;
  try {
    apiKey = await decrypt(encKey, gw.api_key_enc);
  } catch {
    // Entscheidungsvorlage Abschnitt 2: a key that fails to decrypt must never
    // be sent to the UniFi API as a literal string — mark config_error and
    // skip the call entirely.
    await markGatewayError(db, gw.id, "Failed to decrypt API key (config_error)", "config_error", notifications);
    return;
  }

  let gwName: string;
  let baseUrl: string;
  try {
    gwName = await decrypt(encKey, gw.name_enc);
    baseUrl = await decrypt(encKey, gw.base_url_enc);
  } catch {
    await markGatewayError(db, gw.id, "Failed to decrypt gateway name/base_url (config_error)", "config_error", notifications);
    return;
  }

  const conn: GatewayConn = { name: gwName, baseUrl, apiKey };
  const wasOffline = gw.status === "offline" || gw.status === "paused";

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

    // Counts discrepancies found THIS run for a single bundled notification
    // at the end of this gateway's loop, rather than one per device — a
    // gateway where notes are actively edited outside ModuLab could
    // otherwise generate a notification per device per poll (every minute).
    let noteDiscrepancyCount = 0;

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
      const activeMacHashKey: CryptoKey = macHashKey;
      const hash = await macHash(activeMacHashKey, sanitized);

      let [device] = await db.query<DeviceRow>(`SELECT * FROM devices WHERE mac_hash = $1`, [hash]);

      if (!device) {
        // Auto-adopt: RADIUS account exists on the controller but this module
        // never created it (e.g. set up manually before this module existed).
        device = await adoptExistingRadiusAccount(db, encKey, activeMacHashKey, sanitized, hash, acc, user, gw.id);
        if (!device) continue; // adoption failed (e.g. encrypt error) — skip, will retry next poll
        // Reported by the user 2026-07-04: previously this happened
        // completely silently — an admin only found out by opening the
        // device list and noticing the ADOPTED_NOTE_PLACEHOLDER text. This
        // is exactly the "something changed with no admin watching" case
        // notifications exist for.
        notifications.push({
          message: notificationText.deviceAutoAdopted(gwName, sanitized, device.target_vlan_name),
          // Overview (default view, no ?view= needed) is where the adopted
          // device — and its ADOPTED_NOTE_PLACEHOLDER note — actually shows
          // up for editing.
          actionPath: "/modules/unifi-network",
        });
      }

      // Note-Diskrepanz-Check: die tatsächlich auf diesem Gateway hinterlegte
      // Notiz (user?.note) gegen den kanonischen Wert (devices.note_enc)
      // vergleichen. `undefined` bei user?.note bedeutet "auf UniFi noch nie
      // gesetzt" — wird NICHT als Abweichung gewertet (kein Vergleichswert
      // vorhanden), sondern nur als "unbekannt" gespeichert.
      const encKeyForNote = await getEncKey();
      let canonicalNote = "";
      if (encKeyForNote) {
        canonicalNote = await decrypt(encKeyForNote, device.note_enc).catch(() => "");
      }
      const gatewayNote = user?.note ?? null;
      const noteDiscrepancy = gatewayNote !== null && gatewayNote !== canonicalNote;
      const gatewayNoteEnc =
        gatewayNote !== null && encKeyForNote ? await encrypt(encKeyForNote, gatewayNote).catch(() => null) : null;

      // Only count a discrepancy toward this run's notification if it's
      // NEWLY found (wasn't already flagged before this poll) — otherwise
      // an unresolved discrepancy would notify again every single minute
      // until someone fixes it, which would train admins to ignore the
      // notification entirely.
      if (noteDiscrepancy) {
        const [existingLink] = await db.query<{ note_discrepancy: boolean }>(
          `SELECT note_discrepancy FROM device_gateways WHERE device_id = $1 AND gateway_id = $2`,
          [device.id, gw.id],
        );
        if (!existingLink?.note_discrepancy) noteDiscrepancyCount++;
      }

      // Upsert statt reinem UPDATE: ein bereits über ein anderes Gateway
      // bekanntes Gerät (device existiert) kann auf DIESEM Gateway trotzdem
      // zum ersten Mal auftauchen (z.B. zweites Gateway nachträglich
      // hinzugefügt, RADIUS-Account dort schon länger vorhanden) — dann gibt
      // es noch keine device_gateways-Zeile für diese Kombination, und ein
      // reines UPDATE träfe keine Zeile (Bug, gefunden 2026-07-01: zweites
      // Gateway zeigte das Gerät nie an, obwohl der Account dort existierte).
      await db.query(
        `INSERT INTO device_gateways
           (device_id, gateway_id, radius_account_id, user_alias_id, last_seen_at, note_discrepancy, gateway_note_enc, provisioning_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ok')
         ON CONFLICT (device_id, gateway_id)
         DO UPDATE SET
           last_seen_at = $5,
           note_discrepancy = $6,
           gateway_note_enc = $7,
           user_alias_id = COALESCE($4, device_gateways.user_alias_id),
           radius_account_id = $3`,
        [device.id, gw.id, acc._id, user?._id ?? null, lastSeen, noteDiscrepancy, gatewayNoteEnc],
      );
    }

    if (noteDiscrepancyCount > 0) {
      notifications.push({
        message: notificationText.noteDiscrepanciesFound(gwName, noteDiscrepancyCount),
        // Discrepancies show up on the device list (overview), same as
        // auto-adopted devices — resolve-note is triggered from there.
        actionPath: "/modules/unifi-network",
      });
    }

    await db.query(
      `UPDATE gateways
       SET status = 'online', consecutive_failures = 0, last_checked_at = now(), last_error = NULL
       WHERE id = $1`,
      [gw.id],
    );
    if (wasOffline) {
      // Mirror image of markGatewayError's paused/offline notification
      // below — an admin who got notified about the outage should also
      // hear when it resolves, without needing to keep checking manually.
      notifications.push({
        message: notificationText.gatewayOnline(gwName),
        actionPath: "/modules/unifi-network?view=gateways",
      });
    }
  } catch (err) {
    // Include name + baseUrl in the log line (not just the DB row, which
    // only gets errorMessage) so a failure is diagnosable straight from
    // docker logs without a DB query — see markGatewayError's own logging
    // for why this matters (2026-07-03).
    console.error(`[unifi-network] poll_gateways: "${gwName}" (${baseUrl}) threw during poll:`, err);
    await markGatewayError(ctx.db, gw.id, String(err), undefined, notifications);
  }
}

// ── Auto-adopt pre-existing RADIUS accounts (see header note above) ────────

async function adoptExistingRadiusAccount(
  db: JobContext["db"],
  encKey: CryptoKey,
  macHashKey: CryptoKey,
  sanitizedMac: string,
  macHashValue: string,
  acc: UnifiRadiusAccount,
  user: UnifiUser | undefined,
  gatewayId: string,
): Promise<DeviceRow | null> {
  try {
    // Kein alias-Fallback mehr (2026-07-01): das Modul verwaltet nur noch
    // die Notiz. Existiert auf UniFi bereits eine `note`, wird sie übernommen;
    // sonst der feste Platzhalter (s.o.), den ein Admin nachträglich ausfüllt.
    const note = user?.note ?? ADOPTED_NOTE_PLACEHOLDER;

    // Reverse-lookup: acc.vlan is a plain VLAN number, vlan_cache stores the
    // name we display/match on elsewhere (target_vlan_name references VLANs
    // by name, not number, since names are the thing kept identical across
    // gateways — see Entscheidungsvorlage 4.5/4.8).
    let targetVlanName = "";
    if (acc.vlan !== undefined) {
      const [vlan] = await db.query<{ vlan_name: string }>(
        `SELECT vlan_name FROM vlan_cache WHERE gateway_id = $1 AND vlan_number = $2 LIMIT 1`,
        [gatewayId, acc.vlan],
      );
      targetVlanName = vlan?.vlan_name ?? "";
    }

    const macEnc = await encrypt(encKey, sanitizedMac);
    const noteEnc = await encrypt(encKey, note);

    const [device] = await db.query<DeviceRow>(
      `INSERT INTO devices (mac_enc, mac_hash, note_enc, target_vlan_name, status, created_by)
       VALUES ($1, $2, $3, $4, 'active', 'system:auto-adopt')
       RETURNING *`,
      [macEnc, macHashValue, noteEnc, targetVlanName],
    );

    await db.query(
      `INSERT INTO device_gateways
         (device_id, gateway_id, radius_account_id, user_alias_id, provisioning_status, provisioned_at)
       VALUES ($1, $2, $3, $4, 'ok', now())
       ON CONFLICT (device_id, gateway_id) DO NOTHING`,
      [device.id, gatewayId, acc._id, user?._id ?? null],
    );

    return device;
  } catch (err) {
    // Logged (found 2026-07-05, same rationale as markGatewayError's own
    // console.error below): this previously swallowed the error entirely —
    // "will retry next poll" was true but gave no trace of what failed
    // (e.g. encrypt() failure) if it kept failing every single run.
    console.error(
      `[unifi-network] poll_gateways: adoptExistingRadiusAccount failed for MAC ${sanitizedMac} on gateway ${gatewayId}:`,
      err,
    );
    return null; // e.g. encrypt() failure — skip this cycle, will retry next poll
  }
}

async function markGatewayError(
  db: JobContext["db"],
  gatewayId: string,
  errorMessage: string,
  explicitStatus?: "config_error",
  notifications?: ModuleNotification[],
): Promise<void> {
  const [gw] = await db.query<GatewayRow>(`SELECT consecutive_failures, status FROM gateways WHERE id = $1`, [gatewayId]);
  const failures = (gw?.consecutive_failures ?? 0) + 1;
  const status = explicitStatus ?? (failures >= CIRCUIT_BREAKER_THRESHOLD ? "paused" : "offline");

  // Added 2026-07-03: this was the only place a poll failure got recorded,
  // and it only ever went into gateways.last_error (DB) -- never the
  // container log. That made every "Pausiert nach wiederholten Fehlern" in
  // the UI a dead end for diagnosis: the actual cause (network error, HTTP
  // status, decrypt failure, etc.) was sitting in a DB column nobody was
  // looking at, and docker logs showed nothing at all for the entire
  // failure window. Logging it here surfaces the real error on every single
  // failed attempt, not just once it's already paused.
  console.error(
    `[unifi-network] poll_gateways: gateway ${gatewayId} failed (attempt ${failures}/${CIRCUIT_BREAKER_THRESHOLD}, new status=${status}): ${errorMessage}`,
  );

  await db.query(
    `UPDATE gateways
     SET status = $1, consecutive_failures = $2, last_checked_at = now(), last_error = $3
     WHERE id = $4`,
    [status, failures, errorMessage, gatewayId],
  );

  // Only notify on the actual transition INTO paused (2026-07-04, reported
  // by the user after living through exactly this with three gateways at
  // once) — not on every "offline" attempt leading up to it, which would
  // otherwise fire up to CIRCUIT_BREAKER_THRESHOLD times per gateway before
  // the real, actionable moment (an admin needs to check configuration).
  if (status === "paused" && gw?.status !== "paused" && notifications) {
    const encKey = await getEncKey();
    const [row] = await db.query<GatewayRow>(`SELECT name_enc FROM gateways WHERE id = $1`, [gatewayId]);
    const gwName = row && encKey ? await decrypt(encKey, row.name_enc).catch(() => "?") : "?";
    notifications.push({
      message: notificationText.gatewayPaused(gwName, errorMessage, failures),
      actionPath: "/modules/unifi-network?view=gateways",
    });
  }
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
      const gwName = await decrypt(encKey, gw.name_enc).catch(() => "???");
      const baseUrl = await decrypt(encKey, gw.base_url_enc);
      const conn: GatewayConn = { name: gwName, baseUrl, apiKey };

      // Bugfix (2026-07-01, siehe Entscheidungsvorlage 4.25): "schon nicht
      // mehr vorhanden" (api.err.IdInvalid) wird als Erfolg gewertet, damit
      // ein bereits verschwundener User-Alias nicht den ganzen Retry blockiert
      // und die pending_deletions-Zeile ewig mit IdInvalid hängen bleibt.
      await deleteRadiusAccount(conn, p.radius_account_id).catch((err) => {
        if (!isAlreadyGoneError(err)) throw err;
      });
      if (p.user_alias_id) {
        await deleteUserAlias(conn, p.user_alias_id).catch((err) => {
          if (!isAlreadyGoneError(err)) throw err;
        });
      }

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
