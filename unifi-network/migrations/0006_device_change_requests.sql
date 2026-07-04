-- Adds a change-request mechanism for already-active devices (Nutzerentscheidung
-- 2026-07-05): previously, editing/deleting/re-provisioning an active device
-- was Admin-only, full stop — a regular user hit a 403 with no path forward.
-- Now a non-Admin's request against an active device is stored as a pending
-- change on the device row itself (rather than applied immediately); an
-- Admin then approves it (the change is applied exactly as if an Admin had
-- made it directly) or rejects it (the pending_* columns are cleared, the
-- device is left exactly as it was before the request — never partially
-- applied). Only one pending change per device at a time; a second request
-- while one is already outstanding is rejected with a clear error rather than
-- silently overwriting the first.
--
-- pending_action distinguishes the three request kinds a device can have:
--   'edit'           -> pending_note_enc and/or pending_target_vlan_name set
--   'delete'         -> no other pending_* column needed
--   'gateway_change' -> pending_target_gateway_ids set (the full proposed new
--                       set of gateway ids the device should be provisioned
--                       on afterward — a single "remove from this one
--                       gateway" request is expressed the same way, as the
--                       device's current set minus that one id, so approval
--                       only ever needs one code path).
--
-- This does not touch pending_approval (brand-new device submissions) or
-- pending_deletions (the existing per-gateway RADIUS/UniFi retry queue,
-- unrelated table) - those flows are unchanged.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS pending_action TEXT
        CHECK (pending_action IS NULL OR pending_action IN ('edit', 'delete', 'gateway_change')),
    ADD COLUMN IF NOT EXISTS pending_note_enc TEXT, -- AES-256-GCM verschlüsselt (base64); nur bei pending_action = 'edit'
    ADD COLUMN IF NOT EXISTS pending_target_vlan_name TEXT, -- nur bei pending_action = 'edit'
    ADD COLUMN IF NOT EXISTS pending_target_gateway_ids JSONB, -- nur bei pending_action = 'gateway_change'; JSON-Array von gateway_id
    ADD COLUMN IF NOT EXISTS pending_requested_by TEXT, -- E-Mail des anfragenden Users (Klartext, wie devices.created_by)
    ADD COLUMN IF NOT EXISTS pending_requested_at TIMESTAMPTZ;
