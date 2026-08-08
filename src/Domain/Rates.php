<?php
declare(strict_types=1);

namespace VT\Domain;

use VT\Db\Database;
use VT\Http\HttpException;
use VT\Settings;

/**
 * Stundensatz-Vererbung: Teilprojekt -> Projekt -> Kunde -> Vorgabe.
 *
 * Der ermittelte Satz wird beim Anlegen eines Eintrags als Wert gespeichert.
 * Eine spätere Satzänderung verändert damit keine bereits erfassten – und
 * womöglich längst abgerechneten – Zeiten mehr.
 */
final class Rates
{
    /** Effektiver Satz eines Teilprojekts. */
    public static function forSubproject(int $subprojectId): float
    {
        $row = Database::one(
            'SELECT s.rate AS s_rate, p.rate AS p_rate, c.rate AS c_rate
               FROM subprojects s
               JOIN projects p ON p.id = s.project_id
               JOIN clients  c ON c.id = p.client_id
              WHERE s.id = :id',
            ['id' => $subprojectId]
        );
        if ($row === null) {
            throw HttpException::notFound('Teilprojekt nicht gefunden.');
        }

        return self::coalesce($row['s_rate'], $row['p_rate'], $row['c_rate']);
    }

    /** Effektiver Satz eines Projekts (für die Anzeige in der Stammdatenpflege). */
    public static function forProject(int $projectId): float
    {
        $row = Database::one(
            'SELECT p.rate AS p_rate, c.rate AS c_rate
               FROM projects p JOIN clients c ON c.id = p.client_id
              WHERE p.id = :id',
            ['id' => $projectId]
        );
        if ($row === null) {
            throw HttpException::notFound('Projekt nicht gefunden.');
        }
        return self::coalesce(null, $row['p_rate'], $row['c_rate']);
    }

    public static function forClient(int $clientId): float
    {
        $rate = Database::value('SELECT rate FROM clients WHERE id = :id', ['id' => $clientId]);
        return self::coalesce(null, null, $rate);
    }

    public static function default(): float
    {
        return Settings::float('default_rate', 0.0);
    }

    private static function coalesce(mixed ...$candidates): float
    {
        foreach ($candidates as $value) {
            if ($value !== null && $value !== '') {
                return round((float) $value, 2);
            }
        }
        return self::default();
    }

    /** Betrag aus Minuten und Satz, kaufmännisch auf Cent gerundet. */
    public static function amount(int $minutes, float $rate): float
    {
        return round($minutes / 60 * $rate, 2);
    }
}
