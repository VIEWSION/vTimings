-- Stundenpakete abrechnen: Einträge, die über ein Paket bezahlt sind, sind
-- "abgerechnet" (billed_at) und tragen das Paket in budget_id – so wie
-- invoice_id die Rechnung. Das Paket selbst merkt sich, wann es abgerechnet
-- wurde; ab dann zählt es fest mit genau diesen Einträgen.
ALTER TABLE entries ADD COLUMN budget_id INTEGER REFERENCES budgets(id) ON DELETE SET NULL;
CREATE INDEX ix_entries_budget ON entries(budget_id) WHERE budget_id IS NOT NULL;

ALTER TABLE budgets ADD COLUMN billed_at INTEGER;
