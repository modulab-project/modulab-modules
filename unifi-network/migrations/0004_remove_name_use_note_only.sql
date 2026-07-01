-- Entfernt das Name/Alias-Konzept vollständig — ab jetzt wird ausschließlich
-- die freie Notiz (note_enc) als einziges Freitextfeld genutzt, sowohl
-- kanonisch in `devices` als auch beim Zurückschreiben auf UniFi. Das
-- UniFi-Feld "name" wird ab sofort nie mehr gelesen oder geschrieben —
-- nur noch das UniFi-Feld "note" (Nutzerentscheidung 2026-07-01).
--
-- Als direkte Folge entfällt der komplette Namensdiskrepanz-Mechanismus
-- (Entscheidungsvorlage 4.4): der verglich ausschließlich das UniFi-name-Feld
-- zwischen Gateways. Mit nur noch einem vom Modul selbst verwalteten Feld
-- (note) gibt es nichts mehr, was zwischen Gateways auseinanderlaufen könnte
-- — das Modul schreibt denselben note-Wert konsistent auf alle Gateways.

ALTER TABLE devices
    DROP COLUMN IF EXISTS alias_enc;

ALTER TABLE device_gateways
    DROP COLUMN IF EXISTS name_discrepancy,
    DROP COLUMN IF EXISTS gateway_alias_enc;

-- note_enc bleibt wie zuvor NOT NULL (Pflichtfeld, Entscheidungsvorlage 4.13) —
-- keine Änderung an dieser Spalte selbst nötig, sie war schon vorhanden.
