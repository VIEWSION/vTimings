<?php
/**
 * Wartungs-Kommandos.
 *
 *   php bin/console.php install [--email= --password= --name=]
 *   php bin/console.php migrate
 *   php bin/console.php status
 *   php bin/console.php user:add   --email= --password= [--name= --role=admin|client --client=ID]
 *   php bin/console.php user:passwd --email= --password=
 *   php bin/console.php user:list
 *   php bin/console.php backup
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Nur über die Kommandozeile.');
}

require dirname(__DIR__) . '/bootstrap.php';

use VT\Auth\Auth;
use VT\Config;
use VT\Db\Database;
use VT\Db\Migrator;
use VT\Settings;
use VT\Support\Clock;

$argv = $_SERVER['argv'];
$command = $argv[1] ?? 'help';

$options = [];
foreach (array_slice($argv, 2) as $arg) {
    if (preg_match('/^--([a-z0-9_-]+)(?:=(.*))?$/i', $arg, $m)) {
        $options[$m[1]] = $m[2] ?? '1';
    }
}

function out(string $text): void
{
    fwrite(STDOUT, $text . "\n");
}

function fail(string $text): never
{
    fwrite(STDERR, "Fehler: $text\n");
    exit(1);
}

/** Passwort ohne Echo abfragen, falls nicht als Option übergeben. */
function askSecret(string $prompt): string
{
    fwrite(STDOUT, $prompt);
    if (function_exists('shell_exec') && stripos(PHP_OS_FAMILY, 'win') === false) {
        @shell_exec('stty -echo 2>/dev/null');
    }
    $value = trim((string) fgets(STDIN));
    @shell_exec('stty echo 2>/dev/null');
    fwrite(STDOUT, "\n");
    return $value;
}

