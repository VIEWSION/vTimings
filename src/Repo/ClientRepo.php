<?php
declare(strict_types=1);

namespace VT\Repo;

use VT\Db\Database;
use VT\Domain\Rates;
use VT\Http\HttpException;
use VT\Support\Clock;

final class ClientRepo
{
    /**
     * @param array{archived?:bool|null, stats?:bool, q?:string} $opts
     * @return list<array<string,mixed>>
     */
    public static function list(array $opts = []): array
    {
        $scope = Scope::current();
        [$scopeSql, $params] = $scope->clientCondition('c.id');

        $where = ['c.deleted_at IS NULL', $scopeSql];

        if (array_key_exists('archived', $opts) && $opts['archived'] !== null) {
            $where[] = 'c.archived = :archived';
            $params['archived'] = $opts['archived'] ? 1 : 0;
        }
        if (!empty($opts['q'])) {
            $where[] = 'c.name LIKE :q';
            $params['q'] = '%' . $opts['q'] . '%';
        }

        $select = 'c.*';
        $join = '';
        if ($opts['stats'] ?? true) {
            [$projSql, $projParams] = $scope->projectCondition('p.id');
            $params += $projParams;

            $select .= ', COALESCE(st.minutes, 0) AS total_minutes,
                         COALESCE(st.amount, 0)  AS total_amount,
                         COALESCE(st.entries, 0) AS entry_count,
                         st.last_at';
            $join = "LEFT JOIN (
                        SELECT p.client_id       AS client_id,
                               SUM(e.duration_min) AS minutes,
                               SUM(e.amount)       AS amount,
                               COUNT(*)            AS entries,
                               MAX(e.started_at)   AS last_at
                          FROM entries e
                          JOIN subprojects s ON s.id = e.subproject_id
                          JOIN projects    p ON p.id = s.project_id
                         WHERE e.deleted_at IS NULL AND $projSql
                         GROUP BY p.client_id
                     ) st ON st.client_id = c.id";
        }

        $rows = Database::all(
            "SELECT $select FROM clients c $join
              WHERE " . implode(' AND ', $where) . '
              ORDER BY c.archived, c.sort, c.name COLLATE NOCASE',
            $params
        );

        $clients = array_map([self::class, 'hydrate'], $rows);

        if ($opts['stats'] ?? true) {
            $pools = BudgetRepo::poolsByKey();
            foreach ($clients as &$client) {
                $client['budget'] = $pools[BudgetRepo::key($client['id'], null)] ?? null;
            }
            unset($client);
        }

