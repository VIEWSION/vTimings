<?php
declare(strict_types=1);

namespace VT\Export;

use VT\Support\Clock;

/**
 * Exportiert exakt im Format der macOS-App Timings.
 *
 * Damit bleibt der Kreis geschlossen: was hier herausfällt, lässt sich
 * unverändert wieder importieren – und die alten Auswertungsskripte
 * verstehen es weiterhin.
 */
final class TimingsCsvExporter implements Exporter
{
    public static function key(): string
    {
        return 'timings-csv';
    }

    public static function label(): string
    {
        return 'Timings-CSV (import- und rückwärtskompatibel)';
    }

    public static function mimeType(): string
    {
        return 'text/csv; charset=utf-8';
    }

    public static function extension(): string
    {
        return 'csv';
    }

    public function render(array $entries, array $context = []): string
    {
        $handle = fopen('php://temp', 'r+');
        if ($handle === false) {
            throw new \RuntimeException('Temporärer Puffer nicht verfügbar.');
        }

        fputcsv($handle, [
            'Kunde', 'Projekt', 'Teilprojekt', 'Start', 'Ende', 'Notizen',
            'Dauer', 'Dauer (Dezimal)', 'Stundensatz', 'Kosten', 'Art', 'Benutzer',
        ], ';', '"', '');

        foreach ($entries as $entry) {
            $start = Clock::fromIso($entry['started_at']);
            $end = Clock::fromIso($entry['ended_at']);

            fputcsv($handle, [
                $entry['client_name'],
                $entry['project_name'],
                $entry['subproject_name'],
                Clock::format((int) $start, 'd.m.y, H:i'),
                Clock::format((int) $end, 'd.m.y, H:i'),
                // Timings speichert Notizen einzeilig; Umbrüche würden die
                // Zeilenstruktur der Datei beim Reimport zerreißen.
                str_replace(["\r\n", "\r", "\n"], ' ', (string) $entry['note']),
                Clock::hhmm((int) $entry['duration_min']),
                self::number(Clock::decimal((int) $entry['duration_min'])),
                self::number((float) ($entry['rate'] ?? 0)),
                self::number((float) ($entry['amount'] ?? 0)),
                $entry['type'] === 'expense' ? 'Kosten' : 'Zeit',
                $context['user'] ?? 'Ohne Titel',
            ], ';', '"', '');
        }

        rewind($handle);
        $csv = (string) stream_get_contents($handle);
        fclose($handle);

        return $csv;
    }

    /** Deutsches Zahlenformat wie im Original: Komma, keine Tausenderpunkte. */
    private static function number(float $value): string
    {
        return number_format($value, 2, ',', '');
    }
}
