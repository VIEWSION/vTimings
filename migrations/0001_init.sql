-- vTimings Grundschema
--
-- Konventionen:
--   * Alle Zeitstempel sind UTC-Unixtimestamps (INTEGER, Sekunden).
--   * deleted_at IS NULL  =>  Datensatz aktiv (Soft-Delete / Papierkorb).
--   * Geldbeträge als REAL; bei Stundensätzen und Tagesbeträgen unkritisch.

-- ---------------------------------------------------------------------------
-- Einstellungen
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Stammdaten: Kunde -> Projekt -> Teilprojekt
-- ---------------------------------------------------------------------------
CREATE TABLE clients (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    color           TEXT,                                 -- #rrggbb
    rate            REAL,                                 -- Vorgabe-Stundensatz
    currency        TEXT    NOT NULL DEFAULT 'EUR',
    lang            TEXT    NOT NULL DEFAULT 'de',        -- Sprache für Ausdrucke
    note            TEXT    NOT NULL DEFAULT '',
    contact_name    TEXT    NOT NULL DEFAULT '',
    contact_email   TEXT    NOT NULL DEFAULT '',
    contact_address TEXT    NOT NULL DEFAULT '',
    archived        INTEGER NOT NULL DEFAULT 0,
    sort            INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    deleted_at      INTEGER
);
CREATE UNIQUE INDEX ux_clients_name ON clients(name) WHERE deleted_at IS NULL;
CREATE INDEX ix_clients_archived ON clients(archived, name);

CREATE TABLE projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    name         TEXT    NOT NULL,
    color        TEXT,
    rate         REAL,                                    -- NULL = vom Kunden erben
    budget_hours REAL,                                    -- Kontingent für den Fortschrittsbalken
    note         TEXT    NOT NULL DEFAULT '',
    archived     INTEGER NOT NULL DEFAULT 0,
    sort         INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);
CREATE UNIQUE INDEX ux_projects_name ON projects(client_id, name) WHERE deleted_at IS NULL;
CREATE INDEX ix_projects_client ON projects(client_id, archived, sort, name);

CREATE TABLE subprojects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    name       TEXT    NOT NULL,
    rate       REAL,                                      -- NULL = vom Projekt erben
    note       TEXT    NOT NULL DEFAULT '',
    archived   INTEGER NOT NULL DEFAULT 0,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE UNIQUE INDEX ux_subprojects_name ON subprojects(project_id, name) WHERE deleted_at IS NULL;
CREATE INDEX ix_subprojects_project ON subprojects(project_id, archived, sort, name);

-- ---------------------------------------------------------------------------
-- Benutzer und Zugänge
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    email          TEXT    NOT NULL,
    pass_hash      TEXT    NOT NULL,
    role           TEXT    NOT NULL DEFAULT 'client',     -- admin | client
    client_id      INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    project_filter TEXT,                                  -- JSON-Array von Projekt-IDs, NULL = alle des Kunden
    show_costs     INTEGER NOT NULL DEFAULT 1,
    active         INTEGER NOT NULL DEFAULT 1,
    last_login_at  INTEGER,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_users_email ON users(email);

CREATE TABLE tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hash         TEXT    NOT NULL,                        -- SHA-256 des Klartext-Tokens
    label        TEXT    NOT NULL DEFAULT '',
    last_used_at INTEGER,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_tokens_hash ON tokens(hash);
CREATE INDEX ix_tokens_user ON tokens(user_id);

CREATE TABLE login_attempts (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ip    TEXT    NOT NULL,
    email TEXT    NOT NULL DEFAULT '',
    at    INTEGER NOT NULL,
    ok    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_login_attempts_ip ON login_attempts(ip, at);
CREATE INDEX ix_login_attempts_email ON login_attempts(email, at);

-- ---------------------------------------------------------------------------
-- Rechnungen (Klammer um abgerechnete Einträge)
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    number        TEXT    NOT NULL,
    date          INTEGER NOT NULL,
    period_from   INTEGER,
    period_to     INTEGER,
    template      TEXT    NOT NULL DEFAULT 'leistungsnachweis',
    options       TEXT    NOT NULL DEFAULT '{}',          -- JSON: Anzeigeoptionen des Ausdrucks
    total_minutes INTEGER NOT NULL DEFAULT 0,
    total_amount  REAL    NOT NULL DEFAULT 0,
    note          TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_invoices_number ON invoices(number);
CREATE INDEX ix_invoices_client ON invoices(client_id, date);

-- ---------------------------------------------------------------------------
-- Zeiteinträge
-- ---------------------------------------------------------------------------
CREATE TABLE entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subproject_id INTEGER NOT NULL REFERENCES subprojects(id) ON DELETE RESTRICT,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER NOT NULL,
    duration_min  INTEGER NOT NULL,
    note          TEXT    NOT NULL DEFAULT '',
    rate          REAL    NOT NULL DEFAULT 0,             -- beim Anlegen eingefroren
    amount        REAL    NOT NULL DEFAULT 0,
    type          TEXT    NOT NULL DEFAULT 'time',        -- time | expense
    billable      INTEGER NOT NULL DEFAULT 1,
    invoice_id    INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    billed_at     INTEGER,
    source        TEXT    NOT NULL DEFAULT 'manual',      -- timer | manual | import
    import_hash   TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER
);
CREATE INDEX ix_entries_started ON entries(started_at);
CREATE INDEX ix_entries_sub ON entries(subproject_id, started_at);
CREATE INDEX ix_entries_invoice ON entries(invoice_id);
CREATE INDEX ix_entries_open ON entries(billed_at, started_at) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_entries_import ON entries(import_hash) WHERE import_hash IS NOT NULL;

-- Volltextsuche über die Notizen
CREATE VIRTUAL TABLE entries_fts USING fts5(
    note,
    content='entries',
    content_rowid='id',
    tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER trg_entries_fts_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, note) VALUES (new.id, new.note);
END;
CREATE TRIGGER trg_entries_fts_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, note) VALUES ('delete', old.id, old.note);
END;
CREATE TRIGGER trg_entries_fts_au AFTER UPDATE OF note ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, note) VALUES ('delete', old.id, old.note);
    INSERT INTO entries_fts(rowid, note) VALUES (new.id, new.note);
END;

-- ---------------------------------------------------------------------------
-- Laufende Timer
-- ---------------------------------------------------------------------------
CREATE TABLE timers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subproject_id INTEGER NOT NULL REFERENCES subprojects(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at    INTEGER NOT NULL,
    note          TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);
CREATE INDEX ix_timers_user ON timers(user_id, started_at);

-- ---------------------------------------------------------------------------
-- Vorgaben
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value, updated_at) VALUES
    ('rounding_enabled',  '1',      0),
    ('rounding_minutes',  '15',     0),
    ('rounding_mode',     'nearest',0),
    ('default_rate',      '95',     0),
    ('currency',          'EUR',    0),
    ('week_start',        '1',      0),
    ('recent_limit',      '10',     0);
