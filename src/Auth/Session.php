<?php
declare(strict_types=1);

namespace VT\Auth;

use VT\Config;
use VT\Http\Request;

final class Session
{
    private static bool $started = false;

    public static function start(): void
    {
        if (self::$started || PHP_SAPI === 'cli') {
            self::$started = true;
            if (!isset($_SESSION)) {
                $_SESSION = [];
            }
            return;
        }

        if (session_status() === PHP_SESSION_ACTIVE) {
            self::$started = true;
            return;
        }

        // Die Sitzung endet mit dem Browser bzw. nach `session_lifetime`
        // ohne Aktivität. Länger angemeldet bleibt man über Remember.
        $lifetime = (int) Config::get('session_lifetime', 60 * 60 * 12);
        $base = Request::basePath();

        // Eigenes Verzeichnis statt des systemweiten: dort räumen auch
        // andere PHP-Anwendungen mit ihrer eigenen (meist kürzeren)
        // gc_maxlifetime auf und nehmen unsere Sitzungen gleich mit – unter
        // MAMP nach 24 Minuten.
        $path = (string) Config::get('session_path', VT_DATA . '/sessions');
        if (!is_dir($path)) {
            @mkdir($path, 0700, true);
        }
        if (is_dir($path) && is_writable($path)) {
            session_save_path($path);
        }

        session_name((string) Config::get('session_name', 'vtsid'));
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => $base === '' ? '/' : $base . '/',
            'domain'   => '',
            'secure'   => self::isHttps(),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.gc_maxlifetime', (string) $lifetime);

        session_start();
        self::$started = true;
    }

    public static function isHttps(): bool
    {
        if (($_SERVER['HTTPS'] ?? '') !== '' && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
            return true;
        }
        if (Config::bool('trusted_proxy') && strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https') {
            return true;
        }
        return false;
    }

    /** Nach dem Login: neue Session-ID, damit fixierte IDs nichts nützen. */
    public static function regenerate(): void
    {
        if (PHP_SAPI !== 'cli' && session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }
    }

    public static function get(string $key, mixed $default = null): mixed
    {
        self::start();
        return $_SESSION[$key] ?? $default;
    }

    public static function set(string $key, mixed $value): void
    {
        self::start();
        $_SESSION[$key] = $value;
    }

    public static function forget(string $key): void
    {
        self::start();
        unset($_SESSION[$key]);
    }

    public static function destroy(): void
    {
        self::start();
        $_SESSION = [];
        if (PHP_SAPI !== 'cli' && session_status() === PHP_SESSION_ACTIVE) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires'  => time() - 42000,
                'path'     => $params['path'],
                'domain'   => $params['domain'],
                'secure'   => $params['secure'],
                'httponly' => $params['httponly'],
                'samesite' => $params['samesite'] ?? 'Strict',
            ]);
            session_destroy();
        }
        self::$started = false;
    }
}
