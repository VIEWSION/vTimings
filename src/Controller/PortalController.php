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

        $from = $req->query['from'] ?? null;
        $to = $req->query['to'] ?? null;
        $filters = array_filter([
            'client_id' => $clientId,
            'from'      => $from,
            'to'        => $to,
        ], static fn($v) => $v !== null && $v !== '');

        // Projekte mit Fortschritt – Gesamtstand, unabhängig vom Zeitraum,
        // sonst wäre ein Budgetbalken je nach Filter unterschiedlich voll.
        $projects = ProjectRepo::list(['client_id' => $clientId, 'archived' => false]);

        $recent = EntryRepo::list($filters + ['limit' => 25, 'order' => 'desc']);
        $byMonth = EntryRepo::grouped($filters, 'month');
        $byProject = EntryRepo::grouped($filters, 'project');

        $lifetime = EntryRepo::list(['client_id' => $clientId, 'limit' => 1]);

        return [
            'client'   => [
                'id'       => $client['id'],
                'name'     => $client['name'],
                'color'    => $client['color'],
                'currency' => $client['currency'],
                'lang'     => $client['lang'],
            ],
            'projects' => array_map(static fn(array $project) => [
                'id'           => $project['id'],
                'name'         => $project['name'],
                'color'        => $project['color'],
                'archived'     => $project['archived'],
                'budget_hours' => $project['budget_hours'],
                'progress'     => $project['progress'] ?? null,
                'stats'        => $project['stats'] ?? null,
            ], $projects),
            'period'   => [
                'from'   => $from,
                'to'     => $to,
                'totals' => $recent['totals'],
            ],
            'lifetime' => $lifetime['totals'],
            'by_month' => $byMonth,
            'by_project' => $byProject,
            'entries'  => $recent['entries'],
            'entries_total' => $recent['total'],
            'can_see_costs' => $scope->showCosts,
            'generated_at'  => Clock::iso(Clock::now()),
        ];
    }
}
