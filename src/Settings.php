<?php
declare(strict_types=1);

namespace VT;

use VT\Db\Database;
use VT\Support\Clock;

/**
 * Laufzeit-Einstellungen aus der Tabelle `settings`.
 * Im Gegensatz zur Config sind das Werte, die im Web-Interface änderbar sind.
 */
final class Settings
{
    /** @var array<string,string>|null */
    private static ?array $cache = null;

    /** @return array<string,string> */
    public static function all(): array
    {
        if (self::$cache === null) {
            self::$cache = [];
            foreach (Database::all('SELECT key, value FROM settings') as $row) {
                self::$cache[(string) $row['key']] = (string) $row['value'];
            }
        }
        return self::$cache;
    }

    public static function get(string $key, ?string $default = null): ?string
    {
        return self::all()[$key] ?? $default;
    }

    public static function int(string $key, int $default = 0): int
    {
        $value = self::get($key);
        return $value === null ? $default : (int) $value;
    }

    public static function float(string $key, float $default = 0.0): float
    {
        $value = self::get($key);
        return $value === null ? $default : (float) $value;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $value = self::get($key);
        return $value === null ? $default : in_array($value, ['1', 'true', 'yes', 'on'], true);
    }

    public static function set(string $key, string|int|float|bool $value): void
    {
        self::all(); // Cache füllen, sonst enthält er hinterher nur diesen Schlüssel
        $value = is_bool($value) ? ($value ? '1' : '0') : (string) $value;
        Database::run(
            'INSERT INTO settings (key, value, updated_at) VALUES (:k, :v, :t)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
            ['k' => $key, 'v' => $value, 't' => Clock::now()]
        );
        self::$cache[$key] = $value;
    }

    /** @param array<string,string|int|float|bool> $values */
    public static function setMany(array $values): void
    {
        Database::transaction(static function () use ($values): void {
            foreach ($values as $key => $value) {
                self::set($key, $value);
            }
        });
    }

    public static function flush(): void
    {
        self::$cache = null;
    }

    // -- Bequeme Zugriffe auf die Rundungsregeln -----------------------------

    public static function roundingMinutes(): int
    {
        if (!self::bool('rounding_enabled', true)) {
            return 0;
        }
        return max(0, self::int('rounding_minutes', 15));
    }

    public static function roundingMode(): string
    {
        $mode = (string) self::get('rounding_mode', 'nearest');
        return in_array($mode, ['nearest', 'up', 'down'], true) ? $mode : 'nearest';
    }

    /** Rundet einen Zeitstempel gemäß der aktuellen Einstellung. */
    public static function roundTimestamp(int $ts): int
    {
        $minutes = self::roundingMinutes();
        return $minutes > 0 ? Clock::round($ts, $minutes, self::roundingMode()) : $ts;
    }
}
