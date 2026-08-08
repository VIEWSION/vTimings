<?php
declare(strict_types=1);

namespace VT;

/**
 * Konfiguration aus data/config.php, mit sinnvollen Vorgaben.
 *
 * Die Datei liegt bewusst in data/ (gesperrt, nicht im Repo), damit
 * Zugangsdaten und Umgebungsschalter nicht mit dem Code wandern.
 */
final class Config
{
    private static array $values = [];

    private const DEFAULTS = [
        'app_name'      => 'vTimings',
        'timezone'      => 'Europe/Berlin',
        'locale'        => 'de',
        'currency'      => 'EUR',
        'debug'         => false,
        'base_path'     => null,          // null = automatisch aus dem Request
        'db_file'       => null,          // null = data/vtimings.sqlite
        'session_name'  => 'vtsid',
        'session_lifetime' => 60 * 60 * 24 * 30,
        'trusted_proxy' => false,         // true, wenn ein Reverse-Proxy davor steht
    ];

    public static function load(): void
    {
        $values = self::DEFAULTS;

        $file = VT_DATA . '/config.php';
        if (is_file($file)) {
            $custom = require $file;
            if (is_array($custom)) {
                $values = array_replace($values, $custom);
            }
        }

        $values['db_file'] ??= VT_DATA . '/vtimings.sqlite';

        self::$values = $values;
    }

    public static function get(string $key, mixed $default = null): mixed
    {
        return self::$values[$key] ?? $default;
    }

    public static function bool(string $key): bool
    {
        return (bool) (self::$values[$key] ?? false);
    }

    public static function set(string $key, mixed $value): void
    {
        self::$values[$key] = $value;
    }

    public static function all(): array
    {
        return self::$values;
    }

    /** Zeitzone für die Anzeige. */
    public static function tz(): \DateTimeZone
    {
        static $tz = null;
        return $tz ??= new \DateTimeZone((string) self::get('timezone', 'Europe/Berlin'));
    }
}
