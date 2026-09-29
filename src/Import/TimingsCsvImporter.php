<?php
declare(strict_types=1);

namespace VT\Import;

use VT\Db\Database;
use VT\Http\HttpException;
use VT\Support\Clock;

/**
 * Importiert Exporte der macOS-App "Timings".
 *
 * Format: Semikolon-getrennt, UTF-8, Kopfzeile, Datum als "d.m.y, H:i",
 * Dezimaltrennzeichen Komma.
 *
 * Grundsatz: nichts stillschweigend reparieren. Ungerundete Zeiten, Einträge
 * über Mitternacht, ein negativer Eintrag und Duplikate landen im Bericht,
 * werden aber unverändert übernommen – die Altdaten sind, wie sie sind.
 */
final class TimingsCsvImporter
{
    public const COLUMNS = [
        'Kunde', 'Projekt', 'Teilprojekt', 'Start', 'Ende', 'Notizen',
        'Dauer', 'Dauer (Dezimal)', 'Stundensatz', 'Kosten', 'Art', 'Benutzer',
    ];

    /** Farbpalette für automatisch angelegte Kunden (CSV kennt keine Farben). */
    private const PALETTE = [
        '#2f6df6', '#e2574c', '#1c8b4b', '#f2a900', '#8e44ad',
        '#00a3a3', '#d6336c', '#5a6b7d', '#7048e8', '#c2410c',
    ];

    /** @var list<array<string,mixed>> */
    private array $rows = [];
    /** @var list<array{line:int,message:string,raw:string}> */
    private array $errors = [];

    private int $lineCount = 0;

    /**
     * @param array{
     *   aliases?: array<string,string>,   Kundennamen zusammenführen: "Meier" => "Dr. Meier"
     *   duplicates?: string,              'skip' (Vorgabe) | 'import'
     *   dry_run?: bool
     * } $options
     */
    public function __construct(private readonly array $options = [])
    {
    }

    // -- Einlesen -----------------------------------------------------------

    public function readFile(string $path): self
    {
        if (!is_readable($path)) {
            throw HttpException::badRequest('Datei nicht lesbar: ' . basename($path));
        }
        $handle = fopen($path, 'r');
        if ($handle === false) {
            throw HttpException::badRequest('Datei konnte nicht geöffnet werden.');
        }
        try {
            $this->read($handle);
        } finally {
            fclose($handle);
        }
        return $this;
    }

    public function readString(string $content): self
    {
        $handle = fopen('php://temp', 'r+');
        if ($handle === false) {
            throw new \RuntimeException('Temporärer Puffer nicht verfügbar.');
        }
        fwrite($handle, $content);
        rewind($handle);
        try {
            $this->read($handle);
        } finally {
            fclose($handle);
        }
        return $this;
    }

    /** @param resource $handle */
    private function read($handle): void
    {
        $header = fgetcsv($handle, 0, ';', '"', '\\');
        if ($header === false || $header === [null]) {
            throw HttpException::badRequest('Die Datei ist leer.');
        }

        // BOM entfernen und Spaltennamen normalisieren
        $header[0] = preg_replace('/^\xEF\xBB\xBF/', '', (string) $header[0]);
        $header = array_map(static fn($h) => trim((string) $h), $header);

        $missing = array_diff(['Kunde', 'Projekt', 'Teilprojekt', 'Start', 'Ende'], $header);
        if ($missing !== []) {
            throw HttpException::badRequest(
                'Das ist kein Timings-Export. Fehlende Spalten: ' . implode(', ', $missing)
            );
        }

        $index = array_flip($header);
        $line = 1;

        while (($data = fgetcsv($handle, 0, ';', '"', '\\')) !== false) {
            $line++;
            if ($data === [null] || $data === []) {
                continue; // Leerzeile
            }
            $this->lineCount++;

            $get = static function (string $column) use ($data, $index): string {
                $pos = $index[$column] ?? null;
                return $pos === null ? '' : trim((string) ($data[$pos] ?? ''));
            };

            $row = $this->parseRow($get, $line);
            if ($row !== null) {
                $this->rows[] = $row;
            }
        }
    }

