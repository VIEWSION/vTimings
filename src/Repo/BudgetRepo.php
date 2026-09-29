<?php
declare(strict_types=1);

namespace VT\Repo;

use VT\Db\Database;
use VT\Http\HttpException;
use VT\Support\Clock;

/**
 * Stundenkontingente (vorab gekaufte Stundenpakete).
 *
 * Ein Kontingent gilt entweder für ein Projekt oder – ohne project_id – für
 * alle Projekte eines Kunden, die kein eigenes Kontingent haben. Die Pakete
 * eines Kontingents bilden zusammen einen Topf:
 *
 * - Verbrauch wird nicht gespeichert, sondern beim Abruf verrechnet: die
 *   abrechenbaren Zeiteinträge in zeitlicher Reihenfolge, ältestes Paket
 *   zuerst. Nachträgliche Korrekturen an Einträgen stimmen damit sofort.
 * - Gezählt wird ab dem Beginn des ersten Pakets; ältere Einträge gehören
 *   nicht dazu.
 * - Was kein Paket mehr aufnimmt, ist Überziehung. Kommt ein neues Paket
 *   dazu, wird sie davon abgezogen – auch wenn es erst später beginnt.
 * - Ein Paket mit Ablaufdatum nimmt keine Stunden mehr auf, die danach
 *   gebucht wurden; Reststunden verfallen dann.
 *
 * Gerechnet wird ausschließlich in Stunden. Der Paketpreis ist nur eine
 * Information – eine Satzerhöhung nach dem Kauf ändert am Kontingent nichts.
 */
final class BudgetRepo
{
    /**
     * Ergebnis je Kundenfilter für die Dauer der Anfrage – der Stammdatenbaum
     * fragt für Kunden und Projekte getrennt an.
     *
     * @var array<string,list<array<string,mixed>>>
     */
    private static array $cache = [];

    /**
     * Alle sichtbaren Kontingente, auf Wunsch eines Kunden, mit Verbrauch.
     *
     * @return list<array<string,mixed>>
     */
    public static function pools(?int $clientId = null): array
    {
        return self::$cache[(string) $clientId] ??= self::load($clientId);
    }

    /** @return list<array<string,mixed>> */
    private static function load(?int $clientId): array
    {
        [$scopeSql, $params] = Scope::current()->condition('b.client_id', 'b.project_id');
        $where = ['b.deleted_at IS NULL', 'c.deleted_at IS NULL', $scopeSql];
        if ($clientId !== null) {
            $where[] = 'b.client_id = :client_id';
            $params['client_id'] = $clientId;
        }

        $rows = Database::all(
            'SELECT b.*, p.name AS project_name
               FROM budgets b
               JOIN clients c ON c.id = b.client_id
               LEFT JOIN projects p ON p.id = b.project_id
              WHERE ' . implode(' AND ', $where) . '
              ORDER BY b.client_id, b.project_id, b.starts_at, b.id',
            $params
        );

        $groups = [];
        foreach ($rows as $row) {
            $key = self::key((int) $row['client_id'], $row['project_id'] === null ? null : (int) $row['project_id']);
            $groups[$key][] = $row;
        }

        // Projekte mit eigenem Kontingent zählen nicht zum Kundenkontingent.
        // Bewusst ohne Scope: ein Kundenkontingent sieht ohnehin nur, wer
        // alle Projekte des Kunden sehen darf.
        $ownPools = [];
        foreach (Database::all(
            'SELECT DISTINCT client_id, project_id FROM budgets
              WHERE deleted_at IS NULL AND project_id IS NOT NULL'
        ) as $row) {
            $ownPools[(int) $row['client_id']][] = (int) $row['project_id'];
        }

        $out = [];
        foreach ($groups as $packages) {
            $first = $packages[0];
            $cid = (int) $first['client_id'];
            $pid = $first['project_id'] === null ? null : (int) $first['project_id'];
            $out[] = self::compute($cid, $pid, $first['project_name'] ?? null, $packages, $ownPools[$cid] ?? []);
        }
        return $out;
    }

    /**
     * Kontingente nach Schlüssel ("c3" bzw. "p12") für die Stammdaten.
     *
     * @return array<string,array<string,mixed>>
     */
    public static function poolsByKey(?int $clientId = null): array
    {
        $out = [];
        foreach (self::pools($clientId) as $pool) {
            $out[$pool['key']] = $pool;
        }
        return $out;
    }

    public static function key(int $clientId, ?int $projectId): string
    {
        return $projectId === null ? 'c' . $clientId : 'p' . $projectId;
    }

    public static function find(int $id, bool $orFail = false): ?array
    {
        [$scopeSql, $params] = Scope::current()->condition('b.client_id', 'b.project_id');
        $params['id'] = $id;

        $row = Database::one(
            "SELECT b.* FROM budgets b WHERE b.id = :id AND b.deleted_at IS NULL AND $scopeSql",
            $params
        );
        if ($row === null && $orFail) {
            throw HttpException::notFound('Stundenpaket nicht gefunden.');
        }
        return $row;
    }

