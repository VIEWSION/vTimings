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
 * - Offene Pakete: Verbrauch wird nicht gespeichert, sondern beim Abruf
 *   verrechnet – die abrechenbaren Zeiteinträge in zeitlicher Reihenfolge,
 *   ältestes Paket zuerst. Nachträgliche Korrekturen stimmen damit sofort.
 * - Abgerechnete Pakete (billed_at) zählen fest mit genau den Einträgen, die
 *   budget_id auf sie setzen. Was sie dabei weniger oder mehr als ihre
 *   Stunden aufgenommen haben, geht als Übertrag in die Verrechnung der
 *   offenen Pakete ein. So ändert ein nachgetragener alter Eintrag nichts
 *   mehr an bereits abgerechneten Paketen.
 * - Gezählt wird ab dem Beginn des ersten Pakets.
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
        return self::$cache[(string) $clientId] ??= array_map(
            static fn(array $state) => self::present($state),
            self::states($clientId)
        );
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

        // Abgerechnet: Stunden, Zeitraum und Zuordnung stehen fest. Preis
        // und Notiz sind reine Information und bleiben änderbar.
        if ($budget['billed_at'] !== null) {
            $fixed = [
                'hours'      => (float) $budget['hours'],
                'starts_on'  => Clock::day((int) $budget['starts_at']),
                'expires_on' => $budget['expires_at'] === null ? null : self::expiresOn((int) $budget['expires_at']),
                'client_id'  => (int) $budget['client_id'],
                'project_id' => $budget['project_id'] === null ? null : (int) $budget['project_id'],
            ];
            foreach ($fixed as $field => $value) {
                if (array_key_exists($field, $data) && $data[$field] != $value) {
                    throw HttpException::conflict(
                        'Das Paket ist abgerechnet. Stunden, Zeitraum und Zuordnung lassen sich erst nach „Abrechnung aufheben“ ändern.'
                    );
                }
                unset($data[$field]);
            }
        }

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
        $budget = self::find($id, true);
        if ($budget['billed_at'] !== null) {
            throw HttpException::conflict('Das Paket ist abgerechnet. Bitte zuerst die Abrechnung aufheben.');
        }
        self::$cache = [];
        Database::update('budgets', $id, ['deleted_at' => Clock::now(), 'updated_at' => Clock::now()]);
    }

    // -- Abrechnen ----------------------------------------------------------

    /**
     * Alle aufgebrauchten (oder abgelaufenen) Pakete eines Kontingents der
     * Reihe nach abrechnen: ihre Einträge werden "abgerechnet" und tragen das
     * Paket in budget_id.
     *
     * Fällt ein Eintrag über eine Paketgrenze, wird er mit $split an der
     * Grenze geteilt (Zeiten bleiben lückenlos, Notiz und Satz wandern mit).
     * Ohne $split gehört er ganz zu dem Paket, in dem er vollständig
     * bezahlt ist – der Unterschied geht als Übertrag weiter.
     *
     * Mit $dryRun wird nichts geschrieben, die Rückgabe ist die Vorschau.
     *
     * @return array{packages:list<array<string,mixed>>, entries:int, splits:int, attached:int, minutes:int}
     */
    public static function bill(int $clientId, ?int $projectId, bool $split, bool $dryRun): array
    {
        $state = self::stateFor($clientId, $projectId);
        $plan = self::plan($state, $split);

        $summary = [
            'packages' => [],
            'entries'  => 0,
            'splits'   => 0,
            'attached' => 0,
            'minutes'  => 0,
        ];
        foreach ($plan['packages'] as $index) {
            $package = $state['packages'][$index];
            $summary['packages'][$index] = [
                'id'        => (int) $package['row']['id'],
                'hours'     => (float) $package['row']['hours'],
                'starts_on' => Clock::day((int) $package['row']['starts_at']),
                'note'      => (string) $package['row']['note'],
                'entries'   => 0,
                'minutes'   => 0,
            ];
        }
        foreach ($plan['actions'] as $action) {
            if ($action['split']) {
                $summary['splits']++;
            }
            if ($action['attach']) {
                $summary['attached']++;
            }
            foreach ($action['parts'] as [$target, $minutes]) {
                if ($target === null) {
                    continue;
                }
                $summary['packages'][$target]['entries']++;
                $summary['packages'][$target]['minutes'] += $minutes;
                $summary['entries']++;
                $summary['minutes'] += $minutes;
            }
        }
        $summary['packages'] = array_values($summary['packages']);

        if ($dryRun || $plan['packages'] === []) {
            return $summary;
        }

        Database::transaction(static function () use ($state, $plan): void {
            $now = Clock::now();
            $idOf = static fn(int $index): int => (int) $state['packages'][$index]['row']['id'];

            foreach ($plan['actions'] as $action) {
                $ids = $action['split']
                    ? EntryRepo::split($action['entry_id'], array_column($action['parts'], 1))
                    : [$action['entry_id']];

                foreach ($action['parts'] as $i => [$target]) {
                    if ($target === null) {
                        continue;
                    }
                    EntryRepo::update($ids[$i], $action['attach']
                        ? ['budget_id' => $idOf($target)]
                        : ['billed' => true, 'budget_id' => $idOf($target), 'billed_at' => $now]);
                }
            }
            foreach ($plan['packages'] as $index) {
                Database::update('budgets', $idOf($index), ['billed_at' => $now, 'updated_at' => $now]);
            }
        });
        self::$cache = [];

        return $summary;
    }

    /**
     * Abrechnung eines Pakets aufheben – nur für das zuletzt abgerechnete,
     * sonst stimmen die Überträge der späteren nicht mehr. Einträge, die
     * erst mit dem Paket abgerechnet wurden, werden wieder offen; waren sie
     * schon vorher abgerechnet, verlieren sie nur die Zuordnung. Geteilte
     * Einträge bleiben geteilt.
     */
    public static function unbill(int $id): int
    {
        $budget = self::find($id, true);
        if ($budget['billed_at'] === null) {
            throw HttpException::conflict('Das Paket ist nicht abgerechnet.');
        }

        $later = Database::one(
            'SELECT id FROM budgets
              WHERE client_id = :client_id AND project_id IS :project_id AND deleted_at IS NULL
                AND billed_at IS NOT NULL AND id != :id
                AND (starts_at > :starts_at OR (starts_at = :starts_at AND id > :id))',
            [
                'client_id'  => $budget['client_id'],
                'project_id' => $budget['project_id'],
                'id'         => $id,
                'starts_at'  => $budget['starts_at'],
            ]
        );
        if ($later !== null) {
            throw HttpException::conflict('Nur das zuletzt abgerechnete Paket kann wieder geöffnet werden.');
        }

        $entries = Database::all(
            'SELECT id, billed_at FROM entries WHERE budget_id = :id AND deleted_at IS NULL',
            ['id' => $id]
        );

        Database::transaction(static function () use ($budget, $entries, $id): void {
            foreach ($entries as $entry) {
                EntryRepo::update((int) $entry['id'], (int) $entry['billed_at'] === (int) $budget['billed_at']
                    ? ['billed' => false, 'budget_id' => null]
                    : ['budget_id' => null]);
            }
            Database::update('budgets', $id, ['billed_at' => null, 'updated_at' => Clock::now()]);
        });
        self::$cache = [];

        return count($entries);
    }

    // -- Deckung durch Pakete -------------------------------------------------

    /** Wurde die Hilfstabelle in dieser Anfrage schon gefüllt? */
    private static bool $coverReady = false;

    /**
     * Füllt `temp.entry_cover` (Eintrag → Minuten, die kein Paket abdeckt) für
     * alle Einträge, die in einem Kontingent verrechnet werden. Einträge ohne
     * Zeile gehören zu keinem Kontingent (oder liegen vor dem ersten Paket) –
     * für sie gilt ihre volle Dauer als nicht gedeckt, siehe EntryRepo.
     *
     * Die Tabelle ist je Verbindung temporär; so rechnen Summen, Gruppen und
     * der Filter „nicht gedeckt“ in SQL exakt über denselben Stand wie die
     * Kontingentansicht, ohne die Verrechnung zu duplizieren.
     */
    public static function prepareCover(): void
    {
        if (self::$coverReady) {
            return;
        }
        Database::run('CREATE TEMP TABLE IF NOT EXISTS entry_cover (
            entry_id INTEGER PRIMARY KEY, uncovered_min INTEGER NOT NULL) WITHOUT ROWID');
        Database::run('DELETE FROM temp.entry_cover');

        Database::transaction(static function (): void {
            foreach (self::states(null) as $state) {
                foreach ($state['allocation'] as $entry) {
                    $over = 0;
                    foreach ($entry['parts'] as [$target, $minutes]) {
                        if ($target === 'over') {
                            $over += $minutes;
                        }
                    }
                    Database::run(
                        'INSERT OR REPLACE INTO temp.entry_cover (entry_id, uncovered_min) VALUES (:id, :m)',
                        ['id' => $entry['id'], 'm' => $over]
                    );
                }
            }
        });
        self::$coverReady = true;
    }

    // -- Verrechnung --------------------------------------------------------

    /** @return list<array<string,mixed>> Rechenstand je Kontingent */
    private static function states(?int $clientId): array
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
        if ($rows === []) {
            return [];
        }

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

        // Verbrauch abgerechneter Pakete: die Einträge, die auf sie zeigen.
        $billedUse = [];
        foreach (Database::all(
            'SELECT budget_id, SUM(duration_min) AS minutes FROM entries
              WHERE budget_id IS NOT NULL AND deleted_at IS NULL GROUP BY budget_id'
        ) as $row) {
            $billedUse[(int) $row['budget_id']] = (int) $row['minutes'];
        }

        $out = [];
        foreach ($groups as $packages) {
            $first = $packages[0];
            $cid = (int) $first['client_id'];
            $pid = $first['project_id'] === null ? null : (int) $first['project_id'];
            $out[] = self::compute($cid, $pid, $first['project_name'] ?? null, $packages, $ownPools[$cid] ?? [], $billedUse);
        }
        return $out;
    }

    private static function stateFor(int $clientId, ?int $projectId): array
    {
        foreach (self::states($clientId) as $state) {
            if ($state['project_id'] === $projectId) {
                return $state;
            }
        }
        throw HttpException::notFound('Kontingent nicht gefunden.');
    }

    /**
     * Verrechnet die offenen Einträge auf die offenen Pakete.
     *
     * Jeder Eintrag bekommt seine Anteile als Liste [Ziel, Minuten]. Ziel ist
     * der Index eines Pakets, 'carry' (Guthaben aus abgerechneten Paketen)
     * oder 'over' (Überziehung).
     *
     * @param list<array<string,mixed>> $rows          Pakete, nach Beginn sortiert
     * @param list<int>                 $excludeProjects Projekte mit eigenem Kontingent
     * @param array<int,int>            $billedUse     Minuten je abgerechnetem Paket
     */
    private static function compute(int $clientId, ?int $projectId, ?string $projectName, array $rows, array $excludeProjects, array $billedUse): array
    {
        $now = Clock::now();
        $from = (int) $rows[0]['starts_at'];

        $packages = [];
        $carry = 0;
        foreach ($rows as $row) {
            $capacity = (int) round((float) $row['hours'] * 60);
            $package = [
                'row'      => $row,
                'capacity' => $capacity,
                'used'     => 0,
                'billed'   => $row['billed_at'] !== null,
                'carry'    => 0,
                'lapsed'   => 0,
                'first_at' => null,
                'last_at'  => null,
            ];
            if ($package['billed']) {
                $package['used'] = $billedUse[(int) $row['id']] ?? 0;
                $rest = $capacity - $package['used'];
                // Mit Ablauf abgerechnet: der Rest ist verfallen, kein Übertrag.
                $expiredAtBilling = $row['expires_at'] !== null && (int) $row['billed_at'] >= (int) $row['expires_at'];
                if ($rest > 0 && $expiredAtBilling) {
                    $package['lapsed'] = $rest;
                } else {
                    $package['carry'] = $rest;
                    $carry += $rest;
                }
            }
            $packages[] = $package;
        }

        // Fehlt aus abgerechneten Paketen etwas, zahlen es die offenen zuerst.
        $debt = max(0, -$carry);
        foreach ($packages as &$package) {
            if ($debt <= 0) {
                break;
            }
            if ($package['billed']) {
                continue;
            }
            $take = min($debt, $package['capacity'] - $package['used']);
            $package['used'] += $take;
            $debt -= $take;
        }
        unset($package);

        $credit = max(0, $carry);
        $overdraft = $debt;
        $overdraftSince = null;
        $allocation = [];

        foreach (self::entries($clientId, $projectId, $from, $excludeProjects) as $entry) {
            $need = (int) $entry['duration_min'];
            $at = (int) $entry['started_at'];
            $parts = [];

            if ($credit > 0 && $need > 0) {
                $take = min($need, $credit);
                $credit -= $take;
                $need -= $take;
                $parts[] = ['carry', $take];
            }

            foreach ($packages as $index => &$package) {
                if ($need <= 0) {
                    break;
                }
                if ($package['billed']) {
                    continue;
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
                $parts[] = [$index, $take];
            }
            unset($package);

            if ($need > 0) {
                $overdraft += $need;
                $overdraftSince ??= $at;
                $parts[] = ['over', $need];
            }

            $allocation[] = [
                'id'       => (int) $entry['id'],
                'minutes'  => (int) $entry['duration_min'],
                'prebilled' => $entry['billed_at'] !== null,
                'parts'    => $parts,
            ];
        }

        foreach ($packages as &$package) {
            $rest = $package['capacity'] - $package['used'];
            $expired = $package['row']['expires_at'] !== null && $now >= (int) $package['row']['expires_at'];
            $package['rest'] = $package['billed'] ? 0 : max(0, $rest);
            $package['expired'] = $expired;
        }
        unset($package);

        return [
            'client_id'       => $clientId,
            'project_id'      => $projectId,
            'project_name'    => $projectName,
            'from'            => $from,
            'packages'        => $packages,
            'allocation'      => $allocation,
            'credit'          => $credit,
            'overdraft'       => $overdraft,
            'overdraft_since' => $overdraftSince,
        ];
    }

    /**
     * Welche Pakete jetzt abgerechnet werden können und was mit den
     * Einträgen dafür geschieht. Abgerechnet wird der Reihe nach: das erste
     * offene Paket, das weder voll noch abgelaufen ist, beendet die Folge.
     *
     * @return array{packages:list<int>, actions:list<array{entry_id:int, split:bool, attach:bool, parts:list<array{0:int|null,1:int}>}>}
     */
    private static function plan(array $state, bool $split): array
    {
        $closing = [];
        foreach ($state['packages'] as $index => $package) {
            if ($package['billed']) {
                continue;
            }
            if ($package['rest'] > 0 && !$package['expired']) {
                break;
            }
            $closing[$index] = true;
        }

        $actions = [];
        foreach ($state['allocation'] as $entry) {
            // Anteile zusammenfassen: das Guthaben gehört zum folgenden
            // Paket, alles außerhalb der abzurechnenden Pakete bleibt offen.
            $parts = [];
            $carried = 0;
            foreach ($entry['parts'] as [$target, $minutes]) {
                if ($target === 'carry') {
                    $carried += $minutes;
                    continue;
                }
                $target = is_int($target) && isset($closing[$target]) ? $target : null;
                $minutes += $carried;
                $carried = 0;
                $last = array_key_last($parts);
                if ($last !== null && $parts[$last][0] === $target) {
                    $parts[$last][1] += $minutes;
                } else {
                    $parts[] = [$target, $minutes];
                }
            }
            if ($carried > 0) {
                // Ganz aus dem Guthaben bezahlt, aber kein Paket dahinter –
                // gehört zum ersten offenen Paket, sobald es abgerechnet wird.
                continue;
            }
            if ($parts === [] || ($parts[0][0] === null && count($parts) === 1)) {
                continue;
            }

            // Abgerechnete Einträge lassen sich nicht teilen: sie gehören wie
            // ohne Teilen ganz zu dem Paket, in dem sie vollständig bezahlt sind.
            if (count($parts) > 1 && (!$split || $entry['prebilled'])) {
                $target = $parts[array_key_last($parts)][0];
                if ($target === null) {
                    continue;
                }
                $parts = [[$target, $entry['minutes']]];
            }

            $actions[] = [
                'entry_id' => $entry['id'],
                'split'    => count($parts) > 1,
                'attach'   => $entry['prebilled'],
                'parts'    => $parts,
            ];
        }

        return ['packages' => array_keys($closing), 'actions' => $actions];
    }

    /** Rechenstand → API-Antwort. */
    private static function present(array $state): array
    {
        $showCosts = Scope::current()->showCosts;
        $isAdmin = Scope::current()->isUnrestricted();
        $packages = $state['packages'];

        $out = [];
        $activeIndex = null;
        $purchased = 0;
        $used = 0;
        $open = $state['credit'];
        $closable = 0;
        $closing = true;

        foreach ($packages as $index => $package) {
            $row = $package['row'];
            $rest = $package['capacity'] - $package['used'];

            if ($package['billed']) {
                $status = 'billed';
            } elseif ($rest <= 0) {
                $status = 'used';
            } elseif ($package['expired']) {
                $status = 'expired';
            } elseif ($activeIndex === null) {
                $status = 'active';
                $activeIndex = $index;
            } else {
                $status = 'open';
            }

            // Abrechenbar ist, was voll oder abgelaufen ist – der Reihe nach.
            $billable = false;
            if (!$package['billed']) {
                $billable = $closing && ($status === 'used' || $status === 'expired');
                $closing = $billable;
                if ($billable) {
                    $closable++;
                }
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
                'can_bill'        => $billable,
                'billed_on'       => $row['billed_at'] === null ? null : Clock::day((int) $row['billed_at']),
                'used_hours'      => self::hours($package['used']),
                'remaining_hours' => $status === 'active' || $status === 'open' ? self::hours(max(0, $rest)) : 0.0,
                'expired_hours'   => self::hours($status === 'expired' ? $rest : $package['lapsed']),
                // Abgerechnet: >0 = ins nächste Paket übertragen, <0 = daraus vorgezogen.
                'carry_hours'     => self::hours($package['carry']),
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
        $overdraft = $state['overdraft'];
        $currentUsed = $currentPackage['used'] + ($activeIndex === null ? $overdraft : 0);
        $currentRest = $activeIndex === null ? -$overdraft : $currentPackage['capacity'] - $currentPackage['used'];

        return [
            'key'             => self::key($state['client_id'], $state['project_id']),
            'client_id'       => $state['client_id'],
            'project_id'      => $state['project_id'],
            'project_name'    => $state['project_name'],
            'since'           => Clock::day($state['from']),
            'packages'        => $out,
            'current_id'      => (int) $currentPackage['row']['id'],
            'can_bill_count'  => $closable,
            'purchased_hours' => self::hours($purchased),
            'used_hours'      => self::hours($used + $overdraft),
            'overdraft_hours' => self::hours($overdraft),
            'overdraft_since' => $state['overdraft_since'] === null ? null : Clock::day($state['overdraft_since']),
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
     * Abrechenbare Zeiteinträge eines Kontingents in Buchungsreihenfolge,
     * ohne die bereits über ein Paket abgerechneten.
     *
     * @param list<int> $excludeProjects
     * @return list<array{id:int,started_at:int,duration_min:int,billed_at:int|null}>
     */
    private static function entries(int $clientId, ?int $projectId, int $from, array $excludeProjects): array
    {
        $params = ['from' => $from];
        $where = [
            'e.deleted_at IS NULL',
            'e.billable = 1',
            "e.type = 'time'",
            'e.budget_id IS NULL',
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
            'SELECT e.id, e.started_at, e.duration_min, e.billed_at
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