    /** @return array<string,mixed>|null */
    private function parseRow(callable $get, int $line): ?array
    {
        $client = $get('Kunde');
        $project = $get('Projekt');
        $subproject = $get('Teilprojekt');

        if ($client === '' && $project === '' && $subproject === '') {
            return null;
        }

        $startRaw = $get('Start');
        $endRaw = $get('Ende');
        $start = self::parseDateTime($startRaw);
        $end = self::parseDateTime($endRaw);

        if ($start === null || $end === null) {
            $this->errors[] = [
                'line'    => $line,
                'message' => 'Start oder Ende nicht lesbar (erwartet "TT.MM.JJ, HH:MM").',
                'raw'     => $startRaw . ' – ' . $endRaw,
            ];
            return null;
        }
        if ($client === '') {
            $this->errors[] = ['line' => $line, 'message' => 'Kunde fehlt.', 'raw' => $startRaw];
            return null;
        }

        // Fehlende Ebenen auffüllen, damit die Hierarchie geschlossen bleibt.
        $project = $project !== '' ? $project : 'Allgemein';
        $subproject = $subproject !== '' ? $subproject : 'Allgemein';

        $client = $this->options['aliases'][$client] ?? $client;

        $durationFromColumn = self::parseDuration($get('Dauer'));
        $durationComputed = (int) round(($end - $start) / 60);
        // Die Spalte "Dauer" ist die abgerechnete Wahrheit und passt in allen
        // Zeilen exakt zu Kosten = Dauer x Satz. Abweichungen werden gemeldet.
        $duration = $durationFromColumn ?? $durationComputed;

        $rate = self::parseNumber($get('Stundensatz'));
        $amount = self::parseNumber($get('Kosten'));
        $art = $get('Art');

        $localStart = Clock::local($start);
        $localEnd = Clock::local($end);

        return [
            'line'         => $line,
            'client'       => $client,
            'project'      => $project,
            'subproject'   => $subproject,
            'started_at'   => $start,
            'ended_at'     => $end,
            'duration_min' => $duration,
            'note'         => $get('Notizen'),
            'rate'         => $rate ?? 0.0,
            'amount'       => $amount ?? 0.0,
            'type'         => ($art === '' || $art === 'Zeit') ? 'time' : 'expense',
            'hash'         => self::hash($client, $project, $subproject, $start, $end, $get('Notizen')),
            // Auffälligkeiten
            'overnight'    => $localStart->format('Y-m-d') !== $localEnd->format('Y-m-d'),
            'negative'     => $end < $start,
            'unrounded'    => ((int) $localStart->format('i')) % 15 !== 0 || ((int) $localEnd->format('i')) % 15 !== 0,
            'mismatch'     => $durationFromColumn !== null && $durationFromColumn !== $durationComputed,
        ];
    }

    // -- Analyse ------------------------------------------------------------

