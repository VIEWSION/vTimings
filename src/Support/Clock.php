<?php
declare(strict_types=1);

namespace VT\Support;

use VT\Config;

/**
 * Zeit-Helfer.
 *
 * Regel im ganzen Projekt: gespeichert wird ein UTC-Unixtimestamp (INTEGER),
 * geparst und formatiert wird in der App-Zeitzone. Damit bleiben die 304
 * Einträge über Mitternacht und die Sommerzeit-Wechsel korrekt.
 */
final class Clock
{
    public static function now(): int
    {
        return time();
    }

    /** Lokale Wanduhrzeit ("2026-08-08 11:45") -> UTC-Timestamp. */
    public static function fromLocal(string $format, string $value): ?int
    {
        $dt = \DateTimeImmutable::createFromFormat($format, $value, Config::tz());
        if (!$dt) {
            return null;
        }
        $err = \DateTimeImmutable::getLastErrors();
        if ($err && ($err['error_count'] > 0)) {
            return null;
        }
        return $dt->getTimestamp();
    }

    /** ISO-8601 mit Offset ("2026-08-08T11:45:00+02:00") -> UTC-Timestamp. */
    public static function fromIso(string $value): ?int
    {
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        try {
            // Ohne Offset im String gilt die App-Zeitzone.
            $dt = new \DateTimeImmutable($value, Config::tz());
        } catch (\Exception) {
            return null;
        }
        return $dt->getTimestamp();
    }

    public static function local(int $ts): \DateTimeImmutable
    {
        return (new \DateTimeImmutable('@' . $ts))->setTimezone(Config::tz());
    }

    public static function iso(?int $ts): ?string
    {
        return $ts === null ? null : self::local($ts)->format('c');
    }

    public static function format(int $ts, string $format): string
    {
        return self::local($ts)->format($format);
    }

    /** Lokales Tagesdatum als "Y-m-d". */
    public static function day(int $ts): string
    {
        return self::local($ts)->format('Y-m-d');
    }

    /** Beginn des lokalen Tages als UTC-Timestamp. */
    public static function startOfDay(string $ymd): ?int
    {
        return self::fromLocal('Y-m-d H:i:s', $ymd . ' 00:00:00');
    }

    /** Ende des lokalen Tages (exklusiv) als UTC-Timestamp. */
    public static function endOfDay(string $ymd): ?int
    {
        $start = self::startOfDay($ymd);
        if ($start === null) {
            return null;
        }
        return self::local($start)->modify('+1 day')->getTimestamp();
    }

    /**
     * Rundet einen Zeitpunkt auf ein Minutenraster.
     *
     * @param string $mode 'nearest' | 'up' | 'down'
     */
    public static function round(int $ts, int $minutes, string $mode = 'nearest'): int
    {
        if ($minutes <= 1) {
            return $ts - ($ts % 60);
        }
        $step = $minutes * 60;
        return match ($mode) {
            'up'    => (int) (ceil($ts / $step) * $step),
            'down'  => (int) (floor($ts / $step) * $step),
            default => (int) (round($ts / $step) * $step),
        };
    }

    /** Minuten als "HH:MM" (auch über 24 Stunden hinaus). */
    public static function hhmm(int $minutes): string
    {
        $sign = $minutes < 0 ? '-' : '';
        $minutes = abs($minutes);
        return sprintf('%s%02d:%02d', $sign, intdiv($minutes, 60), $minutes % 60);
    }

    /** Minuten als Dezimalstunden, auf 2 Stellen. */
    public static function decimal(int $minutes): float
    {
        return round($minutes / 60, 2);
    }
}
