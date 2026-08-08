<?php
declare(strict_types=1);

namespace VT\Export;

use VT\Http\HttpException;

/**
 * Bekannte Ausgabeformate. Neue Exporter hier eintragen – der Rest
 * (API, Oberfläche, Dateiname) ergibt sich daraus von selbst.
 */
final class Registry
{
    /** @var list<class-string<Exporter>> */
    private const EXPORTERS = [
        TimingsCsvExporter::class,
        GenericCsvExporter::class,
        JsonExporter::class,
    ];

    public static function get(string $key): Exporter
    {
        foreach (self::EXPORTERS as $class) {
            if ($class::key() === $key) {
                return new $class();
            }
        }
        throw HttpException::badRequest(
            'Unbekanntes Exportformat: ' . $key . '. Verfügbar: ' . implode(', ', array_column(self::all(), 'key'))
        );
    }

    /** @return list<array{key:string,label:string,extension:string}> */
    public static function all(): array
    {
        return array_map(static fn(string $class) => [
            'key'       => $class::key(),
            'label'     => $class::label(),
            'extension' => $class::extension(),
        ], self::EXPORTERS);
    }
}
