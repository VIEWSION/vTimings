<?php
declare(strict_types=1);

namespace VT\Repo;

use VT\Db\Database;
use VT\Domain\Rates;
use VT\Http\HttpException;
use VT\Settings;
use VT\Support\Clock;

final class EntryRepo
{
    private const SELECT = 'e.*,
        s.name AS subproject_name, s.project_id AS project_id,
        p.name AS project_name, p.color AS project_color, p.client_id AS client_id,
        c.name AS client_name, c.color AS client_color, c.currency AS currency,
        p.archived AS project_archived, c.archived AS client_archived,
        i.number AS invoice_number,
        bu.note AS budget_note, bu.starts_at AS budget_starts_at';

    private const JOIN = 'FROM entries e
        JOIN subprojects s ON s.id = e.subproject_id
        JOIN projects    p ON p.id = s.project_id
        JOIN clients     c ON c.id = p.client_id
        LEFT JOIN invoices i ON i.id = e.invoice_id
        LEFT JOIN budgets bu ON bu.id = e.budget_id';

    /**
     * @param array{
     *   from?:string|null, to?:string|null,
     *   client_id?:int|list<int>|null, project_id?:int|list<int>|null, subproject_id?:int|null,
     *   archived?:bool|null, q?:string, billed?:bool|null, type?:string|null, billable?:bool|null,
     *   ids?:list<int>, trashed?:bool, limit?:int, offset?:int, order?:string
     * } $opts
     * @return array{entries:list<array<string,mixed>>, total:int, totals:array<string,mixed>}
     */
    public static function list(array $opts = []): array
    {
        [$where, $params] = self::buildWhere($opts);
        $sql = implode(' AND ', $where);

        $limit = max(1, min(1000, (int) ($opts['limit'] ?? 200)));
        $offset = max(0, (int) ($opts['offset'] ?? 0));
        $order = ($opts['order'] ?? 'desc') === 'asc' ? 'ASC' : 'DESC';

        $rows = Database::all(
            'SELECT ' . self::SELECT . ' ' . self::JOIN .
            " WHERE $sql ORDER BY e.started_at $order, e.id $order LIMIT $limit OFFSET $offset",
            $params
        );

        $summary = Database::one(
            'SELECT COUNT(*) AS n, COALESCE(SUM(e.duration_min), 0) AS m, COALESCE(SUM(e.amount), 0) AS a ' .
            self::JOIN . " WHERE $sql",
            $params
        ) ?? ['n' => 0, 'm' => 0, 'a' => 0];

        $minutes = (int) $summary['m'];
        $totals = [
            'minutes' => $minutes,
            'hhmm'    => Clock::hhmm($minutes),
            'decimal' => Clock::decimal($minutes),
            'entries' => (int) $summary['n'],
        ];
        if (Scope::current()->showCosts) {
            $totals['amount'] = round((float) $summary['a'], 2);
        }

        return [
            'entries' => array_map([self::class, 'hydrate'], $rows),
            'total'   => (int) $summary['n'],
            'totals'  => $totals,
        ];
    }

    /**
     * Tagesweise gruppiert – so wie die Liste in der Oberfläche aussieht.
     *
     * @return list<array{date:string, minutes:int, hhmm:string, amount:float, entries:list<array<string,mixed>>}>
     */
    public static function listByDay(array $opts = []): array
    {
        $result = self::list($opts);
        $showCosts = Scope::current()->showCosts;

        $days = [];
        foreach ($result['entries'] as $entry) {
            $day = $entry['date'];
            $days[$day] ??= ['date' => $day, 'minutes' => 0, 'amount' => 0.0, 'entries' => []];
            $days[$day]['minutes'] += $entry['duration_min'];
            $days[$day]['amount']  += $entry['amount'] ?? 0.0;
            $days[$day]['entries'][] = $entry;
        }
        foreach ($days as &$day) {
            $day['hhmm'] = Clock::hhmm($day['minutes']);
            $day['decimal'] = Clock::decimal($day['minutes']);
            if ($showCosts) {
                $day['amount'] = round($day['amount'], 2);
            } else {
                unset($day['amount']);
            }
        }
        unset($day);

        return ['days' => array_values($days), 'total' => $result['total'], 'totals' => $result['totals']];
    }

