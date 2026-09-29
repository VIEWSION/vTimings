<?php
declare(strict_types=1);

namespace VT\Controller;

use VT\Auth\Auth;
use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Router;
use VT\Repo\BudgetRepo;
use VT\Repo\ClientRepo;
use VT\Repo\EntryRepo;
use VT\Repo\ProjectRepo;
use VT\Repo\Scope;
use VT\Support\Clock;

/**
 * Kundenportal: eine einzige, gebündelte Antwort für die Übersichtsseite.
 *
 * Die Einschränkung auf den eigenen Kunden erledigt der Scope in der
 * Repository-Schicht – hier wird nichts zusätzlich gefiltert, sondern nur
 * zusammengestellt.
 *
 * Die Antwort enthält bewusst alles, was die Übersicht braucht – auch die
 * Tageswerte je Projekt. Damit kommt das Umschalten auf ein einzelnes
 * Projekt ohne weiteren Serveraufruf aus.
 */
final class PortalController
{
    /** Betrachtungszeitraum der Übersicht in Tagen. */
    private const DAYS = 100;

    /**
     * Ersatzfarben für Projekte ohne eigene Farbe.
     *
     * Projekte erben sonst die Farbe ihres Kunden – im segmentierten
     * Tagesbalken wären sie damit nicht auseinanderzuhalten.
     */
    private const PALETTE = [
        '#2f6df6', '#e2574c', '#1c8b4b', '#f2a900', '#8e44ad',
        '#00a3a3', '#d6336c', '#5a6b7d', '#7048e8', '#c2410c',
    ];

    public static function register(Router $r): void
    {
        $r->get('/api/portal', [self::class, 'overview'], ['auth' => 'user']);
    }

    public static function overview(Request $req): array
    {
        $user = Auth::require();
        $scope = Scope::current();

        $clientId = $user->isAdmin()
            ? (isset($req->query['client_id']) ? (int) $req->query['client_id'] : null)
            : $user->clientId;

        if ($clientId === null) {
            throw HttpException::badRequest('Für die Vorschau bitte einen Kunden angeben (?client_id=).');
        }

        $client = ClientRepo::find($clientId);
        if ($client === null) {
            throw HttpException::notFound('Kunde nicht gefunden.');
        }

        // Kalendertag-Grenze statt rollierender Stunden: mit dem
        // Standard-Offset von 1 wird der heutige Tag erst ab Mitternacht
        // sichtbar, damit frische/unfertige Einträge nicht sofort auftauchen
        // (Issue #3). 0 hebt die Einschränkung auf.
        $offsetDays = max(0, $client['visibility_offset_days']);
        $cutoff = Clock::local(Clock::now())->modify('-' . $offsetDays . ' days');
        $to = $cutoff->format('Y-m-d');
        $from = $cutoff->modify('-' . (self::DAYS - 1) . ' days')->format('Y-m-d');

        $filters = ['client_id' => $clientId, 'from' => $from, 'to' => $to];
        $entries = EntryRepo::allMatching($filters + ['order' => 'desc']);

        $showCosts = $scope->showCosts;

        return [
            'client'   => [
                'id'       => $client['id'],
                'name'     => $client['name'],
                'color'    => $client['color'],
                'currency' => $client['currency'],
                'lang'     => $client['lang'],
            ],
            'period'   => [
                'from' => $from,
                'to'   => $to,
                'days' => self::DAYS,
            ],
            'projects' => self::involvedProjects($clientId, $entries, $showCosts),
            'days'     => self::dailyBuckets($from, $to, $entries, $showCosts),
            'entries'  => $entries,
            // Kontingente unabhängig vom Zeitraum – ein Paket wird über
            // Monate verbraucht.
            'budgets'  => BudgetRepo::pools($clientId),
            'totals'   => self::sum($entries, $showCosts),
            'lifetime' => EntryRepo::list(['client_id' => $clientId, 'limit' => 1])['totals'],
            'can_see_costs' => $showCosts,
            'generated_at'  => Clock::iso(Clock::now()),
        ];
    }