        return $clients;
    }

    public static function find(int $id, bool $orFail = false): ?array
    {
        [$scopeSql, $params] = Scope::current()->clientCondition('c.id');
        $params['id'] = $id;

        $row = Database::one(
            "SELECT c.* FROM clients c WHERE c.id = :id AND c.deleted_at IS NULL AND $scopeSql",
            $params
        );
        if ($row === null && $orFail) {
            throw HttpException::notFound('Kunde nicht gefunden.');
        }
        return $row === null ? null : self::hydrate($row);
    }

    public static function findOrFail(int $id): array
    {
        return self::find($id, true);
    }

    /** @param array<string,mixed> $data */
    public static function create(array $data): int
    {
        self::assertNameFree((string) $data['name']);

        $now = Clock::now();
        return Database::insert('clients', [
            'name'            => $data['name'],
            'color'           => $data['color'] ?? null,
            'rate'            => $data['rate'] ?? null,
            'currency'        => $data['currency'] ?? 'EUR',
            'lang'            => $data['lang'] ?? 'de',
            'note'            => $data['note'] ?? '',
            'contact_name'    => $data['contact_name'] ?? '',
            'contact_email'   => $data['contact_email'] ?? '',
            'contact_address' => $data['contact_address'] ?? '',
            'visibility_offset_days' => (int) ($data['visibility_offset_days'] ?? 1),
            'archived'        => !empty($data['archived']) ? 1 : 0,
            'sort'            => (int) ($data['sort'] ?? 0),
            'created_at'      => $now,
            'updated_at'      => $now,
        ]);
    }

    /** @param array<string,mixed> $data */
    public static function update(int $id, array $data): array
    {
        $client = self::findOrFail($id);

        if (isset($data['name']) && $data['name'] !== $client['name']) {
            self::assertNameFree((string) $data['name'], $id);
        }

        $fields = array_intersect_key($data, array_flip([
            'name', 'color', 'rate', 'currency', 'lang', 'note',
            'contact_name', 'contact_email', 'contact_address',
            'visibility_offset_days', 'archived', 'sort',
        ]));
        if (isset($fields['archived'])) {
            $fields['archived'] = $fields['archived'] ? 1 : 0;
        }
        $fields['updated_at'] = Clock::now();

        Database::update('clients', $id, $fields);
        return self::findOrFail($id);
    }

    /**
     * Soft-Delete. Verweigert, solange Projekte oder Einträge daran hängen –
     * Archivieren ist in dem Fall der richtige Weg.
     */
    public static function delete(int $id): void
    {
        self::findOrFail($id);

        // Auch Einträge im Papierkorb zählen: beim Wiederherstellen hätten sie
        // sonst keinen Kunden mehr.
        $counts = Database::one(
            'SELECT COUNT(*) AS total, COALESCE(SUM(e.deleted_at IS NOT NULL), 0) AS trashed
               FROM entries e
               JOIN subprojects s ON s.id = e.subproject_id
               JOIN projects p ON p.id = s.project_id
              WHERE p.client_id = :id',
            ['id' => $id]
        );
        if ((int) $counts['total'] > 0) {
            throw HttpException::conflict(
                SubprojectRepo::entriesMessage('Kunde', (int) $counts['total'], (int) $counts['trashed']),
                ['entries' => (int) $counts['total'], 'trashed' => (int) $counts['trashed']]
            );
        }

        $projects = (int) Database::value(
            'SELECT COUNT(*) FROM projects WHERE client_id = :id AND deleted_at IS NULL',
            ['id' => $id]
        );
        if ($projects > 0) {
            throw HttpException::conflict(
                "Kunde hat noch $projects Projekt(e). Bitte zuerst löschen oder den Kunden archivieren.",
                ['projects' => $projects]
            );
        }

        Database::update('clients', $id, ['deleted_at' => Clock::now(), 'updated_at' => Clock::now()]);
    }

    private static function assertNameFree(string $name, ?int $exceptId = null): void
    {
        $params = ['name' => $name];
        $sql = 'SELECT id FROM clients WHERE name = :name AND deleted_at IS NULL';
        if ($exceptId !== null) {
            $sql .= ' AND id != :id';
            $params['id'] = $exceptId;
        }
        if (Database::one($sql, $params) !== null) {
            throw HttpException::conflict("Es gibt bereits einen Kunden mit dem Namen „$name\".");
        }
    }

    /** @param array<string,mixed> $row */
    public static function hydrate(array $row): array
    {
        $showCosts = Scope::current()->showCosts;

        $out = [
            'id'              => (int) $row['id'],
            'name'            => (string) $row['name'],
            'color'           => $row['color'],
            'currency'        => (string) $row['currency'],
            'lang'            => (string) $row['lang'],
            'note'            => (string) $row['note'],
            'contact_name'    => (string) $row['contact_name'],
            'contact_email'   => (string) $row['contact_email'],
            'contact_address' => (string) $row['contact_address'],
            'visibility_offset_days' => (int) $row['visibility_offset_days'],
            'archived'        => (bool) $row['archived'],
            'sort'            => (int) $row['sort'],
            'created_at'      => Clock::iso((int) $row['created_at']),
            'updated_at'      => Clock::iso((int) $row['updated_at']),
        ];

        // Sätze und Beträge sind Kostendaten – ein Kundenzugang ohne
        // Kostenrecht darf sie auch hier nicht zu sehen bekommen.
        if ($showCosts) {
            $out['rate'] = $row['rate'] === null ? null : (float) $row['rate'];
            $out['effective_rate'] = $row['rate'] === null ? Rates::default() : (float) $row['rate'];
        }

        if (array_key_exists('total_minutes', $row)) {
            $minutes = (int) $row['total_minutes'];
            $out['stats'] = [
                'minutes' => $minutes,
                'hhmm'    => Clock::hhmm($minutes),
                'decimal' => Clock::decimal($minutes),
                'entries' => (int) $row['entry_count'],
                'last_at' => $row['last_at'] === null ? null : Clock::iso((int) $row['last_at']),
            ];
            if ($showCosts) {
                $out['stats']['amount'] = round((float) $row['total_amount'], 2);
            }
        }

        return $out;
    }
}