    /**
     * Alle passenden Einträge ohne Seitenbegrenzung – für Exporte und
     * Leistungsnachweise, die vollständig sein müssen.
     *
     * @return list<array<string,mixed>>
     */
    public static function allMatching(array $opts = []): array
    {
        [$where, $params] = self::buildWhere($opts);
        $order = ($opts['order'] ?? 'asc') === 'desc' ? 'DESC' : 'ASC';

        $rows = Database::all(
            'SELECT ' . self::SELECT . ' ' . self::JOIN .
            ' WHERE ' . implode(' AND ', $where) . " ORDER BY e.started_at $order, e.id $order",
            $params
        );

        return array_map([self::class, 'hydrate'], $rows);
    }

    /**
     * Summen, gruppiert nach einer Dimension.
     *
     * @param string $by client|project|subproject|day|week|month|year
     * @return list<array<string,mixed>>
     */
    public static function grouped(array $opts, string $by): array
    {
        if (in_array($by, ['client', 'project', 'subproject'], true)) {
            return self::groupedByEntity($opts, $by);
        }
        if (in_array($by, ['day', 'week', 'month', 'year'], true)) {
            return self::groupedByPeriod($opts, $by);
        }
        throw HttpException::badRequest('Unbekannte Gruppierung: ' . $by);
    }

    /** Gruppierung über die Stammdaten – das kann SQLite selbst. */
    private static function groupedByEntity(array $opts, string $by): array
    {
        [$where, $params] = self::buildWhere($opts);

        [$key, $label, $color] = match ($by) {
            'client'     => ['c.id', 'c.name', 'c.color'],
            'project'    => ['p.id', "c.name || ' | ' || p.name", 'COALESCE(p.color, c.color)'],
            default      => ['s.id', "c.name || ' | ' || p.name || ' | ' || s.name", 'COALESCE(p.color, c.color)'],
        };

        $rows = Database::all(
            "SELECT $key AS group_key, $label AS group_label, $color AS color,
                    COUNT(*) AS entries,
                    COALESCE(SUM(e.duration_min), 0) AS minutes,
                    COALESCE(SUM(e.amount), 0) AS amount,
                    MIN(e.started_at) AS first_at,
                    MAX(e.started_at) AS last_at
               FROM entries e
               JOIN subprojects s ON s.id = e.subproject_id
               JOIN projects    p ON p.id = s.project_id
               JOIN clients     c ON c.id = p.client_id
               LEFT JOIN invoices i ON i.id = e.invoice_id
              WHERE " . implode(' AND ', $where) . '
              GROUP BY group_key
              ORDER BY minutes DESC',
            $params
        );

        return array_map(static fn(array $row) => self::groupRow(
            (string) $row['group_key'],
            (string) $row['group_label'],
            $row['color'],
            (int) $row['entries'],
            (int) $row['minutes'],
            (float) $row['amount'],
            (int) $row['first_at'],
            (int) $row['last_at'],
        ), $rows);
    }

    /**
     * Gruppierung über Zeiträume.
     *
     * Bewusst in PHP: die Kalendergrenzen hängen an der lokalen Zeitzone,
     * und SQLite kennt keine Zeitzonendatenbank. Mit einem festen Offset
     * würden Einträge rund um die Sommerzeit-Umstellung im falschen Topf
     * landen. Bei diesen Datenmengen ist der Unterschied nicht messbar.
     */
    private static function groupedByPeriod(array $opts, string $by): array
    {
        [$where, $params] = self::buildWhere($opts);

        $rows = Database::all(
            'SELECT e.started_at, e.duration_min, e.amount
               FROM entries e
               JOIN subprojects s ON s.id = e.subproject_id
               JOIN projects    p ON p.id = s.project_id
               JOIN clients     c ON c.id = p.client_id
               LEFT JOIN invoices i ON i.id = e.invoice_id
              WHERE ' . implode(' AND ', $where),
            $params
        );

        $format = match ($by) {
            'day'   => 'Y-m-d',
            'week'  => 'o-\WW',
            'month' => 'Y-m',
            default => 'Y',
        };

        $groups = [];
        foreach ($rows as $row) {
            $start = (int) $row['started_at'];
            $key = Clock::format($start, $format);

            $group = $groups[$key] ?? [
                'entries' => 0, 'minutes' => 0, 'amount' => 0.0,
                'first' => $start, 'last' => $start,
            ];
            $group['entries']++;
            $group['minutes'] += (int) $row['duration_min'];
            $group['amount']  += (float) $row['amount'];
            $group['first'] = min($group['first'], $start);
            $group['last']  = max($group['last'], $start);
            $groups[$key] = $group;
        }

        krsort($groups);

        $out = [];
        foreach ($groups as $key => $group) {
            $out[] = self::groupRow(
                (string) $key,
                self::periodLabel((string) $key, $by),
                null,
                $group['entries'],
                $group['minutes'],
                $group['amount'],
                $group['first'],
                $group['last'],
            );
        }
        return $out;
    }

