<?php
declare(strict_types=1);

namespace VT\Controller;

use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Response;
use VT\Http\Router;
use VT\Repo\BudgetRepo;
use VT\Support\Validator;

/**
 * Stundenkontingente: Pakete anlegen, ändern, löschen und den Stand je
 * Kontingent abrufen. Die Verrechnung steckt in BudgetRepo.
 */
final class BudgetController
{
    public static function register(Router $r): void
    {
        $r->get('/api/budgets', [self::class, 'list'], ['auth' => 'user']);
        $r->post('/api/budgets', [self::class, 'create']);
        $r->patch('/api/budgets/{id}', [self::class, 'update']);
        $r->delete('/api/budgets/{id}', [self::class, 'delete']);

        $r->post('/api/budgets/bill', [self::class, 'bill']);
        $r->delete('/api/budgets/{id}/bill', [self::class, 'unbill']);
    }

    /** ?client_id= grenzt auf einen Kunden ein, ?project_id= auf ein Kontingent. */
    public static function list(Request $req): array
    {
        $clientId = isset($req->query['client_id']) ? (int) $req->query['client_id'] : null;
        $pools = BudgetRepo::pools($clientId);

        if (isset($req->query['project_id'])) {
            $projectId = (int) $req->query['project_id'];
            $pools = array_values(array_filter($pools, static fn($p) => $p['project_id'] === $projectId));
        }
        return ['budgets' => $pools];
    }

    public static function create(Request $req): Response
    {
        $id = BudgetRepo::create(self::payload($req, true));
        return Response::json(['id' => $id, 'budgets' => BudgetRepo::pools()], 201);
    }

    public static function update(Request $req): array
    {
        BudgetRepo::update(self::id($req), self::payload($req, false));
        return ['budgets' => BudgetRepo::pools()];
    }

    public static function delete(Request $req): Response
    {
        BudgetRepo::delete(self::id($req));
        return Response::json(['ok' => true]);
    }

    /**
     * Aufgebrauchte Pakete eines Kontingents abrechnen.
     * { client_id, project_id?, split = true, dry_run = false }
     */
    public static function bill(Request $req): array
    {
        $v = new Validator($req->body);
        $clientId = $v->int('client_id', true, 1);
        $raw = $req->body['project_id'] ?? null;
        $projectId = ($raw === null || $raw === '') ? null : $v->int('project_id', true, 1);
        $split = $v->bool('split', true);
        $dryRun = $v->bool('dry_run', false);
        $v->validate();

        $result = BudgetRepo::bill((int) $clientId, $projectId, (bool) $split, (bool) $dryRun);
        return ['result' => $result, 'dry_run' => (bool) $dryRun];
    }

    /** Abrechnung des zuletzt abgerechneten Pakets aufheben. */
    public static function unbill(Request $req): array
    {
        return ['reopened' => BudgetRepo::unbill(self::id($req))];
    }

    private static function payload(Request $req, bool $creating): array
    {
        $v = new Validator($req->body);
        $data = [];

        if ($creating || $v->has('client_id')) {
            $data['client_id'] = $v->int('client_id', true, 1);
        }
        if ($v->has('project_id')) {
            $empty = ($req->body['project_id'] ?? null) === null || $req->body['project_id'] === '';
            $data['project_id'] = $empty ? null : $v->int('project_id', true, 1);
        }
        if ($creating || $v->has('hours')) {
            $data['hours'] = $v->float('hours', true, 0.25, 100000);
        }
        if ($v->has('price')) {
            $empty = ($req->body['price'] ?? null) === null || $req->body['price'] === '';
            $data['price'] = $empty ? null : $v->float('price', false, 0, 10000000);
        }
        if ($creating || $v->has('starts_on')) {
            $data['starts_on'] = $v->date('starts_on', true);
        }
        if ($v->has('expires_on')) {
            $data['expires_on'] = $v->date('expires_on');
        }
        if ($v->has('note')) {
            $data['note'] = $v->string('note', false, 1000);
        }

        $v->validate();
        if (!$creating && $data === []) {
            throw HttpException::badRequest('Keine Änderungen übergeben.');
        }
        return $data;
    }

    private static function id(Request $req): int
    {
        $id = $req->param('id');
        if ($id === null || !ctype_digit($id)) {
            throw HttpException::badRequest('Ungültige ID.');
        }
        return (int) $id;
    }
}
