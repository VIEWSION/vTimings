<?php
declare(strict_types=1);

namespace VT\Auth;

use VT\Config;
use VT\Db\Database;
use VT\Http\Request;
use VT\Support\Clock;

/**
 * "Angemeldet bleiben": ein langlebiges Cookie, das eine abgelaufene
 * Sitzung stillschweigend wiederherstellt.
 *
 * Die Sitzung selbst bleibt kurzlebig (endet mit dem Browser bzw. nach
 * `session_lifetime` ohne Aktivität). Das Cookie trägt ein Zufallstoken,
 * in der Datenbank steht nur dessen Hash. Die Laufzeit verlängert sich bei
 * jeder Wiederherstellung – wer die App regelmäßig nutzt, meldet sich also
 * gar nicht mehr an; wer sie `remember_lifetime` lang nicht öffnet, schon.
 */
final class Remember
{
    public static function cookieName(): string
    {
        return (string) Config::get('session_name', 'vtsid') . '_r';
    }

    public static function lifetime(): int
    {
        return (int) Config::get('remember_lifetime', 60 * 60 * 24 * 90);
    }

    /** Neues Token für diesen Browser ausstellen und als Cookie setzen. */
    public static function issue(int $userId, Request $request): void
    {
        $now = Clock::now();
        $plain = bin2hex(random_bytes(32));

        // Abgelaufene Tokens bei der Gelegenheit gleich mit aufräumen.
        Database::run('DELETE FROM remember_tokens WHERE expires_at < :now', ['now' => $now]);

        Database::insert('remember_tokens', [
            'user_id'      => $userId,
            'hash'         => hash('sha256', $plain),
            'user_agent'   => mb_substr((string) ($request->header('user-agent') ?? ''), 0, 250),
            'created_at'   => $now,
            'last_used_at' => $now,
            'expires_at'   => $now + self::lifetime(),
        ]);

        self::sendCookie($plain, $now + self::lifetime());
    }

    /**
     * Benutzer-ID aus dem Cookie, sofern das Token gültig und der Zugang
     * aktiv ist. Verlängert dabei die Laufzeit. Ein ungültiges Cookie wird
     * gelöscht, damit es nicht bei jedem Aufruf erneut geprüft wird.
     */
    public static function restore(): ?array
    {
        $plain = $_COOKIE[self::cookieName()] ?? null;
        if (!is_string($plain) || !preg_match('/^[0-9a-f]{64}$/', $plain)) {
            return null;
        }

        $now = Clock::now();
        $row = Database::one(
            'SELECT u.*, r.id AS remember_id
               FROM remember_tokens r
               JOIN users u ON u.id = r.user_id
              WHERE r.hash = :hash AND r.expires_at >= :now AND u.active = 1',
            ['hash' => hash('sha256', $plain), 'now' => $now]
        );
        if ($row === null) {
            self::clearCookie();
            return null;
        }

        $expires = $now + self::lifetime();
        Database::update('remember_tokens', (int) $row['remember_id'], [
            'last_used_at' => $now,
            'expires_at'   => $expires,
        ]);
        self::sendCookie($plain, $expires);

        return $row;
    }

    /** Beim Abmelden: das Token dieses Browsers entwerten. */
    public static function forget(): void
    {
        $plain = $_COOKIE[self::cookieName()] ?? null;
        if (is_string($plain) && $plain !== '') {
            Database::run('DELETE FROM remember_tokens WHERE hash = :hash', ['hash' => hash('sha256', $plain)]);
        }
        self::clearCookie();
    }

    /**
     * Alle Tokens eines Benutzers entwerten – nach einem Passwortwechsel
     * soll kein anderes Gerät angemeldet bleiben. Mit `$keepCurrent` bleibt
     * der Browser, aus dem der Wechsel kam, angemeldet.
     */
    public static function forgetUser(int $userId, bool $keepCurrent = false): void
    {
        $plain = $_COOKIE[self::cookieName()] ?? null;

        if ($keepCurrent && is_string($plain) && $plain !== '') {
            Database::run(
                'DELETE FROM remember_tokens WHERE user_id = :user AND hash != :hash',
                ['user' => $userId, 'hash' => hash('sha256', $plain)]
            );
            return;
        }

        Database::run('DELETE FROM remember_tokens WHERE user_id = :user', ['user' => $userId]);
    }

    private static function sendCookie(string $value, int $expires): void
    {
        if (PHP_SAPI === 'cli' || headers_sent()) {
            return;
        }
        $base = Request::basePath();
        setcookie(self::cookieName(), $value, [
            'expires'  => $expires,
            'path'     => $base === '' ? '/' : $base . '/',
            'domain'   => '',
            'secure'   => Session::isHttps(),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
    }

    private static function clearCookie(): void
    {
        unset($_COOKIE[self::cookieName()]);
        self::sendCookie('', time() - 42000);
    }
}