    private const MONTHS = [
        1 => 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
        'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
    ];

    private static function periodLabel(string $key, string $by): string
    {
        return match ($by) {
            'day'   => Clock::format((int) Clock::startOfDay($key), 'd.m.Y'),
            // date('F') liefert immer englische Monatsnamen.
            'month' => self::MONTHS[(int) substr($key, 5, 2)] . ' ' . substr($key, 0, 4),
            'week'  => 'KW ' . substr($key, 6) . ' / ' . substr($key, 0, 4),
            default => $key,
        };
    }

    private static function groupRow(
        string $key,
        string $label,
        ?string $color,
        int $entries,
        int $minutes,
        float $amount,
        int $firstAt,
        int $lastAt,
    ): array {
        $out = [
            'key'      => $key,
            'label'    => $label,
            'color'    => $color,
            'entries'  => $entries,
            'minutes'  => $minutes,
            'hhmm'     => Clock::hhmm($minutes),
            'decimal'  => Clock::decimal($minutes),
            'first_at' => Clock::iso($firstAt),
            'last_at'  => Clock::iso($lastAt),
        ];
        if (Scope::current()->showCosts) {
            $out['amount'] = round($amount, 2);
        }
        return $out;
    }

    public static function find(int $id, bool $orFail = false): ?array
    {
        [$scopeSql, $params] = Scope::current()->condition('p.client_id', 'p.id');
        $params['id'] = $id;

        $row = Database::one(
            'SELECT ' . self::SELECT . ' ' . self::JOIN . " WHERE e.id = :id AND $scopeSql",
            $params
        );
        if ($row === null && $orFail) {
            throw HttpException::notFound('Eintrag nicht gefunden.');
        }
        return $row === null ? null : self::hydrate($row);
    }

    public static function findOrFail(int $id): array
    {
        return self::find($id, true);
    }

    /**
     * @param array{
     *   subproject_id:int, started_at:int, ended_at:int,
     *   note?:string, rate?:float|null, billable?:bool, type?:string,
     *   source?:string, round?:bool, billed?:bool
     * } $data
     */
    public static function create(array $data): int
    {
        $sub = SubprojectRepo::findOrFail((int) $data['subproject_id']);

        $round = $data['round'] ?? true;
        $start = $round ? Settings::roundTimestamp((int) $data['started_at']) : (int) $data['started_at'];
        $end   = $round ? Settings::roundTimestamp((int) $data['ended_at']) : (int) $data['ended_at'];

        self::assertSpan($start, $end);

        $minutes = (int) round(($end - $start) / 60);
        $rate = $data['rate'] ?? Rates::forSubproject($sub['id']);
        $now = Clock::now();

        return Database::insert('entries', [
            'subproject_id' => $sub['id'],
            'started_at'    => $start,
            'ended_at'      => $end,
            'duration_min'  => $minutes,
            'note'          => $data['note'] ?? '',
            'rate'          => $rate,
            'amount'        => Rates::amount($minutes, (float) $rate),
            'type'          => $data['type'] ?? 'time',
            'billable'      => ($data['billable'] ?? true) ? 1 : 0,
            'source'        => $data['source'] ?? 'manual',
            'billed_at'     => !empty($data['billed']) ? $now : null,
            'created_at'    => $now,
            'updated_at'    => $now,
        ]);
    }

