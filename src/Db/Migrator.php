<?php
declare(strict_types=1);

namespace VT\Db;

/**
 * Migrationen aus migrations/NNNN_name.sql, verfolgt über PRAGMA user_version.
 * Jede Datei läuft in einer eigenen Transaktion – bricht eine ab, bleibt der
 * Stand davor konsistent.
 */
final class Migrator
{
    public static function dir(): string
    {
        return VT_ROOT . '/migrations';
    }

    public static function currentVersion(): int
    {
        return (int) Database::value('PRAGMA user_version');
    }

    /** @return list<array{version:int,name:string,file:string}> */
    public static function available(): array
    {
        $out = [];
        foreach (glob(self::dir() . '/*.sql') ?: [] as $file) {
            $base = basename($file, '.sql');
            if (!preg_match('/^(\d+)_(.+)$/', $base, $m)) {
                continue;
            }
            $out[] = ['version' => (int) $m[1], 'name' => $m[2], 'file' => $file];
        }
        usort($out, static fn($a, $b) => $a['version'] <=> $b['version']);
        return $out;
    }

    /** @return list<array{version:int,name:string,file:string}> */
    public static function pending(): array
    {
        $current = self::currentVersion();
        return array_values(array_filter(
            self::available(),
            static fn($m) => $m['version'] > $current
        ));
    }

    /**
     * Wendet alle offenen Migrationen an.
     *
     * @return list<string> Namen der angewandten Migrationen
     */
    public static function migrate(?callable $onStep = null): array
    {
        $applied = [];
        foreach (self::pending() as $migration) {
            $sql = file_get_contents($migration['file']);
            if ($sql === false) {
                throw new \RuntimeException('Migration nicht lesbar: ' . $migration['file']);
            }

            $pdo = Database::pdo();
            // PRAGMA user_version verträgt keine Parameterbindung.
            $pdo->beginTransaction();
            try {
                $pdo->exec($sql);
                $pdo->exec('PRAGMA user_version = ' . $migration['version']);
                $pdo->commit();
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw new \RuntimeException(
                    sprintf('Migration %04d_%s fehlgeschlagen: %s', $migration['version'], $migration['name'], $e->getMessage()),
                    0,
                    $e
                );
            }

            $label = sprintf('%04d_%s', $migration['version'], $migration['name']);
            $applied[] = $label;
            if ($onStep) {
                $onStep($label);
            }
        }
        return $applied;
    }
}
