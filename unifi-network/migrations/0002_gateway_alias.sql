-- Speichert den auf einem einzelnen Gateway tatsächlich gesetzten Namen/Alias
-- (UniFi-Feld "name"), verschlüsselt. Bisher wurde nur das Boolean
-- name_discrepancy persistiert, nicht der abweichende Wert selbst — der
-- Namensdiskrepanz-Dialog konnte also nur "es gibt eine Abweichung" anzeigen,
-- nicht WOVON die Abweichung besteht. Ergänzt 2026-07-01, damit der Dialog
-- die tatsächlichen Namen pro Gateway nebeneinander anzeigen kann.

ALTER TABLE device_gateways
    ADD COLUMN IF NOT EXISTS gateway_alias_enc TEXT; -- AES-256-GCM verschlüsselt (base64), NULL falls auf diesem Gateway nie ein Alias gesetzt wurde