    /**
     * Eintrag ändern. `billed` (true/false) setzt den Status: "offen" gibt
     * einen abgerechneten Eintrag zuerst frei und wendet dann die übrigen
     * Änderungen an; "abgerechnet" ändert zuerst und sperrt dann. Ohne
     * Statuswechsel bleibt ein abgerechneter Eintrag gesperrt.
     *
     * `budget_id` und `billed_at` setzt nur BudgetRepo (die Controller
     * reichen sie nicht durch): mit `billed` = true wird über das Paket
     * abgerechnet, ohne `billed` hängt ein schon abgerechneter Eintrag nur
     * am Paket (bzw. mit null wieder ab). Über ein Paket abgerechnete
     * Einträge öffnet nur BudgetRepo::unbill() wieder – mit budget_id null.
     *
     * @param array<string,mixed> $data
     */
    public static function update(int $id, array $data): array
    {
        $entry = self::findOrFail($id);

        $billed = array_key_exists('billed', $data) ? (bool) $data['billed'] : null;
        $budgetGiven = array_key_exists('budget_id', $data);
        $budgetId = $budgetGiven && $data['budget_id'] !== null ? (int) $data['budget_id'] : null;
        $billedAt = isset($data['billed_at']) ? (int) $data['billed_at'] : Clock::now();
        unset($data['billed'], $data['budget_id'], $data['billed_at']);

        if ($entry['billed']) {
            if ($billed !== false) {
                // Paketzuordnung eines abgerechneten Eintrags – Inhalt bleibt.
                if ($budgetGiven && $data === []) {
                    Database::update('entries', $id, ['budget_id' => $budgetId, 'updated_at' => Clock::now()]);
                    return self::findOrFail($id);
                }
                // Nur "bleibt abgerechnet" bestätigt – nichts zu tun.
                if ($data === []) {
                    return $entry;
                }
                self::assertEditable($entry);
            }
            if ($entry['invoice_id'] !== null) {
                self::assertEditable($entry); // an einer Rechnung: nicht wieder öffnen
            }
            if ($entry['budget_id'] !== null && !($budgetGiven && $budgetId === null)) {
                self::assertEditable($entry); // über ein Paket: nur mit dem Paket wieder öffnen
            }
            Database::update('entries', $id, ['billed_at' => null, 'budget_id' => null, 'updated_at' => Clock::now()]);
            $entry = self::findOrFail($id);
        }

        $entry = self::applyChanges($id, $entry, $data);

        if ($billed === true) {
            Database::update('entries', $id, [
                'billed_at'  => $billedAt,
                'budget_id'  => $budgetId,
                'updated_at' => Clock::now(),
            ]);
            $entry = self::findOrFail($id);
        }

        return $entry;
    }

    /**
     * Einen offenen Eintrag in aufeinanderfolgende Stücke teilen, z. B. an
     * der Grenze zweier Stundenpakete. Das erste Stück behält die ID, die
     * übrigen sind neue Einträge mit Teilprojekt, Notiz, Satz und Art des
     * Originals. Die Zeiten schließen lückenlos aneinander an.
     *
     * @param list<int> $minutes Dauer je Stück, Summe = Dauer des Eintrags
     * @return list<int> IDs der Stücke in zeitlicher Reihenfolge
     */
    public static function split(int $id, array $minutes): array
    {
        $entry = self::findOrFail($id);
        self::assertEditable($entry);

        if (count($minutes) < 2 || min($minutes) <= 0 || array_sum($minutes) !== $entry['duration_min']) {
            throw HttpException::badRequest('Die Stücke passen nicht zur Dauer des Eintrags.');
        }

        $row = Database::one('SELECT * FROM entries WHERE id = :id', ['id' => $id]);

        return Database::transaction(static function () use ($id, $row, $minutes): array {
            $now = Clock::now();
            $cursor = (int) $row['started_at'];
            $last = count($minutes) - 1;
            $ids = [];

            foreach ($minutes as $i => $part) {
                $start = $cursor;
                $end = $start + $part * 60;
                // Das letzte Stück endet wie das Original, falls die Dauer
                // von der Zeitspanne abweicht (z. B. aus dem Import).
                if ($i === $last && (int) $row['ended_at'] >= $start) {
                    $end = (int) $row['ended_at'];
                }
                $cursor = $end;

                $fields = [
                    'started_at'   => $start,
                    'ended_at'     => $end,
                    'duration_min' => $part,
                    'amount'       => Rates::amount($part, (float) $row['rate']),
                    'updated_at'   => $now,
                ];

                if ($i === 0) {
                    Database::update('entries', $id, $fields);
                    $ids[] = $id;
                    continue;
                }
                $ids[] = Database::insert('entries', $fields + [
                    'subproject_id' => $row['subproject_id'],
                    'note'          => $row['note'],
                    'rate'          => $row['rate'],
                    'type'          => $row['type'],
                    'billable'      => $row['billable'],
                    'source'        => $row['source'],
                    'created_at'    => $now,
                ]);
            }

            return $ids;
        });
    }

