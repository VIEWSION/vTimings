<?php
declare(strict_types=1);

namespace VT\Report;

use VT\Http\HttpException;

/**
 * Rendert eine Vorlage aus templates/report/<name>/report.php.
 *
 * Die Vorlage bekommt $report (Anzeigemodell), $t (Übersetzer in der
 * Sprache des Nachweises), $ui (Übersetzer in der Sprache der Oberfläche,
 * für Bedienelemente, die nicht gedruckt werden) und $css (Inhalt der
 * print.css, wird eingebettet – so bleibt der Ausdruck auch bei "Seite
 * speichern" vollständig).
 */
final class Renderer
{
    public static function dir(): string
    {
        return VT_ROOT . '/templates/report';
    }

    /** @return list<array{key:string,label:string}> */
    public static function templates(): array
    {
        $out = [];
        foreach (glob(self::dir() . '/*', GLOB_ONLYDIR) ?: [] as $path) {
            $key = basename($path);
            $meta = is_file($path . '/template.json')
                ? json_decode((string) file_get_contents($path . '/template.json'), true)
                : null;
            $out[] = [
                'key'   => $key,
                'label' => is_array($meta) ? ($meta['label'] ?? $key) : $key,
            ];
        }
        return $out;
    }

    public static function render(string $template, array $report, ?string $uiLang = null): string
    {
        if (!preg_match('/^[a-z0-9_-]+$/', $template)) {
            throw HttpException::badRequest('Ungültiger Vorlagenname.');
        }

        $dir = self::dir() . '/' . $template;
        $file = $dir . '/report.php';
        if (!is_file($file)) {
            throw HttpException::notFound('Vorlage nicht gefunden: ' . $template);
        }

        $css = is_file($dir . '/print.css') ? (string) file_get_contents($dir . '/print.css') : '';
        $t = new Translator((string) ($report['lang'] ?? 'de'));
        $ui = new Translator($uiLang ?? 'de');

        ob_start();
        (static function (string $file, array $report, Translator $t, Translator $ui, string $css): void {
            /** @noinspection PhpIncludeInspection */
            require $file;
        })($file, $report, $t, $ui, $css);

        return (string) ob_get_clean();
    }
}
