<?php
declare(strict_types=1);

namespace VT\Auth;

use VT\Db\Database;
use VT\Http\HttpException;
use VT\Http\Request;
use VT\Settings;
use VT\Support\Clock;

final class Auth
{
    /** Unterstützte Oberflächensprachen. */
    public const LANGS = ['de', 'en'];

    private static ?User $user = null;
    private static bool $resolved = false;

    /** Passwort-Hashing: Argon2id, sonst der jeweils beste verfügbare Algorithmus. */
    public static function hash(string $password): string
    {
        $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT;
        return password_hash($password, $algo);
    }

    /**
     * Ermittelt den Benutzer aus Bearer-Token oder Session.
     * Ohne gültige Anmeldung: null (kein Fehler – das entscheidet die Route).
     */
    public static function resolve(Request $request): ?User
    {
        if (self::$resolved) {
            return self::$user;
        }
        self::$resolved = true;

        $token = $request->bearerToken();
        if ($token !== null) {
            self::$user = self::userFromToken($token);
            return self::$user;
        }

        Session::start();
        $userId = Session::get('user_id');
        if (is_int($userId) || (is_string($userId) && ctype_digit($userId))) {
            $row = Database::one(
                'SELECT * FROM users WHERE id = :id AND active = 1',
                ['id' => (int) $userId]
            );
            if ($row !== null) {
                self::$user = User::fromRow($row);
            } else {
                Session::destroy();
            }
        }

        return self::$user;
    }

    private static function userFromToken(string $plain): ?User
    {
        $hash = hash('sha256', $plain);
        $row = Database::one(
            'SELECT u.*, t.id AS token_id, t.expires_at
               FROM tokens t
               JOIN users u ON u.id = t.user_id
              WHERE t.hash = :hash AND u.active = 1',
            ['hash' => $hash]
        );
        if ($row === null) {
            return null;
        }
        if ($row['expires_at'] !== null && (int) $row['expires_at'] < Clock::now()) {
            return null;
        }

        Database::run(
            'UPDATE tokens SET last_used_at = :now WHERE id = :id',
            ['now' => Clock::now(), 'id' => (int) $row['token_id']]
        );

        return User::fromRow($row);
    }

    public static function user(): ?User
    {
        return self::$user;
    }

    public static function require(): User
    {
        if (self::$user === null) {
            throw HttpException::unauthorized();
        }
        return self::$user;
    }

    public static function requireAdmin(): User
    {
        $user = self::require();
        if (!$user->isAdmin()) {
            throw HttpException::forbidden('Diese Funktion ist Administratoren vorbehalten.');
        }
        return $user;
    }

    /**
     * Login mit Passwort. Wirft bei falschen Daten eine 401 – bewusst mit
     * derselben Meldung für unbekannte E-Mail und falsches Passwort.
     */
    public static function login(Request $request, string $email, string $password): User
    {
        $email = strtolower(trim($email));

        RateLimiter::check($request->ip, $email);

        $row = Database::one('SELECT * FROM users WHERE email = :email', ['email' => $email]);
        $hash = $row['pass_hash'] ?? '$2y$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';

        $ok = password_verify($password, (string) $hash) && $row !== null && (int) $row['active'] === 1;

        RateLimiter::record($request->ip, $email, $ok);

        if (!$ok || $row === null) {
            throw HttpException::unauthorized('E-Mail oder Passwort ist falsch.');
        }

        if (password_needs_rehash((string) $row['pass_hash'], defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT)) {
            Database::update('users', (int) $row['id'], ['pass_hash' => self::hash($password), 'updated_at' => Clock::now()]);
        }
        Database::update('users', (int) $row['id'], ['last_login_at' => Clock::now()]);

        Session::start();
        Session::regenerate();
        Session::set('user_id', (int) $row['id']);
        Csrf::rotate();

        self::$user = User::fromRow($row);
        self::$resolved = true;

        return self::$user;
    }

    // -- Oberflächensprache -------------------------------------------------

    /**
     * Sprache der Oberfläche für den angemeldeten Benutzer.
     *
     * Kundenzugänge folgen dem Kundenprofil (`clients.lang`) – dieselbe
     * Sprache also, in der ihr Leistungsnachweis gedruckt wird. Für
     * Administratoren gibt es keine zweite Ebene, dort steht sie in den
     * Einstellungen. Ohne Anmeldung: Deutsch.
     */
    public static function lang(): string
    {
        $user = self::$user;

        if ($user !== null && $user->isClient() && $user->clientId !== null) {
            $lang = (string) Database::value(
                'SELECT lang FROM clients WHERE id = :id',
                ['id' => $user->clientId]
            );
        } else {
            $lang = (string) Settings::get('ui_lang', 'de');
        }

        return in_array($lang, self::LANGS, true) ? $lang : 'de';
    }

    /** Speichert die Sprache an derselben Stelle, aus der lang() sie liest. */
    public static function setLang(string $lang): string
    {
        if (!in_array($lang, self::LANGS, true)) {
            throw HttpException::validation(['lang' => 'Unbekannte Sprache.']);
        }

        $user = self::require();
        if ($user->isClient() && $user->clientId !== null) {
            Database::update('clients', $user->clientId, [
                'lang'       => $lang,
                'updated_at' => Clock::now(),
            ]);
        } else {
            Settings::set('ui_lang', $lang);
        }

        return $lang;
    }

    public static function logout(): void
    {
        Session::destroy();
        self::$user = null;
        self::$resolved = true;
    }

    /** Nur für Tests und CLI. */
    public static function setUser(?User $user): void
    {
        self::$user = $user;
        self::$resolved = true;
    }
}
