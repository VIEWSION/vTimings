-- Kundenportal: Sichtbarkeit nach Kalendertag statt ungefiltert bis zur
-- Sekunde. 1 = heutiger Tag noch nicht sichtbar (frische/unfertige
-- Einträge), 0 = keine Einschränkung.
ALTER TABLE clients ADD COLUMN visibility_offset_days INTEGER NOT NULL DEFAULT 1;
