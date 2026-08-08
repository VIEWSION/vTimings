<?php
declare(strict_types=1);

namespace VT\Export;

/**
 * Ein Ausgabeformat für Einträge.
 *
 * Neue Formate (DATEV, lexoffice, Excel …) brauchen nur diese Schnittstelle
 * und einen Eintrag in der Registry.
 */
interface Exporter
{
    /** Schlüssel für ?format= */
    public static function key(): string;

    /** Bezeichnung für die Oberfläche. */
    public static function label(): string;

    public static function mimeType(): string;

    public static function extension(): string;

    /**
     * @param list<array<string,mixed>> $entries Einträge in der Reihenfolge der Ausgabe
     * @param array<string,mixed>       $context Filter, Summen und Metadaten
     */
    public function render(array $entries, array $context = []): string;
}
