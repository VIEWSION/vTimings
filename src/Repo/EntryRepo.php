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
        i.number AS invoice_number';

    private const JOIN = 'FROM entries e
        JOIN subprojects s ON s.id = e.subproject_id
        JOIN projects    p ON p.id = s.project_id
        JOIN clients     c ON c.id = p.client_id
        LEFT JOIN invoices i ON i.id = e.invoice_id';

    /**
     * @param array{
     *   from?:string|null, to?:string|null,
     *   client_id?:int|null, project_id?:int|null, subproject_id?:int|null,
     *   q?:string, billed?:bool|null, type?:string|null, billable?:bool|null,
     *   trashed?:bool, limit?:int, offset?:int, order?:string
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
     *   source?:string, round?:bool
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
            'created_at'    => $now,
            'updated_at'    => $now,
        ]);
    }

    /** @param array<string,mixed> $data */
    public static function update(int $id, array $data): array
    {
        $entry = self::findOrFail($id);
        self::assertEditable($entry);

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
     * Mehrere Einträge in einem Zug ändern – Teilprojekt, Satz, abrechenbar.
     *
     * Zeiten und Notizen gehören bewusst nicht dazu: die sind je Eintrag
     * verschieden, ein gemeinsamer Wert wäre fast immer ein Versehen. Jeder
     * Eintrag läuft durch update(), damit Satzvererbung und Betrag genauso
     * entstehen wie beim einzelnen Bearbeiten. Abgerechnete und gelöschte
     * Einträge werden übersprungen statt den ganzen Vorgang abzubrechen.
     *
     * @param list<int> $ids
     * @param array{subproject_id?:int, rate?:float|null, billable?:bool} $data
     * @return array{updated:list<int>, skipped:list<array{id:int, reason:string}>}
     */
    public static function batchUpdate(array $ids, array $data): array
    {
        if (array_key_exists('subproject_id', $data)) {
            // Einmal vorab, damit ein unbekanntes Ziel nicht erst mitten im
            // Durchlauf auffällt.
            SubprojectRepo::findOrFail((int) $data['subproject_id']);
        }

        return Database::transaction(static function () use ($ids, $data): array {
            $updated = [];
            $skipped = [];

            foreach (array_values(array_unique($ids)) as $id) {
                $entry = self::find($id);
                if ($entry === null) {
                    $skipped[] = ['id' => $id, 'reason' => 'not_found'];
                } elseif ($entry['deleted_at'] !== null) {
                    $skipped[] = ['id' => $id, 'reason' => 'trashed'];
                } elseif ($entry['billed']) {
                    $skipped[] = ['id' => $id, 'reason' => 'billed'];
                } else {
                    self::update($id, $data);
                    $updated[] = $id;
                }
            }

            return ['updated' => $updated, 'skipped' => $skipped];
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
        if (!empty($opts['client_id'])) {
            $where[] = 'p.client_id = :client_id';
            $params['client_id'] = (int) $opts['client_id'];
        }
        if (!empty($opts['project_id'])) {
            $where[] = 's.project_id = :project_id';
            $params['project_id'] = (int) $opts['project_id'];
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
                'Der Eintrag ist mit Rechnung ' . ($entry['invoice_number'] ?? '—') . ' abgerechnet und gesperrt.',
                ['invoice_id' => $entry['invoice_id'], 'invoice_number' => $entry['invoice_number']]
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
