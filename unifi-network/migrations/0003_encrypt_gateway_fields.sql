-- Verschlüsselt gateways.name, base_url und created_by (AES-256-GCM), die
-- bisher versehentlich im Klartext lagen — Verstoß gegen die "Encrypt
-- Everything"-Regel des Projekts (jeder Name/E-Mail/URL-Wert muss GCM-
-- verschlüsselt sein). Gefunden 2026-07-01 bei einer direkten DB-Inspektion:
-- name (Standortname), base_url (interner Hostname) und created_by
-- (E-Mail-Adresse) waren alle drei im Klartext lesbar.
--
-- SQL-Migrationen haben keinen Zugriff auf MODULAB_ENCRYPTION_KEY (nur der
-- Deno-Handler-Prozess kennt ihn) und können daher nicht selbst
-- verschlüsseln. Nutzerentscheidung: bestehende Gateways werden nicht
-- automatisch nachverschlüsselt (kein Backfill-Mechanismus) — der Nutzer legt
-- seine 3 bestehenden Gateways manuell neu an, nachdem dieses Update
-- eingespielt ist. Deshalb hier ein sauberer Cut: alte Klartextspalten
-- werden direkt entfernt, keine Übergangs-Doppelspalten.

ALTER TABLE gateways
    ADD COLUMN IF NOT EXISTS name_enc       TEXT,
    ADD COLUMN IF NOT EXISTS base_url_enc   TEXT,
    ADD COLUMN IF NOT EXISTS created_by_enc TEXT;

ALTER TABLE gateways
    DROP COLUMN IF EXISTS name,
    DROP COLUMN IF EXISTS base_url,
    DROP COLUMN IF EXISTS created_by;

-- Nach dieser Migration sind name_enc/base_url_enc/created_by_enc zunächst
-- NULL für alle bestehenden Zeilen (falls welche übrig sind) — der Nutzer
-- muss betroffene Gateways neu anlegen, da alte Klartextwerte unwiderruflich
-- entfernt wurden. NOT NULL wird bewusst nicht erzwungen, damit die Migration
-- nicht an vorhandenen Altzeilen scheitert; createGateway() im Handler
-- verlangt die Felder ohnehin als Pflichtangaben.
