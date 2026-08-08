<?php
declare(strict_types=1);

namespace VT\Controller;

use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Response;
use VT\Http\Router;
use VT\Repo\ClientRepo;
use VT\Repo\ProjectRepo;
use VT\Repo\SubprojectRepo;
use VT\Support\Validator;

/**
 * Stammdaten: Kunden, Projekte, Teilprojekte – und der zusammengesetzte
 * Baum für die dreispaltige Oberfläche.
 */
final class MasterDataController
{
    public static function register(Router $r): void
    {
        // Lesen darf jeder Angemeldete; der Scope filtert für Kundenzugänge.
        $r->get('/api/tree', [self::class, 'tree'], ['auth' => 'user']);

        $r->get('/api/clients', [self::class, 'listClients'], ['auth' => 'user']);
        $r->get('/api/clients/{id}', [self::class, 'showClient'], ['auth' => 'user']);
        $r->post('/api/clients', [self::class, 'createClient']);
        $r->patch('/api/clients/{id}', [self::class, 'updateClient']);
        $r->delete('/api/clients/{id}', [self::class, 'deleteClient']);

        $r->get('/api/projects', [self::class, 'listProjects'], ['auth' => 'user']);
        $r->get('/api/projects/{id}', [self::class, 'showProject'], ['auth' => 'user']);
        $r->post('/api/projects', [self::class, 'createProject']);
        $r->patch('/api/projects/{id}', [self::class, 'updateProject']);
        $r->delete('/api/projects/{id}', [self::class, 'deleteProject']);

        $r->get('/api/subprojects', [self::class, 'listSubprojects'], ['auth' => 'user']);
        $r->get('/api/subprojects/{id}', [self::class, 'showSubproject'], ['auth' => 'user']);
        $r->post('/api/subprojects', [self::class, 'createSubproject']);
        $r->patch('/api/subprojects/{id}', [self::class, 'updateSubproject']);
        $r->delete('/api/subprojects/{id}', [self::class, 'deleteSubproject']);
    }

    // -- Baum ---------------------------------------------------------------

    public static function tree(Request $req): array
    {
        $archived = self::archivedFilter($req);
        $opts = ['archived' => $archived, 'stats' => true];

        $clients = ClientRepo::list($opts);
        $projects = ProjectRepo::list($opts);
        $subprojects = SubprojectRepo::list($opts);

        $subsByProject = [];
        foreach ($subprojects as $sub) {
            $subsByProject[$sub['project_id']][] = $sub;
        }
        $projectsByClient = [];
        foreach ($projects as $project) {
            $project['subprojects'] = $subsByProject[$project['id']] ?? [];
            $projectsByClient[$project['client_id']][] = $project;
        }
        foreach ($clients as &$client) {
            $client['projects'] = $projectsByClient[$client['id']] ?? [];
        }
        unset($client);

        return [
            'clients' => $clients,
            'totals'  => self::sumStats($clients),
        ];
    }

    // -- Kunden -------------------------------------------------------------

    public static function listClients(Request $req): array
    {
        return ['clients' => ClientRepo::list([
            'archived' => self::archivedFilter($req),
            'stats'    => $req->query['stats'] ?? '1' !== '0',
            'q'        => (string) ($req->query['q'] ?? ''),
        ])];
    }

    public static function showClient(Request $req): array
    {
        return ['client' => ClientRepo::findOrFail(self::id($req))];
    }

    public static function createClient(Request $req): Response
    {
        $data = self::clientPayload($req, true);
        $id = ClientRepo::create($data);
        return Response::json(['client' => ClientRepo::findOrFail($id)], 201);
    }

    public static function updateClient(Request $req): array
    {
        return ['client' => ClientRepo::update(self::id($req), self::clientPayload($req, false))];
    }

    public static function deleteClient(Request $req): Response
    {
        ClientRepo::delete(self::id($req));
        return Response::json(['ok' => true]);
    }

    // -- Projekte -----------------------------------------------------------

    public static function listProjects(Request $req): array
    {
        return ['projects' => ProjectRepo::list([
            'client_id' => isset($req->query['client_id']) ? (int) $req->query['client_id'] : null,
            'archived'  => self::archivedFilter($req),
            'q'         => (string) ($req->query['q'] ?? ''),
        ])];
    }

    public static function showProject(Request $req): array
    {
        return ['project' => ProjectRepo::findOrFail(self::id($req))];
    }

    public static function createProject(Request $req): Response
    {
        $id = ProjectRepo::create(self::projectPayload($req, true));
        return Response::json(['project' => ProjectRepo::findOrFail($id)], 201);
    }

    public static function updateProject(Request $req): array
    {
        return ['project' => ProjectRepo::update(self::id($req), self::projectPayload($req, false))];
    }

    public static function deleteProject(Request $req): Response
    {
        ProjectRepo::delete(self::id($req));
        return Response::json(['ok' => true]);
    }

    // -- Teilprojekte -------------------------------------------------------

    public static function listSubprojects(Request $req): array
    {
        return ['subprojects' => SubprojectRepo::list([
            'project_id' => isset($req->query['project_id']) ? (int) $req->query['project_id'] : null,
            'client_id'  => isset($req->query['client_id']) ? (int) $req->query['client_id'] : null,
            'archived'   => self::archivedFilter($req),
            'q'          => (string) ($req->query['q'] ?? ''),
        ])];
    }

    public static function showSubproject(Request $req): array
    {
        return ['subproject' => SubprojectRepo::findOrFail(self::id($req))];
    }

    public static function createSubproject(Request $req): Response
    {
        $id = SubprojectRepo::create(self::subprojectPayload($req, true));
        return Response::json(['subproject' => SubprojectRepo::findOrFail($id)], 201);
    }