    /** Die eigentlichen Feldänderungen eines offenen Eintrags. */
    private static function applyChanges(int $id, array $entry, array $data): array
    {
        $fields = [];

        if (array_key_exists('subproject_id', $data)) {
            $sub = SubprojectRepo::findOrFail((int) $data['subproject_id']);
            $fields['subproject_id'] = $sub['id'];
        }

        $round = $data['round'] ?? false; // beim Nachbearbeiten nicht ungefragt runden
        $start = array_key_exists('started_at', $data)
            ? ($round ? Settings::roundTimestamp((int) $data['started_at']) : (int) $data['started_at'])
            : Clock::fromIso($entry['started_at']);
        $end = array_key_exists('ended_at', $data)
            ? ($round ? Settings::roundTimestamp((int) $data['ended_at']) : (int) $data['ended_at'])
            : Clock::fromIso($entry['ended_at']);

        if ($start !== Clock::fromIso($entry['started_at']) || $end !== Clock::fromIso($entry['ended_at'])) {
            self::assertSpan((int) $start, (int) $end);
            $fields['started_at'] = $start;
            $fields['ended_at'] = $end;
            $fields['duration_min'] = (int) round(($end - $start) / 60);
        }

        if (array_key_exists('note', $data)) {
            $fields['note'] = (string) $data['note'];
        }
        if (array_key_exists('billable', $data)) {
            $fields['billable'] = $data['billable'] ? 1 : 0;
        }
        if (array_key_exists('type', $data)) {
            $fields['type'] = (string) $data['type'];
        }
        if (array_key_exists('rate', $data)) {
            // null = Satz aus der Hierarchie neu übernehmen
            $subprojectId = $fields['subproject_id'] ?? $entry['subproject_id'];
            $fields['rate'] = $data['rate'] === null
                ? Rates::forSubproject((int) $subprojectId)
                : (float) $data['rate'];
        }

        if ($fields === []) {
            return $entry;
        }

        $minutes = $fields['duration_min'] ?? $entry['duration_min'];
        $rate = $fields['rate'] ?? $entry['rate'];
        $fields['amount'] = Rates::amount((int) $minutes, (float) $rate);
        $fields['updated_at'] = Clock::now();

        Database::update('entries', $id, $fields);
        return self::findOrFail($id);
    }

    /**
     * Mehrere Einträge in einem Zug ändern – Teilprojekt, Satz, abrechenbar,
     * Status (offen/abgerechnet).
     *
     * Zeiten und Notizen gehören bewusst nicht dazu: die sind je Eintrag
     * verschieden, ein gemeinsamer Wert wäre fast immer ein Versehen. Jeder
     * Eintrag läuft durch update() – Satzvererbung, Betrag und die Regeln
     * zum Status (siehe dort) sind also dieselben wie beim einzelnen
     * Bearbeiten. Was update() ablehnen würde (abgerechnet ohne Wechsel auf
     * "offen", an einer Rechnung), wird übersprungen statt den ganzen
     * Vorgang abzubrechen.
     *
     * @param list<int> $ids
     * @param array{subproject_id?:int, rate?:float|null, billable?:bool} $data
     * @param bool|null $billed true = abrechnen, false = wieder öffnen, null = unverändert
     * @return array{updated:list<int>, unchanged:list<int>, skipped:list<array{id:int, reason:string}>}
     */
    public static function batchUpdate(array $ids, array $data, ?bool $billed = null): array
    {
        if (array_key_exists('subproject_id', $data)) {
            // Einmal vorab, damit ein unbekanntes Ziel nicht erst mitten im
            // Durchlauf auffällt.
            SubprojectRepo::findOrFail((int) $data['subproject_id']);
        }

        return Database::transaction(static function () use ($ids, $data, $billed): array {
            $updated = [];
            $unchanged = [];
            $skipped = [];

            foreach (array_values(array_unique($ids)) as $id) {
                $entry = self::find($id);
                if ($entry === null) {
                    $skipped[] = ['id' => $id, 'reason' => 'not_found'];
                    continue;
                }
                if ($entry['deleted_at'] !== null) {
                    $skipped[] = ['id' => $id, 'reason' => 'trashed'];
                    continue;
                }

                // Was update() ablehnen würde, hier überspringen statt den
                // ganzen Vorgang abzubrechen.
                $stays = $entry['billed'] && $billed !== false;
                if ($stays && $data !== []) {
                    $skipped[] = ['id' => $id, 'reason' => 'billed'];
                    continue;
                }
                if ($entry['billed'] && $billed === false && $entry['invoice_id'] !== null) {
                    $skipped[] = ['id' => $id, 'reason' => 'invoiced'];
                    continue;
                }
                if ($entry['billed'] && $billed === false && $entry['budget_id'] !== null) {
                    $skipped[] = ['id' => $id, 'reason' => 'budget'];
                    continue;
                }
                if ($data === [] && $billed === $entry['billed']) {
                    $unchanged[] = $id; // Status stimmte schon
                    continue;
                }

                self::update($id, $billed === null ? $data : $data + ['billed' => $billed]);
                $updated[] = $id;
            }

            return ['updated' => $updated, 'unchanged' => $unchanged, 'skipped' => $skipped];
        });
    }

