<?php
declare(strict_types=1);

namespace VT\Controller;

use VT\Auth\Auth;
use VT\Db\Database;
use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Response;
use VT\Http\Router;
use VT\Repo\UserRepo;
use VT\Support\Clock;
use VT\Support\Validator;

/** Benutzer- und Token-Verwaltung (nur Administratoren). */
final class UserController
{
    public static function register(Router $r): void
    {
        $r->get('/api/users', [self::class, 'index']);
        $r->post('/api/users', [self::class, 'store']);
        $r->patch('/api/users/{id}', [self::class, 'update']);
        $r->delete('/api/users/{id}', [self::class, 'destroy']);

        $r->get('/api/tokens', [self::class, 'tokens']);
        $r->post('/api/tokens', [self::class, 'createToken']);
        $r->delete('/api/tokens/{id}', [self::class, 'revokeToken']);

        // Eigenes Passwort ändern darf jeder Angemeldete.
        $r->post('/api/auth/password', [self::class, 'changeOwnPassword'], ['auth' => 'user']);
    }

    public static function index(): array
    {
        return ['users' => UserRepo::list()];
    }

    public static function store(Request $req): Response
    {
        $data = self::payload($req, true);
        $id = UserRepo::create($data);
        return Response::json(['user' => UserRepo::findOrFail($id)], 201);
    }

    public static function update(Request $req): array
    {
        return ['user' => UserRepo::update(self::id($req), self::payload($req, false))];
    }

    public static function destroy(Request $req): array
    {
        UserRepo::delete(self::id($req));
        return ['ok' => true];
    }

    public static function changeOwnPassword(Request $req): array
    {
        $user = Auth::require();

        $v = new Validator($req->body);
        $current = $v->string('current_password', true, 200);
        $next = $v->string('new_password', true, 200);
        $v->validate();

        $hash = (string) Database::value('SELECT pass_hash FROM users WHERE id = :id', ['id' => $user->id]);
        if (!password_verify((string) $current, $hash)) {
            throw HttpException::validation(['current_password' => 'Das bisherige Passwort stimmt nicht.']);
        }
        if (strlen((string) $next) < UserRepo::MIN_PASSWORD) {
            throw HttpException::validation([
                'new_password' => 'Mindestens ' . UserRepo::MIN_PASSWORD . ' Zeichen.',
            ]);
        }

        Database::update('users', $user->id, [
            'pass_hash'  => Auth::hash((string) $next),
            'updated_at' => Clock::now(),
        ]);

        return ['ok' => true];
    }

    // -- Tokens für native Clients -----------------------------------------

    public static function tokens(): array
    {
        $rows = Database::all(
            'SELECT t.id, t.label, t.last_used_at, t.expires_at, t.created_at, u.email
               FROM tokens t JOIN users u ON u.id = t.user_id
              ORDER BY t.created_at DESC'
        );

        return ['tokens' => array_map(static fn(array $row) => [
            'id'           => (int) $row['id'],
            'label'        => (string) $row['label'],
            'email'        => (string) $row['email'],
            'last_used_at' => $row['last_used_at'] === null ? null : Clock::iso((int) $row['last_used_at']),
            'expires_at'   => $row['expires_at'] === null ? null : Clock::iso((int) $row['expires_at']),
            'created_at'   => Clock::iso((int) $row['created_at']),
        ], $rows)];
    }

    /**
     * Erzeugt ein Zugriffstoken. Der Klartext wird genau einmal
     * zurückgegeben – gespeichert wird nur sein SHA-256-Abdruck.
     */
    public static function createToken(Request $req): Response
    {
        $v = new Validator($req->body);
        $label = $v->string('label', true, 100);
        $userId = $v->has('user_id') ? $v->int('user_id', false, 1) : Auth::require()->id;
        $days = $v->has('expires_days') ? $v->int('expires_days', false, 1, 3650) : null;
        $v->validate();

        UserRepo::findOrFail((int) $userId);

        $plain = 'vt_' . bin2hex(random_bytes(24));
        $id = Database::insert('tokens', [
            'user_id'    => (int) $userId,
            'hash'       => hash('sha256', $plain),
            'label'      => $label,
            'expires_at' => $days === null ? null : Clock::now() + $days * 86400,
            'created_at' => Clock::now(),
        ]);

        return Response::json([
            'token' => $plain,
            'id'    => $id,
            'hint'  => 'Dieses Token wird nur jetzt angezeigt. Bitte sicher notieren.',
        ], 201);
    }

    public static function revokeToken(Request $req): array
    {
        $id = self::id($req);
        if (Database::one('SELECT id FROM tokens WHERE id = :id', ['id' => $id]) === null) {
            throw HttpException::notFound('Token nicht gefunden.');
        }
        Database::run('DELETE FROM tokens WHERE id = :id', ['id' => $id]);
        return ['ok' => true];
    }

    // -- Eingaben -----------------------------------------------------------

    private static function payload(Request $req, bool $creating): array
    {
        $v = new Validator($req->body);
        $data = [];

        if ($creating || $v->has('email')) {
            $data['email'] = $v->email('email', true);
        }
        if ($creating || $v->has('name')) {
            $data['name'] = $v->string('name', $creating, 200);
        }
        if ($creating || !empty($req->body['password'])) {
            $data['password'] = $v->string('password', $creating, 200);
        }
        if ($creating || $v->has('role')) {
            $data['role'] = $v->enum('role', ['admin', 'client'], $creating, 'client');
        }
        if ($v->has('client_id')) {
            $data['client_id'] = $req->body['client_id'] === null ? null : $v->int('client_id', false, 1);
        }
        if ($v->has('project_filter')) {
            $data['project_filter'] = $req->body['project_filter'];
        }
        if ($v->has('show_costs')) {
            $data['show_costs'] = $v->bool('show_costs', true);
        }
        if ($v->has('active')) {
            $data['active'] = $v->bool('active', true);
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
