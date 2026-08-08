<?php
declare(strict_types=1);

namespace VT\Controller;

use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Router;
use VT\Import\TimingsCsvImporter;

final class ImportController
{
    private const MAX_BYTES = 32 * 1024 * 1024;

    public static function register(Router $r): void
    {
        $r->post('/api/import/timings-csv', [self::class, 'timingsCsv']);
    }

    /**
     * Nimmt den CSV-Export entgegen – als Datei-Upload (Feld "file") oder als
     * roher Request-Body. Mit ?dry_run=1 wird nur berichtet, nicht geschrieben.
     */
    public static function timingsCsv(Request $req): array
    {
        $content = self::payload($req);

        $aliases = [];
        $raw = $req->input('aliases');
        if (is_string($raw) && $raw !== '') {
            $decoded = json_decode($raw, true);
            $raw = is_array($decoded) ? $decoded : [];
        }
        if (is_array($raw)) {
            foreach ($raw as $from => $to) {
                if (is_string($from) && is_string($to) && trim($from) !== '' && trim($to) !== '') {
                    $aliases[trim($from)] = trim($to);
                }
            }
        }

        $duplicates = (string) $req->input('duplicates', 'skip');
        if (!in_array($duplicates, ['skip', 'import'], true)) {
            throw HttpException::badRequest('duplicates muss "skip" oder "import" sein.');
        }

        $dryRun = in_array((string) $req->input('dry_run', '0'), ['1', 'true', 'yes'], true);

        $importer = new TimingsCsvImporter([
            'aliases'    => $aliases,
            'duplicates' => $duplicates,
            'dry_run'    => $dryRun,
        ]);

        return ['report' => $importer->readString($content)->import()];
    }

    private static function payload(Request $req): string
    {
        if (isset($_FILES['file'])) {
            $file = $_FILES['file'];
            if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                throw HttpException::badRequest('Upload fehlgeschlagen (Code ' . $file['error'] . ').');
            }
            if (($file['size'] ?? 0) > self::MAX_BYTES) {
                throw HttpException::badRequest('Datei ist größer als 32 MB.');
            }
            $content = file_get_contents($file['tmp_name']);
            if ($content === false) {
                throw HttpException::badRequest('Hochgeladene Datei nicht lesbar.');
            }
            return $content;
        }

        // Bei JSON-Requests steckt der Inhalt im Feld "csv", sonst im Body.
        $body = (!$req->isJson() && $req->rawBody !== '')
            ? $req->rawBody
            : (string) $req->input('csv', '');
        if (trim($body) === '') {
            throw HttpException::badRequest('Keine CSV-Daten übergeben (Feld "file" oder Request-Body).');
        }
        if (strlen($body) > self::MAX_BYTES) {
            throw HttpException::badRequest('Daten sind größer als 32 MB.');
        }
        return $body;
    }
}