    /**
     * Nur Projekte, auf die im Zeitraum tatsächlich gebucht wurde – sortiert
     * nach Aufwand. Die Kontingente stehen getrennt in 'budgets'.
     *
     * @param list<array<string,mixed>> $entries
     * @return list<array<string,mixed>>
     */
    private static function involvedProjects(int $clientId, array $entries, bool $showCosts): array
    {
        $aggregated = [];
        foreach ($entries as $entry) {
            $id = (int) $entry['project_id'];
            $aggregated[$id] ??= ['minutes' => 0, 'amount' => 0.0, 'entries' => 0];
            $aggregated[$id]['minutes'] += (int) $entry['duration_min'];
            $aggregated[$id]['amount']  += $entry['amount'] ?? 0;
            $aggregated[$id]['entries']++;
        }
        if ($aggregated === []) {
            return [];
        }

        $meta = [];
        foreach (ProjectRepo::list(['client_id' => $clientId, 'archived' => null]) as $project) {
            $meta[$project['id']] = $project;
        }

        $out = [];
        foreach ($aggregated as $id => $values) {
            $project = $meta[$id] ?? null;
            if ($project === null) {
                continue;
            }
            $row = [
                'id'         => $id,
                'name'       => $project['name'],
                'own_color'  => $project['own_color'] ?? null,
                'minutes'    => $values['minutes'],
                'hhmm'       => Clock::hhmm($values['minutes']),
                'decimal'    => Clock::decimal($values['minutes']),
                'entries'    => $values['entries'],
            ];
            if ($showCosts) {
                $row['amount'] = round($values['amount'], 2);
            }
            $out[] = $row;
        }

        usort($out, static fn($a, $b) => $b['minutes'] <=> $a['minutes'] ?: strcasecmp($a['name'], $b['name']));

        // Farbe festlegen, nachdem die Reihenfolge steht: eigene Farbe zuerst,
        // sonst reihum aus der Palette. Dieselbe Farbe gilt dann in Tabelle,
        // Balken und Leistungsliste.
        foreach ($out as $index => &$row) {
            $row['color'] = $row['own_color'] ?: self::PALETTE[$index % count(self::PALETTE)];
            unset($row['own_color']);
        }
        unset($row);

        return $out;
    }

    /**
     * Ein Eintrag je Kalendertag des Zeitraums – auch für Tage ohne Buchung,
     * damit der Verlauf eine echte Zeitachse ist und keine Aneinanderreihung
     * der Arbeitstage.
     *
     * @param list<array<string,mixed>> $entries
     * @return list<array{date:string,minutes:int,projects:array<int,int>}>
     */
    private static function dailyBuckets(string $from, string $to, array $entries, bool $showCosts): array
    {
        $byDate = [];
        foreach ($entries as $entry) {
            $date = (string) $entry['date'];
            $byDate[$date]['minutes'] = ($byDate[$date]['minutes'] ?? 0) + (int) $entry['duration_min'];
            $byDate[$date]['amount']  = ($byDate[$date]['amount'] ?? 0.0) + ($entry['amount'] ?? 0);

            $projectId = (int) $entry['project_id'];
            $byDate[$date]['projects'][$projectId] =
                ($byDate[$date]['projects'][$projectId] ?? 0) + (int) $entry['duration_min'];
        }

        $out = [];
        $cursor = new \DateTimeImmutable($from);
        $end = new \DateTimeImmutable($to);

        while ($cursor <= $end) {
            $date = $cursor->format('Y-m-d');
            $day = $byDate[$date] ?? null;

            $row = [
                'date'     => $date,
                'minutes'  => (int) ($day['minutes'] ?? 0),
                'hhmm'     => Clock::hhmm((int) ($day['minutes'] ?? 0)),
                // Anteile je Projekt für die farbige Segmentierung des Balkens.
                'projects' => array_map('intval', $day['projects'] ?? []),
            ];
            if ($showCosts) {
                $row['amount'] = round((float) ($day['amount'] ?? 0), 2);
            }
            $out[] = $row;
            $cursor = $cursor->modify('+1 day');
        }

        return $out;
    }

    /** @param list<array<string,mixed>> $entries */
    private static function sum(array $entries, bool $showCosts): array
    {
        $minutes = 0;
        $amount = 0.0;
        foreach ($entries as $entry) {
            $minutes += (int) $entry['duration_min'];
            $amount  += $entry['amount'] ?? 0;
        }

        $out = [
            'minutes' => $minutes,
            'hhmm'    => Clock::hhmm($minutes),
            'decimal' => Clock::decimal($minutes),
            'entries' => count($entries),
        ];
        if ($showCosts) {
            $out['amount'] = round($amount, 2);
        }
        return $out;
    }
}