    /**
     * Mehrere Einträge in den Papierkorb legen (`trash`), zurückholen
     * (`restore`) oder endgültig entfernen (`purge`, nur aus dem Papierkorb).
     * Was die Einzelaktion ablehnen würde – abgerechnete Einträge lassen sich
     * nicht löschen –, wird übersprungen statt den Vorgang abzubrechen.
     *
     * @param list<int> $ids
     * @return array{done:list<int>, skipped:list<array{id:int, reason:string}>}
     */
    public static function batchRemove(array $ids, string $action): array
    {
        return Database::transaction(static function () use ($ids, $action): array {
            $done = [];
            $skipped = [];

            foreach (array_values(array_unique($ids)) as $id) {
                $entry = self::find($id);
                if ($entry === null) {
                    $skipped[] = ['id' => $id, 'reason' => 'not_found'];
                    continue;
                }
                $trashed = $entry['deleted_at'] !== null;

                if ($action === 'trash') {
                    if ($trashed) {
                        $skipped[] = ['id' => $id, 'reason' => 'trashed'];
                        continue;
                    }
                    if ($entry['billed']) {
                        $skipped[] = ['id' => $id, 'reason' => 'billed'];
                        continue;
                    }
                    self::delete($id);
                } else {
                    if (!$trashed) {
                        $skipped[] = ['id' => $id, 'reason' => 'not_trashed'];
                        continue;
                    }
                    $action === 'restore' ? self::restore($id) : self::purge($id);
                }
                $done[] = $id;
            }

            return ['done' => $done, 'skipped' => $skipped];
        });
    }

    /** Papierkorb statt hartem Löschen. */
    public static function delete(int $id): void
    {
        $entry = self::findOrFail($id);
        self::assertEditable($entry);

        Database::update('entries', $id, ['deleted_at' => Clock::now(), 'updated_at' => Clock::now()]);
    }

    public static function restore(int $id): array
    {
        self::findOrFail($id);
        Database::update('entries', $id, ['deleted_at' => null, 'updated_at' => Clock::now()]);
        return self::findOrFail($id);
    }

    /** Endgültig entfernen – nur aus dem Papierkorb. */
    public static function purge(int $id): void
    {
        $entry = self::findOrFail($id);
        if ($entry['deleted_at'] === null) {
            throw HttpException::conflict('Eintrag liegt nicht im Papierkorb.');
        }
        Database::run('DELETE FROM entries WHERE id = :id', ['id' => $id]);
    }

    /**
     * Zuletzt bebuchte Teilprojekte – Schnellwahl auf der Timer-Seite.
     *
     * @return list<array<string,mixed>>
     */
    public static function recentSubprojects(int $limit = 10): array
    {
        [$scopeSql, $params] = Scope::current()->condition('p.client_id', 'p.id');
        $limit = max(1, min(50, $limit));

        $rows = Database::all(
            "SELECT s.id, MAX(e.started_at) AS last_at, COUNT(*) AS uses
               FROM entries e
               JOIN subprojects s ON s.id = e.subproject_id
               JOIN projects    p ON p.id = s.project_id
              WHERE e.deleted_at IS NULL AND s.deleted_at IS NULL AND s.archived = 0 AND $scopeSql
              GROUP BY s.id
              ORDER BY last_at DESC
              LIMIT $limit",
            $params
        );

        $out = [];
        foreach ($rows as $row) {
            $sub = SubprojectRepo::find((int) $row['id']);
            if ($sub !== null) {
                $sub['last_at'] = Clock::iso((int) $row['last_at']);
                $sub['uses'] = (int) $row['uses'];
                $out[] = $sub;
            }
        }
        return $out;
    }