    /**
     * Trockenlauf: was würde passieren?
     *
     * @return array<string,mixed>
     */
    public function analyze(): array
    {
        $existingClients = self::existingNames('SELECT name FROM clients WHERE deleted_at IS NULL');
        $existingProjects = [];
        foreach (Database::all(
            'SELECT c.name AS c, p.name AS p FROM projects p
               JOIN clients c ON c.id = p.client_id
              WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL'
        ) as $row) {
            $existingProjects[$row['c'] . "\0" . $row['p']] = true;
        }
        $existingSubs = [];
        foreach (Database::all(
            'SELECT c.name AS c, p.name AS p, s.name AS s FROM subprojects s
               JOIN projects p ON p.id = s.project_id
               JOIN clients  c ON c.id = p.client_id
              WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL AND c.deleted_at IS NULL'
        ) as $row) {
            $existingSubs[$row['c'] . "\0" . $row['p'] . "\0" . $row['s']] = true;
        }

        $newClients = [];
        $newProjects = [];
        $newSubs = [];
        $seenHashes = [];
        $duplicatesInFile = 0;
        $alreadyImported = 0;

        $flags = ['overnight' => 0, 'negative' => 0, 'unrounded' => 0, 'mismatch' => 0, 'expense' => 0, 'no_note' => 0];
        $minutes = 0;
        $amount = 0.0;
        $from = null;
        $to = null;
        $ratesByClient = [];

        $knownHashes = self::existingHashes();

        foreach ($this->rows as $row) {
            $ck = $row['client'];
            $pk = $ck . "\0" . $row['project'];
            $sk = $pk . "\0" . $row['subproject'];

            if (!isset($existingClients[$ck]) && !isset($newClients[$ck])) {
                $newClients[$ck] = true;
            }
            if (!isset($existingProjects[$pk]) && !isset($newProjects[$pk])) {
                $newProjects[$pk] = true;
            }
            if (!isset($existingSubs[$sk]) && !isset($newSubs[$sk])) {
                $newSubs[$sk] = true;
            }

            if (isset($seenHashes[$row['hash']])) {
                $duplicatesInFile++;
            }
            $seenHashes[$row['hash']] = true;

            if (isset($knownHashes[$row['hash']])) {
                $alreadyImported++;
            }

            foreach (['overnight', 'negative', 'unrounded', 'mismatch'] as $flag) {
                if ($row[$flag]) {
                    $flags[$flag]++;
                }
            }
            if ($row['type'] !== 'time') {
                $flags['expense']++;
            }
            if (trim($row['note']) === '') {
                $flags['no_note']++;
            }

            $minutes += $row['duration_min'];
            $amount += $row['amount'];
            $from = $from === null ? $row['started_at'] : min($from, $row['started_at']);
            $to = $to === null ? $row['ended_at'] : max($to, $row['ended_at']);

            $ratesByClient[$ck][(string) $row['rate']] = ($ratesByClient[$ck][(string) $row['rate']] ?? 0) + 1;
        }

        return [
            'lines'   => $this->lineCount,
            'parsed'  => count($this->rows),
            'errors'  => $this->errors,
            'range'   => [
                'from' => $from === null ? null : Clock::iso($from),
                'to'   => $to === null ? null : Clock::iso($to),
            ],
            'totals'  => [
                'minutes' => $minutes,
                'hhmm'    => Clock::hhmm($minutes),
                'decimal' => Clock::decimal($minutes),
                'amount'  => round($amount, 2),
            ],
            'new'     => [
                'clients'     => array_keys($newClients),
                'projects'    => count($newProjects),
                'subprojects' => count($newSubs),
            ],
            'skips'   => [
                'duplicates_in_file' => $duplicatesInFile,
                'already_imported'   => $alreadyImported,
            ],
            'flags'   => $flags,
            'rates'   => array_map(
                static fn(array $counts) => array_keys($counts),
                $ratesByClient
            ),
        ];
    }

    // -- Schreiben ----------------------------------------------------------