    /** @param array<string,mixed> $data */
    public static function create(array $data): int
    {
        [$clientId, $projectId] = self::assertTarget((int) $data['client_id'], $data['project_id'] ?? null);

        self::$cache = [];
        $now = Clock::now();
        return Database::insert('budgets', [
            'client_id'  => $clientId,
            'project_id' => $projectId,
            'hours'      => $data['hours'],
            'price'      => $data['price'] ?? null,
            'starts_at'  => Clock::startOfDay($data['starts_on']),
            'expires_at' => self::expiresAt($data['expires_on'] ?? null, $data['starts_on']),
            'note'       => $data['note'] ?? '',
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /** @param array<string,mixed> $data */
    public static function update(int $id, array $data): void
    {
        $budget = self::find($id, true);

        $fields = array_intersect_key($data, array_flip(['hours', 'price', 'note']));

        if (array_key_exists('client_id', $data) || array_key_exists('project_id', $data)) {
            [$fields['client_id'], $fields['project_id']] = self::assertTarget(
                (int) ($data['client_id'] ?? $budget['client_id']),
                array_key_exists('project_id', $data) ? $data['project_id'] : $budget['project_id']
            );
        }

        $startsOn = $data['starts_on'] ?? Clock::day((int) $budget['starts_at']);
        if (isset($data['starts_on'])) {
            $fields['starts_at'] = Clock::startOfDay($data['starts_on']);
        }
        if (array_key_exists('expires_on', $data) || isset($data['starts_on'])) {
            $expiresOn = array_key_exists('expires_on', $data)
                ? $data['expires_on']
                : ($budget['expires_at'] === null ? null : self::expiresOn((int) $budget['expires_at']));
            $fields['expires_at'] = self::expiresAt($expiresOn, $startsOn);
        }

        $fields['updated_at'] = Clock::now();
        self::$cache = [];
        Database::update('budgets', $id, $fields);
    }

    public static function delete(int $id): void
    {
        self::find($id, true);
        self::$cache = [];
        Database::update('budgets', $id, ['deleted_at' => Clock::now(), 'updated_at' => Clock::now()]);
    }

    // -- Verrechnung --------------------------------------------------------

    /**
     * @param list<array<string,mixed>> $rows          Pakete, nach Beginn sortiert
     * @param list<int>                 $excludeProjects Projekte mit eigenem Kontingent
     */
    private static function compute(int $clientId, ?int $projectId, ?string $projectName, array $rows, array $excludeProjects): array
    {
        $now = Clock::now();
        $from = (int) $rows[0]['starts_at'];

        $packages = [];
        foreach ($rows as $row) {
            $packages[] = [
                'row'      => $row,
                'capacity' => (int) round((float) $row['hours'] * 60),
                'used'     => 0,
                'first_at' => null,
                'last_at'  => null,
            ];
        }

        $overdraft = 0;
        $overdraftSince = null;
        foreach (self::entries($clientId, $projectId, $from, $excludeProjects) as $entry) {
            $need = (int) $entry['duration_min'];
            $at = (int) $entry['started_at'];

            foreach ($packages as &$package) {
                if ($need <= 0) {
                    break;
                }
                $expires = $package['row']['expires_at'];
                if ($expires !== null && $at >= (int) $expires) {
                    continue;
                }
                $take = min($need, $package['capacity'] - $package['used']);
                if ($take <= 0) {
                    continue;
                }
                $package['used'] += $take;
                $package['first_at'] ??= $at;
                $package['last_at'] = $at;
                $need -= $take;
            }
            unset($package);

            if ($need > 0) {
                $overdraft += $need;
                $overdraftSince ??= $at;
            }
        }

        $showCosts = Scope::current()->showCosts;
        $isAdmin = Scope::current()->isUnrestricted();

        $out = [];
        $activeIndex = null;
        $purchased = 0;
        $used = 0;
        $open = 0;
        foreach ($packages as $index => $package) {
            $row = $package['row'];
            $rest = $package['capacity'] - $package['used'];
            $expired = $row['expires_at'] !== null && $now >= (int) $row['expires_at'];

            if ($rest <= 0) {
                $status = 'used';
            } elseif ($expired) {
                $status = 'expired';
            } elseif ($activeIndex === null) {
                $status = 'active';
                $activeIndex = $index;
            } else {
                $status = 'open';
            }

            $purchased += $package['capacity'];
            $used += $package['used'];
            if ($status === 'active' || $status === 'open') {
                $open += $rest;
            }

            $item = [
                'id'              => (int) $row['id'],
                'client_id'       => (int) $row['client_id'],
                'project_id'      => $row['project_id'] === null ? null : (int) $row['project_id'],
                'hours'           => (float) $row['hours'],
                'starts_on'       => Clock::day((int) $row['starts_at']),
                'expires_on'      => $row['expires_at'] === null ? null : self::expiresOn((int) $row['expires_at']),
                'status'          => $status,
                'used_hours'      => self::hours($package['used']),
                'remaining_hours' => $status === 'expired' ? 0.0 : self::hours(max(0, $rest)),
                'expired_hours'   => $status === 'expired' ? self::hours($rest) : 0.0,
                'percent'         => $package['capacity'] > 0 ? round($package['used'] / $package['capacity'] * 100, 1) : 100.0,
                'first_used_on'   => $package['first_at'] === null ? null : Clock::day($package['first_at']),
                'last_used_on'    => $package['last_at'] === null ? null : Clock::day($package['last_at']),
            ];
            if ($showCosts) {
                $item['price'] = $row['price'] === null ? null : (float) $row['price'];
            }
            if ($isAdmin) {
                $item['note'] = (string) $row['note'];
            }
            $out[] = $item;
        }

        // Laufendes Paket für den Fortschrittsbalken: das erste mit Rest,
        // sonst das letzte – dann mit der Überziehung obendrauf.
        $current = $activeIndex ?? array_key_last($packages);
        $currentPackage = $packages[$current];
        $currentUsed = $currentPackage['used'] + ($activeIndex === null ? $overdraft : 0);
        $currentRest = $activeIndex === null ? -$overdraft : $currentPackage['capacity'] - $currentPackage['used'];

        return [
            'key'             => self::key($clientId, $projectId),
            'client_id'       => $clientId,
            'project_id'      => $projectId,
            'project_name'    => $projectName,
            'since'           => Clock::day($from),
            'packages'        => $out,
            'current_id'      => (int) $currentPackage['row']['id'],
            'purchased_hours' => self::hours($purchased),
            'used_hours'      => self::hours($used + $overdraft),
            'overdraft_hours' => self::hours($overdraft),
            'overdraft_since' => $overdraftSince === null ? null : Clock::day($overdraftSince),
            // Guthaben über alle offenen Pakete; negativ = überzogen.
            'balance_hours'   => self::hours($open - $overdraft),
            'progress'        => [
                'budget_hours'    => (float) $currentPackage['row']['hours'],
                'used_hours'      => self::hours($currentUsed),
                'remaining_hours' => self::hours($currentRest),
                'percent'         => $currentPackage['capacity'] > 0
                    ? round($currentUsed / $currentPackage['capacity'] * 100, 1)
                    : 100.0,
            ],
        ];
    }

    /**
     * Abrechenbare Zeiteinträge eines Kontingents in Buchungsreihenfolge.
     *
     * @param list<int> $excludeProjects
     * @return list<array{started_at:int,duration_min:int}>
     */
    private static function entries(int $clientId, ?int $projectId, int $from, array $excludeProjects): array
    {
        $params = ['from' => $from];
        $where = [
            'e.deleted_at IS NULL',
            'e.billable = 1',
            "e.type = 'time'",
            'e.started_at >= :from',
        ];

        if ($projectId !== null) {
            $where[] = 's.project_id = :project_id';
            $params['project_id'] = $projectId;
        } else {
            $where[] = 'p.client_id = :client_id';
            $params['client_id'] = $clientId;
            if ($excludeProjects !== []) {
                $names = [];
                foreach (array_values($excludeProjects) as $i => $id) {
                    $names[] = ':x' . $i;
                    $params['x' . $i] = $id;
                }
                $where[] = 'p.id NOT IN (' . implode(', ', $names) . ')';
            }
        }

        return Database::all(
            'SELECT e.started_at, e.duration_min
               FROM entries e
               JOIN subprojects s ON s.id = e.subproject_id
               JOIN projects    p ON p.id = s.project_id
              WHERE ' . implode(' AND ', $where) . '
              ORDER BY e.started_at, e.id',
            $params
        );
    }

    // -- Hilfen -------------------------------------------------------------

    /** @return array{0:int,1:int|null} */
    private static function assertTarget(int $clientId, mixed $projectId): array
    {
        ClientRepo::findOrFail($clientId);
        if ($projectId === null || $projectId === '' || $projectId === 0) {
            return [$clientId, null];
        }
        $project = ProjectRepo::findOrFail((int) $projectId);
        if ($project['client_id'] !== $clientId) {
            throw HttpException::validation(['project_id' => 'Das Projekt gehört zu einem anderen Kunden.']);
        }
        return [$clientId, (int) $projectId];
    }

    /** Letzter Gültigkeitstag (inklusiv) → exklusives Ende als Timestamp. */
    private static function expiresAt(?string $expiresOn, string $startsOn): ?int
    {
        if ($expiresOn === null || $expiresOn === '') {
            return null;
        }
        if ($expiresOn < $startsOn) {
            throw HttpException::validation(['expires_on' => 'Das Ablaufdatum liegt vor dem Beginn.']);
        }
        return Clock::endOfDay($expiresOn);
    }

    private static function expiresOn(int $expiresAt): string
    {
        return Clock::day($expiresAt - 1);
    }

    private static function hours(int $minutes): float
    {
        return round($minutes / 60, 2);
    }
}
