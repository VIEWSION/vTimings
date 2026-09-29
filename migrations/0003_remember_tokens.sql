-- "Angemeldet bleiben": langlebige Anmeldung pro Browser.
--
-- Bewusst getrennt von `tokens` (API-Zugänge für native Clients): diese
-- Einträge taugen nicht als Bearer-Token, tauchen nicht in der Tokenliste
-- auf und werden beim Abmelden bzw. Passwortwechsel wieder entfernt.
-- Gespeichert wird nur der SHA-256 des Cookie-Werts.
CREATE TABLE remember_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hash         TEXT    NOT NULL,
    user_agent   TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_remember_tokens_hash ON remember_tokens(hash);
CREATE INDEX ix_remember_tokens_user ON remember_tokens(user_id);