    /** Einträge, die sich zeitlich mit dem Zeitraum überschneiden. */
    public static function overlapping(int $start, int $end, ?int $exceptId = null): array
    {
        [$scopeSql, $params] = Scope::current()->condition('p.client_id', 'p.id');
        $params['start'] = $start;
        $params['end'] = $end;

        $sql = 'SELECT ' . self::SELECT . ' ' . self::JOIN .
               " WHERE e.deleted_at IS NULL AND e.started_at < :end AND e.ended_at > :start AND $scopeSql";
        if ($exceptId !== null) {
            $sql .= ' AND e.id != :except';
            $params['except'] = $exceptId;
        }

        return array_map([self::class, 'hydrate'], Database::all($sql . ' ORDER BY e.started_at', $params));
    }

    // -- intern -------------------------------------------------------------

    /** @return array{0:list<string>,1:array<string,mixed>} */
    private static function buildWhere(array $opts): array
    {
        [$scopeSql, $params] = Scope::current()->condition('p.client_id', 'p.id');
        $where = [$scopeSql];

        $where[] = ($opts['trashed'] ?? false) ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL';

        if (!empty($opts['from'])) {
            $ts = Clock::startOfDay((string) $opts['from']);
            if ($ts === null) {
                throw HttpException::badRequest('Ungültiges Startdatum.');
            }
            $where[] = 'e.started_at >= :from';
            $params['from'] = $ts;
        }
        if (!empty($opts['to'])) {
            $ts = Clock::endOfDay((string) $opts['to']);
            if ($ts === null) {
                throw HttpException::badRequest('Ungültiges Enddatum.');
            }
            $where[] = 'e.started_at < :to';
            $params['to'] = $ts;
        }
        if (!empty($opts['ids'])) {
            // Ausdrückliche Auswahl (angehakte Einträge). Scope und Papierkorb
            // gelten weiter – eine fremde ID liefert schlicht nichts.
            $names = [];
            foreach (array_values($opts['ids']) as $i => $id) {
                $names[] = ':id' . $i;
                $params['id' . $i] = (int) $id;
            }
            $where[] = 'e.id IN (' . implode(', ', $names) . ')';
        }
        // Kunde und Projekt: eine ID oder eine Liste (Mehrfachauswahl im Filter).
        foreach (['client_id' => 'p.client_id', 'project_id' => 's.project_id'] as $key => $column) {
            $values = array_values(array_filter(array_map('intval', (array) ($opts[$key] ?? []))));
            if ($values === []) {
                continue;
            }
            $names = [];
            foreach ($values as $i => $value) {
                $names[] = ":{$key}{$i}";
                $params["{$key}{$i}"] = $value;
            }
            $where[] = "$column IN (" . implode(', ', $names) . ')';
        }
        // archived=false: Einträge archivierter Kunden/Projekte ausblenden.
        // Ohne Angabe (oder true) gilt kein Filter.
        if (array_key_exists('archived', $opts) && $opts['archived'] === false) {
            $where[] = 'p.archived = 0 AND c.archived = 0';
        }
        if (!empty($opts['subproject_id'])) {
            $where[] = 'e.subproject_id = :subproject_id';
            $params['subproject_id'] = (int) $opts['subproject_id'];
        }
        if (array_key_exists('billed', $opts) && $opts['billed'] !== null) {
            $where[] = $opts['billed'] ? 'e.billed_at IS NOT NULL' : 'e.billed_at IS NULL';
        }
        if (array_key_exists('billable', $opts) && $opts['billable'] !== null) {
            $where[] = 'e.billable = :billable';
            $params['billable'] = $opts['billable'] ? 1 : 0;
        }
        if (!empty($opts['type'])) {
            $where[] = 'e.type = :type';
            $params['type'] = (string) $opts['type'];
        }
        if (!empty($opts['q'])) {
            // FTS5 für die Notizen, LIKE zusätzlich für Stammdatennamen.
            $where[] = '(e.id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH :fts)
                         OR c.name LIKE :like OR p.name LIKE :like OR s.name LIKE :like)';
            $params['fts'] = self::ftsQuery((string) $opts['q']);
            $params['like'] = '%' . $opts['q'] . '%';
        }

