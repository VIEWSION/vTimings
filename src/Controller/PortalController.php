<?php
declare(strict_types=1);

namespace VT\Controller;

use VT\Auth\Auth;
use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Router;
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
 */
final class PortalController
{
    /** Vorgabe-Zeitraum der Übersicht in Tagen. */
    private const DEFAULT_DAYS = 100;

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

        [$from, $to, $days] = self::period($req);

        $projectId = isset($req->query['project_id']) && $req->query['project_id'] !== ''
            ? (int) $req->query['project_id']
            : null;

        $periodFilters = array_filter([
            'client_id' => $clientId,
            'from'      => $from,
            'to'        => $to,
        ], static fn($v) => $v !== null && $v !== '');

        // Die Projektauswahl grenzt Verlauf und Leistungsliste ein, nicht aber
        // die Projekttabelle selbst – sonst könnte man nicht mehr umschalten.
        $selected = $projectId === null ? $periodFilters : $periodFilters + ['project_id' => $projectId];

        $projects = ProjectRepo::list(['client_id' => $clientId, 'archived' => false]);
        $byProject = EntryRepo::grouped($periodFilters, 'project');

        // Zeitraumwerte je Projekt zum Zusammenführen mit den Stammdaten.
        $periodByProject = [];
        foreach ($byProject as $group) {
            $periodByProject[(int) $group['key']] = $group;
        }

        $recent = EntryRepo::list($selected + ['limit' => 25, 'order' => 'desc']);
        $byMonth = EntryRepo::grouped($selected, 'month');
        $periodTotals = EntryRepo::list($periodFilters + ['limit' => 1])['totals'];
        $lifetime = EntryRepo::list(['client_id' => $clientId, 'limit' => 1])['totals'];

        return [
            'client'   => [
                'id'       => $client['id'],
                'name'     => $client['name'],
                'color'    => $client['color'],
                'currency' => $client['currency'],
                'lang'     => $client['lang'],
            ],
            'projects' => array_map(static function (array $project) use ($periodByProject): array {
                return [
                    'id'           => $project['id'],
                    'name'         => $project['name'],
                    'color'        => $project['color'],
                    'archived'     => $project['archived'],
                    'budget_hours' => $project['budget_hours'],
                    // Der Fortschritt misst gegen das Budget und meint deshalb
                    // immer den Gesamtverbrauch, nie nur den Zeitraum.
                    'progress'     => $project['progress'] ?? null,
                    'stats'        => $project['stats'] ?? null,
                    'period'       => $periodByProject[$project['id']] ?? null,
                ];
            }, $projects),
            'period'   => [
                'from'    => $from,
                'to'      => $to,
                'days'    => $days,
                'totals'  => $periodTotals,
            ],
            'selected_project' => $projectId,
            'lifetime' => $lifetime,
            'by_month' => $byMonth,
            'by_project' => $byProject,
            'entries'  => $recent['entries'],
            'entries_total' => $recent['total'],
            'can_see_costs' => $scope->showCosts,
            'generated_at'  => Clock::iso(Clock::now()),
        ];
    }

    /**
     * Zeitraum der Übersicht.
     *
     * Vorgabe sind die letzten 100 Tage. `days=0` blendet die Grenzen aus,
     * ausdrückliche from/to-Angaben haben Vorrang.
     *
     * @return array{0:?string, 1:?string, 2:?int}
     */
    private static function period(Request $req): array
    {
        $from = $req->query['from'] ?? null;
        $to = $req->query['to'] ?? null;

        if (($from !== null && $from !== '') || ($to !== null && $to !== '')) {
            return [$from ?: null, $to ?: null, null];
        }

        $days = isset($req->query['days']) ? (int) $req->query['days'] : self::DEFAULT_DAYS;
        if ($days <= 0) {
            return [null, null, 0];
        }
        $days = min($days, 3650);

        // Über die Kalenderrechnung statt über Sekunden, damit die
        // Sommerzeit-Umstellung den Stichtag nicht um einen Tag verschiebt.
        $today = Clock::local(Clock::now());
        $start = $today->modify('-' . ($days - 1) . ' days');

        return [$start->format('Y-m-d'), $today->format('Y-m-d'), $days];
    }
}
