<?php
declare(strict_types=1);

namespace VT\Export;

/**
 * Neutrales CSV mit ISO-Datum und Punkt als Dezimaltrennzeichen –
 * für Tabellenkalkulation und Weiterverarbeitung.
 */
final class GenericCsvExporter implements Exporter
{
    public static function key(): string
    {
        return 'csv';
    }

    public static function label(): string
    {
        return 'CSV (ISO-Datum, neutral)';
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

        // BOM, damit Excel die Umlaute erkennt.
        fwrite($handle, "\u{FEFF}");

        fputcsv($handle, [
            'id', 'client', 'project', 'subproject', 'date', 'start', 'end',
            'duration_min', 'hours', 'note', 'rate', 'amount', 'currency',
            'type', 'billable', 'billed', 'invoice', 'source',
        ], ',', '"', '');

        foreach ($entries as $entry) {
            fputcsv($handle, [
                $entry['id'],
                $entry['client_name'],
                $entry['project_name'],
                $entry['subproject_name'],
                $entry['date'],
                $entry['started_at'],
                $entry['ended_at'],
                $entry['duration_min'],
                number_format($entry['decimal'], 2, '.', ''),
                $entry['note'],
                isset($entry['rate']) ? number_format((float) $entry['rate'], 2, '.', '') : '',
                isset($entry['amount']) ? number_format((float) $entry['amount'], 2, '.', '') : '',
                $entry['currency'] ?? '',
                $entry['type'],
                $entry['billable'] ? '1' : '0',
                $entry['billed'] ? '1' : '0',
                $entry['invoice_number'] ?? '',
                $entry['source'],
            ], ',', '"', '');
        }

        rewind($handle);
        $csv = (string) stream_get_contents($handle);
        fclose($handle);

        return $csv;
    }
}