switch ($command) {
    case 'install':
        $fresh = !is_file((string) Config::get('db_file'));
        Migrator::migrate(static fn(string $name) => out("  angewandt: $name"));
        out('Schema-Version: ' . Migrator::currentVersion());

        $hasAdmin = (int) Database::value("SELECT COUNT(*) FROM users WHERE role = 'admin'") > 0;
        if ($hasAdmin) {
            out($fresh ? 'Administrator existiert bereits.' : 'Fertig.');
            break;
        }

        $email = $options['email'] ?? '';
        while (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            fwrite(STDOUT, 'E-Mail des Administrators: ');
            $email = trim((string) fgets(STDIN));
        }
        $password = $options['password'] ?? '';
        while (strlen($password) < 10) {
            $password = askSecret('Passwort (mind. 10 Zeichen): ');
            if (strlen($password) < 10) {
                out('  zu kurz.');
            }
        }
        $name = $options['name'] ?? 'Administrator';

        $now = Clock::now();
        Database::insert('users', [
            'name'       => $name,
            'email'      => strtolower($email),
            'pass_hash'  => Auth::hash($password),
            'role'       => 'admin',
            'show_costs' => 1,
            'active'     => 1,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        out("Administrator angelegt: $email");
        break;

    case 'migrate':
        $applied = Migrator::migrate(static fn(string $name) => out("  angewandt: $name"));
        out($applied === [] ? 'Nichts zu tun.' : count($applied) . ' Migration(en) angewandt.');
        out('Schema-Version: ' . Migrator::currentVersion());
        break;

    case 'status':
        $file = (string) Config::get('db_file');
        out('Datenbank:  ' . $file . (is_file($file) ? ' (' . number_format(filesize($file) / 1024, 1) . ' KB)' : ' — fehlt'));
        if (!is_file($file)) {
            break;
        }
        out('Schema:     ' . Migrator::currentVersion() . ' (' . count(Migrator::pending()) . ' offen)');
        out('SQLite:     ' . Database::value('SELECT sqlite_version()'));
        out('Zeitzone:   ' . Config::get('timezone'));
        foreach (['users', 'clients', 'projects', 'subprojects', 'entries', 'invoices', 'timers'] as $table) {
            out(sprintf('%-12s %d', $table . ':', (int) Database::value("SELECT COUNT(*) FROM $table")));
        }
        out('Rundung:    ' . (Settings::roundingMinutes() ?: 'aus') . ' Min / ' . Settings::roundingMode());
        break;

    case 'user:add':
        $email = strtolower(trim($options['email'] ?? ''));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            fail('--email fehlt oder ist ungültig.');
        }
        $password = $options['password'] ?? askSecret('Passwort: ');
        if (strlen($password) < 10) {
            fail('Passwort muss mindestens 10 Zeichen haben.');
        }
        $role = $options['role'] ?? 'client';
        if (!in_array($role, ['admin', 'client'], true)) {
            fail('--role muss admin oder client sein.');
        }
        $clientId = isset($options['client']) ? (int) $options['client'] : null;
        if ($role === 'client' && !$clientId) {
            fail('Kundenzugänge brauchen --client=ID.');
        }
        if ($clientId && Database::one('SELECT id FROM clients WHERE id = :id', ['id' => $clientId]) === null) {
            fail("Kunde $clientId existiert nicht.");
        }

        $now = Clock::now();
        $id = Database::insert('users', [
            'name'       => $options['name'] ?? $email,
            'email'      => $email,
            'pass_hash'  => Auth::hash($password),
            'role'       => $role,
            'client_id'  => $clientId,
            'show_costs' => isset($options['no-costs']) ? 0 : 1,
            'active'     => 1,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        out("Benutzer #$id angelegt ($email, $role).");
        break;

    case 'user:passwd':
        $email = strtolower(trim($options['email'] ?? ''));
        $row = Database::one('SELECT id FROM users WHERE email = :email', ['email' => $email]);
        if ($row === null) {
            fail("Benutzer $email nicht gefunden.");
        }
        $password = $options['password'] ?? askSecret('Neues Passwort: ');
        if (strlen($password) < 10) {
            fail('Passwort muss mindestens 10 Zeichen haben.');
        }
        Database::update('users', (int) $row['id'], [
            'pass_hash'  => Auth::hash($password),
            'updated_at' => Clock::now(),
        ]);
        out('Passwort geändert.');
        break;

    case 'user:list':
        $rows = Database::all(
            'SELECT u.id, u.name, u.email, u.role, u.active, u.last_login_at, c.name AS client
               FROM users u LEFT JOIN clients c ON c.id = u.client_id
              ORDER BY u.role, u.email'
        );
        if ($rows === []) {
            out('Keine Benutzer.');
            break;
        }
        foreach ($rows as $row) {
            out(sprintf(
                '#%-3d %-8s %-32s %-20s %s%s',
                $row['id'],
                $row['role'],
                $row['email'],
                $row['client'] ?? '—',
                $row['last_login_at'] ? 'zuletzt ' . Clock::format((int) $row['last_login_at'], 'd.m.Y H:i') : 'nie angemeldet',
                (int) $row['active'] === 1 ? '' : ' [inaktiv]'
            ));
        }
        break;

    case 'import':
        $file = $options['file'] ?? '';
        if ($file === '' || !is_readable($file)) {
            fail('--file= fehlt oder ist nicht lesbar.');
        }

        // --alias="Fraas=Dr. Fraas" (mehrfach möglich, kommagetrennt)
        $aliases = [];
        foreach (explode(',', $options['alias'] ?? '') as $pair) {
            if (str_contains($pair, '=')) {
                [$from, $to] = array_map('trim', explode('=', $pair, 2));
                if ($from !== '' && $to !== '') {
                    $aliases[$from] = $to;
                }
            }
        }

        $dryRun = isset($options['dry-run']);
        $importer = new VT\Import\TimingsCsvImporter([
            'aliases'    => $aliases,
            'duplicates' => $options['duplicates'] ?? 'skip',
            'dry_run'    => $dryRun,
        ]);

        $report = $importer->readFile($file)->import();

        out($dryRun ? '— Trockenlauf, es wurde nichts geschrieben —' : 'Import abgeschlossen.');
        out('');
        out(sprintf('Zeilen gelesen:      %d', $report['lines']));
        out(sprintf('davon verwertbar:    %d', $report['parsed']));
        out(sprintf('Zeitraum:            %s bis %s',
            $report['range']['from'] ? Clock::format(strtotime($report['range']['from']), 'd.m.Y') : '—',
            $report['range']['to'] ? Clock::format(strtotime($report['range']['to']), 'd.m.Y') : '—'));
        out(sprintf('Summe:               %s (%s h) / %s EUR',
            $report['totals']['hhmm'],
            number_format($report['totals']['decimal'], 2, ',', '.'),
            number_format($report['totals']['amount'], 2, ',', '.')));
        out('');
        out(sprintf('Neue Kunden:         %d', count($report['new']['clients'])));
        out(sprintf('Neue Projekte:       %d', $report['new']['projects']));
        out(sprintf('Neue Teilprojekte:   %d', $report['new']['subprojects']));
        out('');
        out('Auffälligkeiten (werden unverändert übernommen):');
        out(sprintf('  über Mitternacht:  %d', $report['flags']['overnight']));
        out(sprintf('  nicht auf 15 Min:  %d', $report['flags']['unrounded']));
        out(sprintf('  Ende vor Start:    %d', $report['flags']['negative']));
        out(sprintf('  Dauer abweichend:  %d', $report['flags']['mismatch']));
        out(sprintf('  ohne Notiz:        %d', $report['flags']['no_note']));
        out(sprintf('  keine Zeiteinträge:%d', $report['flags']['expense']));
        out('');
        out(sprintf('Duplikate in Datei:  %d', $report['skips']['duplicates_in_file']));
        out(sprintf('bereits importiert:  %d', $report['skips']['already_imported']));

        if ($report['errors'] !== []) {
            out('');
            out(sprintf('%d fehlerhafte Zeile(n):', count($report['errors'])));
            foreach (array_slice($report['errors'], 0, 20) as $error) {
                out(sprintf('  Zeile %-6d %s  [%s]', $error['line'], $error['message'], $error['raw']));
            }
            if (count($report['errors']) > 20) {
                out('  …');
            }
        }

        if (!$dryRun) {
            out('');
            out(sprintf('Geschrieben:         %d Einträge, %d übersprungen',
                $report['imported'], $report['skipped'] ?? 0));
        }
        break;

    case 'backup':
        $dir = VT_DATA . '/backups';
        if (!is_dir($dir)) {
            mkdir($dir, 0770, true);
        }
        $stamp = Clock::format(Clock::now(), 'Y-m-d-His');

        // VACUUM INTO liefert eine konsistente Kopie auch im laufenden Betrieb.
        $target = $dir . '/vtimings-' . $stamp . '.sqlite';
        Database::pdo()->exec('VACUUM INTO ' . Database::pdo()->quote($target));
        out('Datenbank:  ' . basename($target) . ' (' . number_format(filesize($target) / 1024, 1) . ' KB)');

        // Zusätzlich ein menschenlesbarer Dump. Wenn in zehn Jahren weder
        // diese App noch SQLite zur Hand ist, bleibt die CSV lesbar.
        if (!isset($options['no-csv'])) {
            VT\Auth\Auth::setUser(VT\Auth\User::fromRow(
                Database::one("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1") ?? []
            ));
            $entries = VT\Repo\EntryRepo::allMatching(['order' => 'desc']);
            $csv = (new VT\Export\TimingsCsvExporter())->render($entries, ['user' => 'Ohne Titel']);
            $csvFile = $dir . '/vtimings-' . $stamp . '.csv';
            file_put_contents($csvFile, $csv);
            out('Export:     ' . basename($csvFile) . ' (' . count($entries) . ' Einträge)');
        }

        // Aufbewahrung: die letzten N Sicherungen behalten (Vorgabe 30).
        $keep = max(1, (int) ($options['keep'] ?? 30));
        foreach (['sqlite', 'csv'] as $extension) {
            $files = glob($dir . '/vtimings-*.' . $extension) ?: [];
            rsort($files);
            foreach (array_slice($files, $keep) as $old) {
                unlink($old);
                out('Entfernt:   ' . basename($old));
            }
        }
        break;

    case 'help':
    default:
        out('vTimings – Kommandos:');
        out('  install [--email= --password= --name=]   Schema anlegen und Administrator einrichten');
        out('  migrate                                  offene Migrationen anwenden');
        out('  status                                   Überblick');
        out('  user:add --email= --password= [--name= --role= --client= --no-costs]');
        out('  user:passwd --email= [--password=]');
        out('  user:list');
        out('  import --file= [--dry-run --duplicates=skip|import --alias="Alt=Neu"]');
        out('  backup [--keep=30 --no-csv]              Datenbankkopie + CSV-Dump');
        break;
}