        return [$where, $params];
    }

    /** Nutzereingabe in eine harmlose FTS5-Abfrage übersetzen. */
    private static function ftsQuery(string $input): string
    {
        $terms = preg_split('/\s+/', trim($input)) ?: [];
        $quoted = [];
        foreach ($terms as $term) {
            $term = preg_replace('/["\']/', '', $term);
            if ($term !== null && $term !== '') {
                $quoted[] = '"' . $term . '"*';
            }
        }
        return $quoted === [] ? '""' : implode(' ', $quoted);
    }

    private static function assertSpan(int $start, int $end): void
    {
        if ($end < $start) {
            throw HttpException::validation(['ended_at' => 'Das Ende liegt vor dem Beginn.']);
        }
        if ($end - $start > 86400 * 7) {
            throw HttpException::validation(['ended_at' => 'Ein Eintrag darf höchstens sieben Tage umfassen.']);
        }
    }

    /** Abgerechnete Einträge sind gesperrt – sonst weicht die Rechnung ab. */
    private static function assertEditable(array $entry): void
    {
        if ($entry['billed_at'] !== null) {
            throw HttpException::conflict(
                match (true) {
                    $entry['invoice_number'] !== null
                        => 'Der Eintrag ist mit Rechnung ' . $entry['invoice_number'] . ' abgerechnet und gesperrt.',
                    $entry['budget_id'] !== null
                        => 'Der Eintrag ist über ein Stundenpaket abgerechnet und gesperrt. Zum Ändern in den Stammdaten die Abrechnung des Pakets aufheben.',
                    default
                        => 'Der Eintrag ist abgerechnet und gesperrt. Zum Ändern den Status wieder auf „offen“ setzen.',
                },
                [
                    'invoice_id'     => $entry['invoice_id'],
                    'invoice_number' => $entry['invoice_number'],
                    'budget_id'      => $entry['budget_id'],
                ]
            );
        }
    }

    /** @param array<string,mixed> $row */
    public static function hydrate(array $row): array
    {
        $start = (int) $row['started_at'];
        $end = (int) $row['ended_at'];
        $minutes = (int) $row['duration_min'];
        $showCosts = Scope::current()->showCosts;

        $out = [
            'id'              => (int) $row['id'],
            'subproject_id'   => (int) $row['subproject_id'],
            'subproject_name' => (string) $row['subproject_name'],
            'project_id'      => (int) $row['project_id'],
            'project_name'    => (string) $row['project_name'],
            'client_id'       => (int) $row['client_id'],
            'client_name'     => (string) $row['client_name'],
            'archived'        => !empty($row['project_archived']) || !empty($row['client_archived']),
            'color'           => $row['project_color'] ?? $row['client_color'] ?? null,
            'path'            => sprintf('%s | %s | %s', $row['client_name'], $row['project_name'], $row['subproject_name']),
            'started_at'      => Clock::iso($start),
            'ended_at'        => Clock::iso($end),
            'date'            => Clock::day($start),
            'start_time'      => Clock::format($start, 'H:i'),
            'end_time'        => Clock::format($end, 'H:i'),
            'duration_min'    => $minutes,
            'hhmm'            => Clock::hhmm($minutes),
            'decimal'         => Clock::decimal($minutes),
            'note'            => (string) $row['note'],
            'type'            => (string) $row['type'],
            'billable'        => (bool) $row['billable'],
            'billed'          => $row['billed_at'] !== null,
            'billed_at'       => $row['billed_at'] === null ? null : Clock::iso((int) $row['billed_at']),
            'invoice_id'      => $row['invoice_id'] === null ? null : (int) $row['invoice_id'],
            'invoice_number'  => $row['invoice_number'],
            'budget_id'       => $row['budget_id'] === null ? null : (int) $row['budget_id'],
            'budget_note'     => $row['budget_id'] === null ? null : (string) ($row['budget_note'] ?? ''),
            'budget_starts_on' => $row['budget_starts_at'] === null ? null : Clock::day((int) $row['budget_starts_at']),
            'source'          => (string) $row['source'],
            'overnight'       => Clock::day($start) !== Clock::day($end),
            'deleted_at'      => $row['deleted_at'] === null ? null : Clock::iso((int) $row['deleted_at']),
            'created_at'      => Clock::iso((int) $row['created_at']),
            'updated_at'      => Clock::iso((int) $row['updated_at']),
        ];

        // Kundenzugänge ohne Kostenrecht sehen weder Satz noch Betrag.
        if ($showCosts) {
            $out['rate'] = round((float) $row['rate'], 2);
            $out['amount'] = round((float) $row['amount'], 2);
            $out['currency'] = (string) ($row['currency'] ?? 'EUR');
        }

        return $out;
    }
}
