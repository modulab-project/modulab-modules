-- unifi-network module initial schema
-- Schema: module_unifi_network (set by Core before running this file via SET search_path)

-- Gateways: eigene Tabelle, unabhängig vom ModuLab-Standort-Konzept.
-- Scatter-Gather läuft über alle Gateways gleichzeitig, nicht über einen
-- einzelnen ausgewählten Standort (siehe Entscheidungsvorlage Abschnitt 1.1).
CREATE TABLE IF NOT EXISTS gateways (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT        NOT NULL,                    -- Klartext, Anzeigename ("Standort Frankfurt")
    base_url              TEXT        NOT NULL,                    -- Klartext, benötigt für Private-IP-Validierung vor jedem Call
    api_key_enc           TEXT        NOT NULL,                    -- AES-256-GCM verschlüsselt (base64)
    status                TEXT        NOT NULL DEFAULT 'unknown',  -- 'online' | 'offline' | 'config_error' | 'paused' | 'unknown'
    consecutive_failures  INT         NOT NULL DEFAULT 0,          -- Circuit-Breaker-Zähler, bei Erfolg auf 0 zurückgesetzt
    last_checked_at       TIMESTAMPTZ,
    last_error            TEXT,                                    -- letzte Fehlermeldung, Klartext (keine PII)
    created_by            TEXT        NOT NULL,                    -- rein informativ, keine Zugriffsbeschränkung
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Geräte: kanonischer Alias + MAC, unabhängig vom einzelnen Gateway
-- (ein Gerät kann auf mehreren Gateways provisioniert sein → device_gateways).
CREATE TABLE IF NOT EXISTS devices (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    mac_enc           TEXT        NOT NULL,                      -- AES-256-GCM verschlüsselt (base64), sanitized Format vor Verschlüsselung
    mac_hash          TEXT        NOT NULL UNIQUE,                -- HMAC-SHA256(sanitized MAC), deterministischer Blind-Index für Joins/Lookups
    alias_enc         TEXT        NOT NULL,                      -- AES-256-GCM verschlüsselt (base64), kanonischer Name (UniFi-Feld "name")
    note_enc          TEXT        NOT NULL,                      -- AES-256-GCM verschlüsselt (base64), freier Kommentar (UniFi-Feld "note"), z.B. "iPhone Kay" — Pflichtfeld
    target_vlan_name  TEXT        NOT NULL,                      -- Klartext, VLAN-Name (nicht -ID, da ID pro Gateway variiert)
    status            TEXT        NOT NULL DEFAULT 'pending_approval', -- 'pending_approval' | 'active' | 'rejected'
    created_by        TEXT        NOT NULL,                      -- rein informativ, keine Zugriffsbeschränkung
    approved_by       TEXT,                                      -- Admin, der die Freigabe erteilt hat
    approved_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS devices_mac_hash_idx ON devices(mac_hash);
CREATE INDEX IF NOT EXISTS devices_status_idx ON devices(status);

-- Zuordnung Gerät ↔ Gateway (m:n) + gateway-spezifische UniFi-interne IDs.
CREATE TABLE IF NOT EXISTS device_gateways (
    device_id            UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    gateway_id           UUID        NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    radius_account_id    TEXT        NOT NULL,                    -- UniFi _id aus /rest/account, Klartext (technische ID, keine PII)
    user_alias_id        TEXT,                                    -- UniFi _id aus /rest/user, Klartext (kann fehlen → "Unbekannt")
    resolved_vlan_id     TEXT,                                    -- gateway-spezifische VLAN-ID, NULL falls VLAN-Matching fehlgeschlagen
    last_seen_at         TIMESTAMPTZ,                             -- aus stat/alluser, Klartext (Zeitstempel, unkritisch)
    name_discrepancy     BOOLEAN     NOT NULL DEFAULT false,      -- true, wenn Alias auf diesem Gateway vom kanonischen Namen abweicht
    provisioning_status  TEXT        NOT NULL DEFAULT 'ok',       -- 'ok' | 'vlan_not_found' | 'error'
    provisioning_error   TEXT,                                    -- Klartext-Fehlermeldung bei provisioning_status != 'ok'
    provisioned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, gateway_id)
);

CREATE INDEX IF NOT EXISTS device_gateways_gateway_id_idx ON device_gateways(gateway_id);

-- VLAN-Cache pro Gateway (für Dropdown im Onboarding-Formular).
-- Wird vom Cron-Poll-Job befüllt (upsert), zusätzlich per manuellem
-- Refresh-Button aktualisierbar.
CREATE TABLE IF NOT EXISTS vlan_cache (
    gateway_id      UUID        NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    unifi_vlan_uid  TEXT        NOT NULL,                        -- _id aus /rest/networkconf
    vlan_name       TEXT        NOT NULL,                        -- Klartext, dient dem Name-Matching über Gateways hinweg
    vlan_number     INT         NOT NULL,                        -- die eigentliche VLAN-ID (802.1Q)
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (gateway_id, unifi_vlan_uid)
);

CREATE INDEX IF NOT EXISTS vlan_cache_name_idx ON vlan_cache(vlan_name);

-- Ausstehende Löschungen: Retry-Queue für Gateways, die zum Löschzeitpunkt
-- nicht erreichbar waren. Wird vom Cron-Poll-Job bei jedem Durchlauf
-- abgearbeitet, bis Erfolg oder max_retries erreicht.
CREATE TABLE IF NOT EXISTS pending_deletions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           UUID        NOT NULL,                    -- kein FK auf devices(id), da das Gerät ggf. bereits vollständig gelöscht ist
    gateway_id          UUID        NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    radius_account_id   TEXT        NOT NULL,                    -- UniFi _id, für DELETE .../rest/account/{_id}
    user_alias_id       TEXT,                                    -- UniFi _id, für DELETE .../rest/user/{_id} (kann fehlen)
    retry_count         INT         NOT NULL DEFAULT 0,
    max_retries         INT         NOT NULL DEFAULT 20,         -- bei 60s-Poll-Intervall ≈ 20 Minuten Kulanzfenster
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pending_deletions_gateway_id_idx ON pending_deletions(gateway_id);

-- Audit-Log: alle schreibenden Aktionen (Gateway-CRUD, Device-CRUD,
-- Freigabe/Ablehnung, Namensdiskrepanz-Sync, Teil-/Komplett-Löschen).
-- Enthält keine Klartext-Secrets (API-Keys, MAC-Adressen) — nur IDs/Referenzen
-- und unverschlüsselte Namen.
CREATE TABLE IF NOT EXISTS audit_log (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    actor         TEXT        NOT NULL,                          -- userId aus ModuleAuthContext
    action        TEXT        NOT NULL,                          -- z.B. 'gateway.create', 'device.approve', 'device.delete'
    target_type   TEXT        NOT NULL,                          -- 'gateway' | 'device'
    target_id     UUID,
    detail        TEXT,                                          -- Klartext-Zusatzinfo (z.B. Gateway-Name), keine Secrets
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);
