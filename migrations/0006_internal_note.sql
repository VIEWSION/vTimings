-- Interne Notiz am Eintrag: nur für Administratoren sichtbar, taucht weder im
-- Kundenportal noch in Leistungsnachweisen oder Exporten auf. Bewusst eine
-- Spalte statt eigener Tabelle – dieselbe Notiz an vielen Einträgen
-- (Sammelbearbeiten) ist gewollt und die wiederholte Zeile kein Problem.
ALTER TABLE entries ADD COLUMN internal_note TEXT NOT NULL DEFAULT '';