    public static function updateSubproject(Request $req): array
    {
        return ['subproject' => SubprojectRepo::update(self::id($req), self::subprojectPayload($req, false))];
    }

    public static function deleteSubproject(Request $req): Response
    {
        SubprojectRepo::delete(self::id($req));
        return Response::json(['ok' => true]);
    }

    // -- Eingaben -----------------------------------------------------------

    private static function clientPayload(Request $req, bool $creating): array
    {
        $v = new Validator($req->body);
        $data = [];

        if ($creating || $v->has('name')) {
            $data['name'] = $v->string('name', true, 200);
        }
        foreach (['note' => 5000, 'contact_name' => 200, 'contact_address' => 1000] as $field => $max) {
            if ($v->has($field)) {
                $data[$field] = $v->string($field, false, $max);
            }
        }
        if ($v->has('contact_email')) {
            $data['contact_email'] = ($req->body['contact_email'] ?? '') === '' ? '' : $v->email('contact_email');
        }
        if ($v->has('color')) {
            $data['color'] = self::nullable($req, 'color') ? $v->color('color') : null;
        }
        if ($v->has('rate')) {
            $data['rate'] = self::nullable($req, 'rate') ? $v->float('rate', false, 0, 100000) : null;
        }
        if ($v->has('currency')) {
            $data['currency'] = strtoupper((string) $v->string('currency', true, 3));
        }
        if ($v->has('lang')) {
            $data['lang'] = $v->enum('lang', ['de', 'en'], true);
        }
        if ($v->has('archived')) {
            $data['archived'] = $v->bool('archived', false);
        }
        if ($v->has('sort')) {
            $data['sort'] = $v->int('sort', false, -9999, 9999);
        }

        $v->validate();
        self::assertNotEmpty($data, $creating);
        return $data;
    }

    private static function projectPayload(Request $req, bool $creating): array
    {
        $v = new Validator($req->body);
        $data = [];

        if ($creating || $v->has('client_id')) {
            $data['client_id'] = $v->int('client_id', true, 1);
        }
        if ($creating || $v->has('name')) {
            $data['name'] = $v->string('name', true, 200);
        }
        if ($v->has('note')) {
            $data['note'] = $v->string('note', false, 5000);
        }
        if ($v->has('color')) {
            $data['color'] = self::nullable($req, 'color') ? $v->color('color') : null;
        }
        if ($v->has('rate')) {
            $data['rate'] = self::nullable($req, 'rate') ? $v->float('rate', false, 0, 100000) : null;
        }
        if ($v->has('budget_hours')) {
            $data['budget_hours'] = self::nullable($req, 'budget_hours') ? $v->float('budget_hours', false, 0, 1000000) : null;
        }
        if ($v->has('archived')) {
            $data['archived'] = $v->bool('archived', false);
        }
        if ($v->has('sort')) {
            $data['sort'] = $v->int('sort', false, -9999, 9999);
        }

        $v->validate();
        self::assertNotEmpty($data, $creating);
        return $data;
    }

    private static function subprojectPayload(Request $req, bool $creating): array
    {
        $v = new Validator($req->body);
        $data = [];

        if ($creating || $v->has('project_id')) {
            $data['project_id'] = $v->int('project_id', true, 1);
        }
        if ($creating || $v->has('name')) {
            $data['name'] = $v->string('name', true, 200);
        }
        if ($v->has('note')) {
            $data['note'] = $v->string('note', false, 5000);
        }
        if ($v->has('rate')) {
            $data['rate'] = self::nullable($req, 'rate') ? $v->float('rate', false, 0, 100000) : null;
        }
        if ($v->has('archived')) {
            $data['archived'] = $v->bool('archived', false);
        }
        if ($v->has('sort')) {
            $data['sort'] = $v->int('sort', false, -9999, 9999);
        }

        $v->validate();
        self::assertNotEmpty($data, $creating);
        return $data;
    }

    /** Unterscheidet "Feld auf leer setzen" von "Feld mit Wert belegen". */
    private static function nullable(Request $req, string $field): bool
    {
        $value = $req->body[$field] ?? null;
        return $value !== null && $value !== '';
    }

    private static function assertNotEmpty(array $data, bool $creating): void
    {
        if (!$creating && $data === []) {
            throw HttpException::badRequest('Keine Änderungen übergeben.');
        }
    }

    private static function id(Request $req): int
    {
        $id = $req->param('id');
        if ($id === null || !ctype_digit($id)) {
            throw HttpException::badRequest('Ungültige ID.');
        }
        return (int) $id;
    }

    /** ?archived=1 nur archivierte, =0 nur aktive, fehlend = alle. */
    private static function archivedFilter(Request $req): ?bool
    {
        if (!isset($req->query['archived']) || $req->query['archived'] === '') {
            return null;
        }
        return in_array((string) $req->query['archived'], ['1', 'true', 'yes'], true);
    }

    /** @param list<array<string,mixed>> $rows */
    private static function sumStats(array $rows): array
    {
        $minutes = 0;
        $amount = 0.0;
        $entries = 0;
        foreach ($rows as $row) {
            $minutes += $row['stats']['minutes'] ?? 0;
            $amount  += $row['stats']['amount'] ?? 0;
            $entries += $row['stats']['entries'] ?? 0;
        }
        $out = [
            'minutes' => $minutes,
            'hhmm'    => \VT\Support\Clock::hhmm($minutes),
            'decimal' => \VT\Support\Clock::decimal($minutes),
            'entries' => $entries,
        ];
        if (\VT\Repo\Scope::current()->showCosts) {
            $out['amount'] = round($amount, 2);
        }
        return $out;
    }
}
