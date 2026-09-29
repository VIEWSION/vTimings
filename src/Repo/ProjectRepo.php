<?php
declare(strict_types=1);

namespace VT\Repo;

use VT\Db\Database;
use VT\Domain\Rates;
use VT\Http\HttpException;
use VT\Support\Clock;

final class ProjectRepo
{
    /**
     * @param array{client_id?:int|null, archived?:bool|null, stats?:bool, q?:string} $opts
     * @return list<array<string,mixed>>
     */
    public static function list(array $opts = []): array
    {
        $scope = Scope::current();
        [$scopeSql, $params] = $scope->condition('p.client_id', 'p.id');

        $where = ['p.deleted_at IS NULL', 'c.deleted_at IS NULL', $scopeSql];

        if (!empty($opts['client_id'])) {
            $where[] = 'p.client_id = :client_id';
            $params['client_id'] = (int) $opts['client_id'];
        }
        if (array_key_exists('archived', $opts) && $opts['archived'] !== null) {
            $where[] = 'p.archived = :archived';
            $params['archived'] = $opts['archived'] ? 1 : 0;
        }
        if (!empty($opts['q'])) {
            $where[] = '(p.name LIKE :q OR c.name LIKE :q)';
            $params['q'] = '%' . $opts['q'] . '%';
        }

        $select = 'p.*, c.name AS client_name, c.color AS client_color, c.rate AS client_rate, c.currency AS currency';
        $join = '';
        if ($opts['stats'] ?? true) {
            $select .= ', COALESCE(st.minutes, 0) AS total_minutes,
                         COALESCE(st.amount, 0)  AS total_amount,
                         COALESCE(st.entries, 0) AS entry_count,
                         st.last_at';
            $join = 'LEFT JOIN (
                        SELECT s.project_id        AS project_id,
                               SUM(e.duration_min) AS minutes,
                               SUM(e.amount)       AS amount,
                               COUNT(*)            AS entries,
                               MAX(e.started_at)   AS last_at
                          FROM entries e
                          JOIN subprojects s ON s.id = e.subproject_id
                         WHERE e.deleted_at IS NULL
                         GROUP BY s.project_id
                     ) st ON st.project_id = p.id';
        }

        $rows = Database::all(
            "SELECT $select
               FROM projects p
               JOIN clients c ON c.id = p.client_id
               $join
              WHERE " . implode(' AND ', $where) . '
              ORDER BY c.name COLLATE NOCASE, p.archived, p.sort, p.name COLLATE NOCASE',
            $params
        );

        $projects = array_map([self::class, 'hydrate'], $rows);

        if ($opts['stats'] ?? true) {
            $pools = BudgetRepo::poolsByKey(!empty($opts['client_id']) ? (int) $opts['client_id'] : null);
            foreach ($projects as &$project) {
                $pool = $pools[BudgetRepo::key($project['client_id'], $project['id'])] ?? null;
                $project['budget'] = $pool;
                $project['progress'] = $pool['progress'] ?? null;
            }
            unset($project);
        }

        return $projects;
    }

    public static function find(int $id, bool $orFail = false): ?array
    {
        [$scopeSql, $params] = Scope::current()->condition('p.client_id', 'p.id');
        $params['id'] = $id;

        $row = Database::one(
            "SELECT p.*, c.name AS client_name, c.color AS client_color, c.rate AS client_rate, c.currency AS currency
               FROM projects p JOIN clients c ON c.id = p.client_id
              WHERE p.id = :id AND p.deleted_at IS NULL AND c.deleted_at IS NULL AND $scopeSql",
            $params
        );
        if ($row === null && $orFail) {
            throw HttpException::notFound('Projekt nicht gefunden.');
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
        $clientId = (int) $data['client_id'];
        ClientRepo::findOrFail($clientId);
        self::assertNameFree($clientId, (string) $data['name']);

        $now = Clock::now();
        return Database::insert('projects', [
            'client_id'    => $clientId,
            'name'         => $data['name'],
            'color'        => $data['color'] ?? null,
            'rate'         => $data['rate'] ?? null,
            'note'         => $data['note'] ?? '',
            'archived'     => !empty($data['archived']) ? 1 : 0,
            'sort'         => (int) ($data['sort'] ?? 0),
            'created_at'   => $now,
            'updated_at'   => $now,
        ]);
    }

    /** @param array<string,mixed> $data */
    public static function update(int $id, array $data): array
    {
        $project = self::findOrFail($id);
        $clientId = isset($data['client_id']) ? (int) $data['client_id'] : $project['client_id'];

        if ($clientId !== $project['client_id']) {
            ClientRepo::findOrFail($clientId);
        }
        $name = $data['name'] ?? $project['name'];
        if ($name !== $project['name'] || $clientId !== $project['client_id']) {
            self::assertNameFree($clientId, (string) $name, $id);
        }

        $fields = array_intersect_key($data, array_flip([
            'client_id', 'name', 'color', 'rate', 'note', 'archived', 'sort',
        ]));
        if (isset($fields['archived'])) {
            $fields['archived'] = $fields['archived'] ? 1 : 0;
        }
        $fields['updated_at'] = Clock::now();

        Database::update('projects', $id, $fields);
        return self::findOrFail($id);
    }

    public static function delete(int $id): void
    {
        self::findOrFail($id);

        $subprojects = (int) Database::value(
            'SELECT COUNT(*) FROM subprojects WHERE project_id = :id AND deleted_at IS NULL',
            ['id' => $id]
        );
        if ($subprojects > 0) {
            throw HttpException::conflict(
                "Projekt hat noch $subprojects Teilprojekt(e). Bitte zuerst löschen oder das Projekt archivieren.",
                ['subprojects' => $subprojects]
            );
        }

        Database::update('projects', $id, ['deleted_at' => Clock::now(), 'updated_at' => Clock::now()]);
    }

    private static function assertNameFree(int $clientId, string $name, ?int $exceptId = null): void
    {
        $params = ['client_id' => $clientId, 'name' => $name];
        $sql = 'SELECT id FROM projects WHERE client_id = :client_id AND name = :name AND deleted_at IS NULL';
        if ($exceptId !== null) {
            $sql .= ' AND id != :id';
            $params['id'] = $exceptId;
        }
        if (Database::one($sql, $params) !== null) {
            throw HttpException::conflict("Dieser Kunde hat bereits ein Projekt „$name\".");
        }
    }

    /** @param array<string,mixed> $row */
    public static function hydrate(array $row): array
    {
        $showCosts = Scope::current()->showCosts;
        $effective = $row['rate'] ?? $row['client_rate'] ?? null;

        $out = [
            'id'             => (int) $row['id'],
            'client_id'      => (int) $row['client_id'],
            'client_name'    => $row['client_name'] ?? null,
            'name'           => (string) $row['name'],
            'color'          => $row['color'] ?? $row['client_color'] ?? null,
            'own_color'      => $row['color'],
            'currency'       => (string) ($row['currency'] ?? 'EUR'),
            'note'           => (string) $row['note'],
            'archived'       => (bool) $row['archived'],
            'sort'           => (int) $row['sort'],
            'created_at'     => Clock::iso((int) $row['created_at']),
            'updated_at'     => Clock::iso((int) $row['updated_at']),
        ];

        if ($showCosts) {
            $out['rate'] = $row['rate'] === null ? null : (float) $row['rate'];
            $out['effective_rate'] = $effective === null ? Rates::default() : round((float) $effective, 2);
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
