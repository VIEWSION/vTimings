<?php
declare(strict_types=1);

namespace VT\Export;

/** Vollständiger JSON-Dump inklusive Filter und Summen – für eigene Skripte. */
final class JsonExporter implements Exporter
{
    public static function key(): string
    {
        return 'json';
    }

    public static function label(): string
    {
        return 'JSON (vollständig)';
    }

    public static function mimeType(): string
    {
        return 'application/json; charset=utf-8';
    }

    public static function extension(): string
    {
        return 'json';
    }

    public function render(array $entries, array $context = []): string
    {
        return (string) json_encode([
            'generated_at' => $context['generated_at'] ?? null,
            'filters'      => $context['filters'] ?? [],
            'totals'       => $context['totals'] ?? [],
            // Interne Notizen gehören nicht in eine Datei, die weitergegeben wird.
            'entries'      => array_map(static function (array $entry): array {
                unset($entry['internal_note']);
                return $entry;
            }, $entries),
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_PRESERVE_ZERO_FRACTION);
    }
}
