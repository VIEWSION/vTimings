<?php
declare(strict_types=1);

namespace VT\Repo;

use VT\Db\Database;
use VT\Domain\Rates;
use VT\Http\HttpException;
use VT\Support\Clock;

final class SubprojectRepo
{
    private const SELECT = 's.*,
        p.name AS project_name, p.color AS project_color, p.rate AS project_rate, p.client_id AS client_id,
        c.name AS client_name, c.color AS client_color, c.rate AS client_rate, c.currency AS currency';

    private const JOIN = 'FROM subprojects s
        JOIN projects p ON p.id = s.project_id
        JOIN clients  c ON c.id = p.client_id';

    /**
     * @param array{project_id?:int|null, client_id?:int|null, archived?:bool|null, stats?:bool, q?:string} $opts
     * @return list<array<string,mixed>>
     */
    public static function list(array $opts = []): array
    {
        $scope = Scope::current();
        [$scopeSql, $params] = $scope->condition('p.client_id', 'p.id');

        $where = ['s.deleted_at IS NULL', 'p.deleted_at IS NULL', 'c.deleted_at IS NULL', $scopeSql];

        if (!empty($opts['project_id'])) {
            $where[] = 's.project_id = :project_id';
            $params['project_id'] = (int) $opts['project_id'];
        }
        if (!empty($opts['client_id'])) {
            $where[] = 'p.client_id = :client_id';
            $params['client_id'] = (int) $opts['client_id'];
        }
        if (array_key_exists('archived', $opts) && $opts['archived'] !== null) {
            $where[] = 's.archived = :archived';
            $params['archived'] = $opts['archived'] ? 1 : 0;
        }
        if (!empty($opts['q'])) {
            $where[] = '(s.name LIKE :q OR p.name LIKE :q OR c.name LIKE :q)';
            $params['q'] = '%' . $opts['q'] . '%';
        }

        $select = self::SELECT;
        $join = '';
        if ($opts['stats'] ?? true) {
            $select .= ', COALESCE(st.minutes, 0) AS total_minutes,
                         COALESCE(st.amount, 0)  AS total_amount,
                         COALESCE(st.entries, 0) AS entry_count,
                         st.last_at';
            $join = 'LEFT JOIN (
                        SELECT e.subproject_id     AS subproject_id,
                               SUM(e.duration_min) AS minutes,
                               SUM(e.amount)       AS amount,
                               COUNT(*)            AS entries,
                               MAX(e.started_at)   AS last_at
                          FROM entries e
                         WHERE e.deleted_at IS NULL
                         GROUP BY e.subproject_id
                     ) st ON st.subproject_id = s.id';
        }

        $rows = Database::all(
            'SELECT ' . $select . ' ' . self::JOIN . ' ' . $join .
            ' WHERE ' . implode(' AND ', $where) .
            ' ORDER BY c.name COLLATE NOCASE, p.name COLLATE NOCASE, s.archived, s.sort, s.name COLLATE NOCASE',
            $params
        );

        return array_map([self::class, 'hydrate'], $rows);
    }

    public static function find(int $id, bool $orFail = false): ?array
    {
        [$scopeSql, $params] = Scope::current()->condition('p.client_id', 'p.id');
        $params['id'] = $id;

        $row = Database::one(
            'SELECT ' . self::SELECT . ' ' . self::JOIN .
            " WHERE s.id = :id AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND c.deleted_at IS NULL AND $scopeSql",
            $params
        );
        if ($row === null && $orFail) {
            throw HttpException::notFound('Teilprojekt nicht gefunden.');
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
        $projectId = (int) $data['project_id'];
        ProjectRepo::findOrFail($projectId);
        self::assertNameFree($projectId, (string) $data['name']);

        $now = Clock::now();
        return Database::insert('subprojects', [
            'project_id' => $projectId,
            'name'       => $data['name'],
            'rate'       => $data['rate'] ?? null,
            'note'       => $data['note'] ?? '',
            'archived'   => !empty($data['archived']) ? 1 : 0,
            'sort'       => (int) ($data['sort'] ?? 0),
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /** @param array<string,mixed> $data */
    public static function update(int $id, array $data): array
    {
        $sub = self::findOrFail($id);
        $projectId = isset($data['project_id']) ? (int) $data['project_id'] : $sub['project_id'];

        if ($projectId !== $sub['project_id']) {
            ProjectRepo::findOrFail($projectId);
        }
        $name = $data['name'] ?? $sub['name'];
        if ($name !== $sub['name'] || $projectId !== $sub['project_id']) {
            self::assertNameFree($projectId, (string) $name, $id);
        }

        $fields = array_intersect_key($data, array_flip([
            'project_id', 'name', 'rate', 'note', 'archived', 'sort',
        ]));
        if (isset($fields['archived'])) {
            $fields['archived'] = $fields['archived'] ? 1 : 0;
        }
        $fields['updated_at'] = Clock::now();

        Database::update('subprojects', $id, $fields);
        return self::findOrFail($id);
    }

    /**
     * Soft-Delete. Einträge blockieren das Löschen – sie hängen direkt daran
     * und würden sonst ihre Zuordnung verlieren.
     */
    public static function delete(int $id): void
    {
        self::findOrFail($id);

        $entries = (int) Database::value(
            'SELECT COUNT(*) FROM entries WHERE subproject_id = :id AND deleted_at IS NULL',
            ['id' => $id]
        );
        if ($entries > 0) {
            throw HttpException::conflict(
                "Teilprojekt hat noch $entries Zeiteintrag/-einträge. Bitte archivieren statt löschen.",
                ['entries' => $entries]
            );
        }
        if ((int) Database::value('SELECT COUNT(*) FROM timers WHERE subproject_id = :id', ['id' => $id]) > 0) {
            throw HttpException::conflict('Auf diesem Teilprojekt läuft gerade ein Timer.');
        }

        Database::update('subprojects', $id, ['deleted_at' => Clock::now(), 'updated_at' => Clock::now()]);
    }

    private static function assertNameFree(int $projectId, string $name, ?int $exceptId = null): void
    {
        $params = ['project_id' => $projectId, 'name' => $name];
        $sql = 'SELECT id FROM subprojects WHERE project_id = :project_id AND name = :name AND deleted_at IS NULL';
        if ($exceptId !== null) {
            $sql .= ' AND id != :id';
            $params['id'] = $exceptId;
        }
        if (Database::one($sql, $params) !== null) {
            throw HttpException::conflict("Dieses Projekt hat bereits ein Teilprojekt „$name\".");
        }
    }

    /** @param array<string,mixed> $row */
    public static function hydrate(array $row): array
    {
        $showCosts = Scope::current()->showCosts;
        $effective = $row['rate'] ?? $row['project_rate'] ?? $row['client_rate'] ?? null;

        $out = [
            'id'             => (int) $row['id'],
            'project_id'     => (int) $row['project_id'],
            'project_name'   => $row['project_name'] ?? null,
            'client_id'      => isset($row['client_id']) ? (int) $row['client_id'] : null,
            'client_name'    => $row['client_name'] ?? null,
            'name'           => (string) $row['name'],
            'color'          => $row['project_color'] ?? $row['client_color'] ?? null,
            'currency'       => (string) ($row['currency'] ?? 'EUR'),
            'note'           => (string) $row['note'],
            'archived'       => (bool) $row['archived'],
            'sort'           => (int) $row['sort'],
            'path'           => trim(sprintf('%s | %s | %s', $row['client_name'] ?? '', $row['project_name'] ?? '', $row['name']), ' |'),
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
