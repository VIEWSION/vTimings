-- Stundenkontingente: vorab gekaufte Stundenpakete je Projekt oder für den
-- ganzen Kunden (project_id NULL). Der Verbrauch wird nicht gespeichert,
-- sondern beim Abruf der Reihe nach verrechnet (BudgetRepo) – ältestes
-- Paket zuerst, Überziehung zählt auf das nächste Paket.
CREATE TABLE budgets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    project_id  INTEGER REFERENCES projects(id) ON DELETE RESTRICT,  -- NULL = alle Projekte des Kunden
    hours       REAL    NOT NULL,
    price       REAL,                                  -- nur zur Information
    starts_at   INTEGER NOT NULL,                      -- Beginn des lokalen Tages
    expires_at  INTEGER,                               -- Ende des lokalen Tages (exklusiv), NULL = verfällt nie
    note        TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER
);
CREATE INDEX ix_budgets_client ON budgets(client_id, project_id, starts_at);

-- Bisheriges Projektbudget als erstes Paket übernehmen. Beginn ist die
-- erste Buchung auf dem Projekt, damit der Stand derselbe bleibt.
INSERT INTO budgets (client_id, project_id, hours, starts_at, note, created_at, updated_at)
SELECT p.client_id,
       p.id,
       p.budget_hours,
       COALESCE((SELECT MIN(e.started_at)
                   FROM entries e
                   JOIN subprojects s ON s.id = e.subproject_id
                  WHERE s.project_id = p.id AND e.deleted_at IS NULL), p.created_at),
       'Übernommen aus dem bisherigen Projektbudget',
       CAST(strftime('%s', 'now') AS INTEGER),
       CAST(strftime('%s', 'now') AS INTEGER)
  FROM projects p
 WHERE p.budget_hours > 0 AND p.deleted_at IS NULL;

-- Die Spalte bleibt stehen (DROP COLUMN erst ab SQLite 3.35), wird aber
-- nicht mehr verwendet.
UPDATE projects SET budget_hours = NULL;
