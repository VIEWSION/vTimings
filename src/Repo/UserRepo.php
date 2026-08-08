<?php
declare(strict_types=1);

namespace VT\Repo;

use VT\Auth\Auth;
use VT\Db\Database;
use VT\Http\HttpException;
use VT\Support\Clock;

/**
 * Benutzerverwaltung. Nur Administratoren kommen hier heran – die Routen
 * sind entsprechend eingestuft.
 */
final class UserRepo
{
    public const MIN_PASSWORD = 10;

    /** @return list<array<string,mixed>> */
    public static function list(): array
    {
        $rows = Database::all(
            'SELECT u.*, c.name AS client_name
               FROM users u
               LEFT JOIN clients c ON c.id = u.client_id
              ORDER BY u.role, u.name COLLATE NOCASE'
        );
        return array_map([self::class, 'hydrate'], $rows);
    }

    public static function find(int $id, bool $orFail = false): ?array
    {
        $row = Database::one(
            'SELECT u.*, c.name AS client_name
               FROM users u LEFT JOIN clients c ON c.id = u.client_id
              WHERE u.id = :id',
            ['id' => $id]
        );
        if ($row === null && $orFail) {
            throw HttpException::notFound('Benutzer nicht gefunden.');
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
        $email = strtolower(trim((string) $data['email']));
        self::assertEmailFree($email);
        self::assertPassword((string) $data['password']);

        $role = $data['role'] ?? 'client';
        $clientId = self::normalizeClient($role, $data['client_id'] ?? null);
        $filter = self::normalizeProjects($clientId, $data['project_filter'] ?? null);

        $now = Clock::now();
        return Database::insert('users', [
            'name'           => trim((string) ($data['name'] ?? $email)),
            'email'          => $email,
            'pass_hash'      => Auth::hash((string) $data['password']),
            'role'           => $role,
            'client_id'      => $clientId,
            'project_filter' => $filter,
            'show_costs'     => ($data['show_costs'] ?? true) ? 1 : 0,
            'active'         => ($data['active'] ?? true) ? 1 : 0,
            'created_at'     => $now,
            'updated_at'     => $now,
        ]);
    }

    /** @param array<string,mixed> $data */
    public static function update(int $id, array $data): array
    {
        $user = self::findOrFail($id);
        $fields = [];

        if (array_key_exists('email', $data)) {
            $email = strtolower(trim((string) $data['email']));
            if ($email !== $user['email']) {
                self::assertEmailFree($email);
                $fields['email'] = $email;
            }
        }
        if (array_key_exists('name', $data)) {
            $fields['name'] = trim((string) $data['name']);
        }
        if (!empty($data['password'])) {
            self::assertPassword((string) $data['password']);
            $fields['pass_hash'] = Auth::hash((string) $data['password']);
        }

        $role = $data['role'] ?? $user['role'];
        if (array_key_exists('role', $data)) {
            $fields['role'] = $role;
        }
        if (array_key_exists('client_id', $data) || array_key_exists('role', $data)) {
            $fields['client_id'] = self::normalizeClient($role, $data['client_id'] ?? $user['client_id']);
        }
        if (array_key_exists('project_filter', $data)) {
            $clientId = $fields['client_id'] ?? $user['client_id'];
            $fields['project_filter'] = self::normalizeProjects($clientId, $data['project_filter']);
        }
        if (array_key_exists('show_costs', $data)) {
            $fields['show_costs'] = $data['show_costs'] ? 1 : 0;
        }
        if (array_key_exists('active', $data)) {
            $fields['active'] = $data['active'] ? 1 : 0;
        }

        if ($fields === []) {
            return $user;
        }

        self::assertNotLastAdmin($id, $fields);

        $fields['updated_at'] = Clock::now();
        Database::update('users', $id, $fields);

        return self::findOrFail($id);
    }

    public static function delete(int $id): void
    {
        $user = self::findOrFail($id);
        if ($user['id'] === Auth::require()->id) {
            throw HttpException::conflict('Das eigene Konto lässt sich nicht löschen.');
        }
        self::assertNotLastAdmin($id, ['active' => 0]);

        Database::run('DELETE FROM users WHERE id = :id', ['id' => $id]);
    }

    // -- Prüfungen ----------------------------------------------------------

    private static function assertEmailFree(string $email): void
    {
        if (Database::one('SELECT id FROM users WHERE email = :email', ['email' => $email]) !== null) {
            throw HttpException::conflict('Diese E-Mail-Adresse ist bereits vergeben.');
        }
    }

    private static function assertPassword(string $password): void
    {
        if (strlen($password) < self::MIN_PASSWORD) {
            throw HttpException::validation([
                'password' => 'Mindestens ' . self::MIN_PASSWORD . ' Zeichen.',
            ]);
        }
    }

    /**
     * Verhindert, dass der letzte aktive Administrator herabgestuft,
     * deaktiviert oder gelöscht wird – sonst sperrt man sich aus.
     */
    private static function assertNotLastAdmin(int $id, array $changes): void
    {
        $losesAdmin = (isset($changes['role']) && $changes['role'] !== 'admin')
            || (isset($changes['active']) && (int) $changes['active'] === 0);

        if (!$losesAdmin) {
            return;
        }

        $others = (int) Database::value(
            "SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1 AND id != :id",
            ['id' => $id]
        );
        if ($others === 0) {
            throw HttpException::conflict('Das ist der letzte aktive Administrator.');
        }
    }

    private static function normalizeClient(string $role, mixed $clientId): ?int
    {
        if ($role === 'admin') {
            return null; // Administratoren sehen ohnehin alles
        }
        $clientId = (int) $clientId;
        if ($clientId <= 0) {
            throw HttpException::validation(['client_id' => 'Kundenzugänge brauchen einen Kunden.']);
        }
        if (Database::one('SELECT id FROM clients WHERE id = :id AND deleted_at IS NULL', ['id' => $clientId]) === null) {
            throw HttpException::validation(['client_id' => 'Kunde nicht gefunden.']);
        }
        return $clientId;
    }

    /** @return string|null JSON-Array der erlaubten Projekt-IDs, null = alle des Kunden */
    private static function normalizeProjects(?int $clientId, mixed $projects): ?string
    {
        if ($clientId === null || $projects === null || $projects === '' || $projects === []) {
            return null;
        }
        if (is_string($projects)) {
            $decoded = json_decode($projects, true);
            $projects = is_array($decoded) ? $decoded : [];
        }
        if (!is_array($projects)) {
            throw HttpException::validation(['project_filter' => 'Liste von Projekt-IDs erwartet.']);
        }

        $ids = array_values(array_unique(array_map('intval', $projects)));
        if ($ids === []) {
            return null;
        }

        $placeholders = [];
        $params = ['client' => $clientId];
        foreach ($ids as $i => $id) {
            $placeholders[] = ':p' . $i;
            $params['p' . $i] = $id;
        }

        $valid = Database::all(
            'SELECT id FROM projects
              WHERE client_id = :client AND deleted_at IS NULL AND id IN (' . implode(',', $placeholders) . ')',
            $params
        );
        $validIds = array_map('intval', array_column($valid, 'id'));

        $unknown = array_diff($ids, $validIds);
        if ($unknown !== []) {
            throw HttpException::validation([
                'project_filter' => 'Diese Projekte gehören nicht zum Kunden: ' . implode(', ', $unknown),
            ]);
        }

        return (string) json_encode($validIds);
    }

    /** @param array<string,mixed> $row */
    private static function hydrate(array $row): array
    {
        $filter = null;
        if (!empty($row['project_filter'])) {
            $decoded = json_decode((string) $row['project_filter'], true);
            $filter = is_array($decoded) ? array_map('intval', $decoded) : null;
        }

        return [
            'id'             => (int) $row['id'],
            'name'           => (string) $row['name'],
            'email'          => (string) $row['email'],
            'role'           => (string) $row['role'],
            'client_id'      => $row['client_id'] === null ? null : (int) $row['client_id'],
            'client_name'    => $row['client_name'],
            'project_filter' => $filter,
            'show_costs'     => (bool) $row['show_costs'],
            'active'         => (bool) $row['active'],
            'last_login_at'  => $row['last_login_at'] === null ? null : Clock::iso((int) $row['last_login_at']),
            'created_at'     => Clock::iso((int) $row['created_at']),
        ];
    }
}
