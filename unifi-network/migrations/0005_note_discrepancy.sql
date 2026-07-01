-- Führt das Diskrepanz-Konzept wieder ein — diesmal für "note" statt "name"
-- (Nutzerentscheidung 2026-07-01, direkt im Anschluss an Migration
-- 0004_remove_name_use_note_only.sql): note ist jetzt das einzige
-- Freitextfeld, kann sich aber weiterhin pro Gateway unabhängig
-- auseinanderentwickeln, wenn jemand direkt im UniFi-WebIF eine Notiz
-- ändert, statt über das Modul. Der Poll-Job erkennt das jetzt (vorher
-- wurde note nie mit dem UniFi-Ist-Zustand abgeglichen, nur beim
-- Auto-Adopt einmalig gelesen) und markiert die Abweichung; das Frontend
-- zeigt sie an und bietet denselben "auf einen Wert synchronisieren"-Dialog
-- wie zuvor für name (Entscheidungsvorlage 4.4, mittlerweile entfernt).

ALTER TABLE device_gateways
    ADD COLUMN IF NOT EXISTS note_discrepancy BOOLEAN NOT NULL DEFAULT false, -- true, wenn die auf diesem Gateway hinterlegte Notiz vom kanonischen devices.note_enc abweicht
    ADD COLUMN IF NOT EXISTS gateway_note_enc TEXT; -- AES-256-GCM verschlüsselt (base64) — die tatsächlich auf diesem Gateway gesetzte Notiz, NULL falls noch nie gepollt