    /**
     * Führt den Import aus.
     *
     * @return array<string,mixed> Bericht inkl. tatsächlich geschriebener Zahlen
     */
    public function import(): array
    {
        $report = $this->analyze();

        if ($this->options['dry_run'] ?? false) {
            $report['dry_run'] = true;
            $report['imported'] = 0;
            return $report;
        }
        if ($this->rows === []) {
            $report['imported'] = 0;
            return $report;
        }

        $duplicateMode = $this->options['duplicates'] ?? 'skip';
        $now = Clock::now();

        $result = Database::transaction(function () use ($duplicateMode, $now): array {
            $clientIds = self::indexClients();
            $projectIds = self::indexProjects();
            $subIds = self::indexSubprojects();
            $knownHashes = self::existingHashes();

            $created = ['clients' => 0, 'projects' => 0, 'subprojects' => 0];
            $imported = 0;
            $skipped = 0;
            $rateVotes = [];
            $seen = [];

            $insert = Database::pdo()->prepare(
                'INSERT INTO entries
                    (subproject_id, started_at, ended_at, duration_min, note, rate, amount,
                     type, billable, source, import_hash, created_at, updated_at)
                 VALUES
                    (:subproject_id, :started_at, :ended_at, :duration_min, :note, :rate, :amount,
                     :type, 1, \'import\', :import_hash, :created_at, :updated_at)'
            );

            foreach ($this->rows as $row) {
                $ck = $row['client'];
                $pk = $ck . "\0" . $row['project'];
                $sk = $pk . "\0" . $row['subproject'];

                if (!isset($clientIds[$ck])) {
                    $clientIds[$ck] = Database::insert('clients', [
                        'name'       => $ck,
                        'color'      => self::colorFor($ck),
                        'currency'   => 'EUR',
                        'lang'       => 'de',
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                    $created['clients']++;
                }
                if (!isset($projectIds[$pk])) {
                    $projectIds[$pk] = Database::insert('projects', [
                        'client_id'  => $clientIds[$ck],
                        'name'       => $row['project'],
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                    $created['projects']++;
                }
                if (!isset($subIds[$sk])) {
                    $subIds[$sk] = Database::insert('subprojects', [
                        'project_id' => $projectIds[$pk],
                        'name'       => $row['subproject'],
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                    $created['subprojects']++;
                }

                $hash = $row['hash'];
                $isDuplicate = isset($knownHashes[$hash]) || isset($seen[$hash]);

                if ($isDuplicate) {
                    if ($duplicateMode !== 'import') {
                        $skipped++;
                        continue;
                    }
                    // Bewusst mitnehmen: eindeutigen Hash erzeugen.
                    $n = 2;
                    while (isset($knownHashes[$hash . '#' . $n]) || isset($seen[$hash . '#' . $n])) {
                        $n++;
                    }
                    $hash .= '#' . $n;
                }
                $seen[$hash] = true;

                $insert->execute([
                    'subproject_id' => $subIds[$sk],
                    'started_at'    => $row['started_at'],
                    'ended_at'      => $row['ended_at'],
                    'duration_min'  => $row['duration_min'],
                    'note'          => $row['note'],
                    'rate'          => $row['rate'],
                    'amount'        => $row['amount'],
                    'type'          => $row['type'],
                    'import_hash'   => $hash,
                    'created_at'    => $now,
                    'updated_at'    => $now,
                ]);
                $imported++;

                // Für den Satz zählt der zuletzt tatsächlich verwendete –
                // nicht der über 20 Jahre häufigste. Je Kunde und je Projekt,
                // weil Projekte desselben Kunden verschiedene Sätze haben.
                if ($row['rate'] > 0) {
                    $clientId = $clientIds[$ck];
                    $projectId = $projectIds[$pk];
                    if (($rateVotes['client'][$clientId]['at'] ?? -1) < $row['started_at']) {
                        $rateVotes['client'][$clientId] = ['at' => $row['started_at'], 'rate' => $row['rate']];
                    }
                    if (($rateVotes['project'][$projectId]['at'] ?? -1) < $row['started_at']) {
                        $rateVotes['project'][$projectId] = [
                            'at' => $row['started_at'], 'rate' => $row['rate'], 'client' => $clientId,
                        ];
                    }
                }
            }

            self::applyDerivedRates($rateVotes, $now);

            return ['imported' => $imported, 'skipped' => $skipped, 'created' => $created];
        });

        return $report + $result;
    }

    /**
     * Schreibt die aus den Einträgen abgeleiteten Stundensätze.
     *
     * Der Kunde bekommt seinen zuletzt verwendeten Satz. Ein Projekt bekommt
     * nur dann einen eigenen, wenn er vom Kundensatz abweicht – sonst bliebe
     * die Vererbung ohne Not überschrieben. Bereits gepflegte Sätze werden
     * nie angefasst.
     *
     * @param array{client?:array<int,array{at:int,rate:float}>, project?:array<int,array{at:int,rate:float,client:int}>} $votes
     */
    private static function applyDerivedRates(array $votes, int $now): void
    {
        foreach ($votes['client'] ?? [] as $clientId => $latest) {
            $current = Database::value('SELECT rate FROM clients WHERE id = :id', ['id' => $clientId]);
            if ($current === null) {
                Database::update('clients', (int) $clientId, ['rate' => $latest['rate'], 'updated_at' => $now]);
            }
        }

        foreach ($votes['project'] ?? [] as $projectId => $latest) {
            $current = Database::value('SELECT rate FROM projects WHERE id = :id', ['id' => $projectId]);
            if ($current !== null) {
                continue;
            }
            $clientRate = Database::value('SELECT rate FROM clients WHERE id = :id', ['id' => $latest['client']]);
            if ($clientRate !== null && abs((float) $clientRate - $latest['rate']) < 0.005) {
                continue; // identisch: Vererbung genügt
            }
            Database::update('projects', (int) $projectId, ['rate' => $latest['rate'], 'updated_at' => $now]);
        }
    }

    // -- Hilfsfunktionen ----------------------------------------------------

    /** "08.08.26, 11:45" -> UTC-Timestamp */
    public static function parseDateTime(string $value): ?int
    {
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        foreach (['d.m.y, H:i', 'd.m.Y, H:i', 'd.m.y H:i', 'd.m.Y H:i', 'd.m.y, H:i:s', 'd.m.Y, H:i:s'] as $format) {
            $ts = Clock::fromLocal($format, $value);
            if ($ts !== null) {
                return $ts;
            }
        }
        return null;
    }

    /** "03:15" -> 195 Minuten */
    public static function parseDuration(string $value): ?int
    {
        $value = trim($value);
        if ($value === '' || !preg_match('/^(-?)(\d+):([0-5]\d)$/', $value, $m)) {
            return null;
        }
        $minutes = (int) $m[2] * 60 + (int) $m[3];
        return $m[1] === '-' ? -$minutes : $minutes;
    }

    /** "1.234,56" -> 1234.56 */
    public static function parseNumber(string $value): ?float
    {
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        $value = str_replace(['.', ' ', "\u{00a0}"], '', $value);
        $value = str_replace(',', '.', $value);
        return is_numeric($value) ? (float) $value : null;
    }

    public static function hash(string $client, string $project, string $subproject, int $start, int $end, string $note): string
    {
        return hash('sha256', implode("\0", [$client, $project, $subproject, (string) $start, (string) $end, $note]));
    }

    private static function colorFor(string $name): string
    {
        $index = abs(crc32($name)) % count(self::PALETTE);
        return self::PALETTE[$index];
    }

    /** @return array<string,true> */
    private static function existingNames(string $sql): array
    {
        $out = [];
        foreach (Database::all($sql) as $row) {
            $out[(string) $row['name']] = true;
        }
        return $out;
    }

    /** @return array<string,true> */
    private static function existingHashes(): array
    {
        $out = [];
        foreach (Database::all('SELECT import_hash FROM entries WHERE import_hash IS NOT NULL') as $row) {
            $out[(string) $row['import_hash']] = true;
        }
        return $out;
    }

    /** @return array<string,int> */
    private static function indexClients(): array
    {
        $out = [];
        foreach (Database::all('SELECT id, name FROM clients WHERE deleted_at IS NULL') as $row) {
            $out[(string) $row['name']] = (int) $row['id'];
        }
        return $out;
    }

    /** @return array<string,int> */
    private static function indexProjects(): array
    {
        $out = [];
        foreach (Database::all(
            'SELECT p.id, c.name AS c, p.name AS p FROM projects p
               JOIN clients c ON c.id = p.client_id
              WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL'
        ) as $row) {
            $out[$row['c'] . "\0" . $row['p']] = (int) $row['id'];
        }
        return $out;
    }

    /** @return array<string,int> */
    private static function indexSubprojects(): array
    {
        $out = [];
        foreach (Database::all(
            'SELECT s.id, c.name AS c, p.name AS p, s.name AS s FROM subprojects s
               JOIN projects p ON p.id = s.project_id
               JOIN clients  c ON c.id = p.client_id
              WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL AND c.deleted_at IS NULL'
        ) as $row) {
            $out[$row['c'] . "\0" . $row['p'] . "\0" . $row['s']] = (int) $row['id'];
        }
        return $out;
    }
}
