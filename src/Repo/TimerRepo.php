<?php
declare(strict_types=1);

namespace VT\Repo;

use VT\Auth\Auth;
use VT\Db\Database;
use VT\Http\HttpException;
use VT\Settings;
use VT\Support\Clock;

/**
 * Laufende Timer.
 *
 * Der Zustand liegt auf dem Server, nicht im Browser – deshalb sieht jedes
 * Gerät denselben laufenden Timer.
 *
 * Standardmäßig läuft nur einer. Beim Start eines zweiten meldet die API
 * einen Konflikt (409) mit den Daten des laufenden Timers zurück; erst mit
 * on_conflict=stop oder =parallel wird gehandelt.
 */
final class TimerRepo
{
    /** @return list<array<string,mixed>> */
    public static function running(): array
    {
        $user = Auth::require();

        $rows = Database::all(
            'SELECT t.* FROM timers t WHERE t.user_id = :user ORDER BY t.started_at',
            ['user' => $user->id]
        );

        return array_map([self::class, 'hydrate'], $rows);
    }

    public static function find(int $id, bool $orFail = false): ?array
    {
        $user = Auth::require();
        $row = Database::one(
            'SELECT * FROM timers WHERE id = :id AND user_id = :user',
            ['id' => $id, 'user' => $user->id]
        );
        if ($row === null && $orFail) {
            throw HttpException::notFound('Timer nicht gefunden.');
        }
        return $row === null ? null : self::hydrate($row);
    }

    /**
     * Startet einen Timer.
     *
     * @param string $onConflict 'ask' (Vorgabe) | 'stop' | 'parallel'
     * @return array{timer:array<string,mixed>, stopped:list<array<string,mixed>>}
     */
    public static function start(int $subprojectId, string $note = '', string $onConflict = 'ask', ?int $startedAt = null): array
    {
        $user = Auth::require();
        $sub = SubprojectRepo::findOrFail($subprojectId);

        $running = self::running();
        $stopped = [];

        if ($running !== []) {
            if ($onConflict === 'ask') {
                throw new HttpException(409, 'timer_running', 'Es läuft bereits ein Timer.', [
                    'running' => $running,
                    'choices' => [
                        'stop'     => 'Laufenden Timer stoppen und neuen starten',
                        'parallel' => 'Beide parallel laufen lassen',
                    ],
                ]);
            }
            if ($onConflict === 'stop') {
                foreach ($running as $timer) {
                    $result = self::stop($timer['id']);
                    if ($result['entry'] !== null) {
                        $stopped[] = $result['entry'];
                    }
                }
            } elseif ($onConflict !== 'parallel') {
                throw HttpException::badRequest('on_conflict muss ask, stop oder parallel sein.');
            }
        }

        $now = Clock::now();
        $id = Database::insert('timers', [
            'subproject_id' => $sub['id'],
            'user_id'       => $user->id,
            'started_at'    => $startedAt ?? $now,
            'note'          => $note,
            'created_at'    => $now,
        ]);

        return ['timer' => self::find($id, true), 'stopped' => $stopped];
    }

    /**
     * Stoppt einen Timer und legt daraus einen Eintrag an.
     *
     * Wird nach der Rundung eine Dauer von 0 Minuten daraus, entsteht kein
     * Eintrag – ein versehentlicher Klick soll die Liste nicht zumüllen.
     *
     * @return array{entry:array<string,mixed>|null, discarded:bool}
     */
    public static function stop(int $id, ?string $note = null, ?int $endedAt = null): array
    {
        $timer = self::find($id, true);
        $end = $endedAt ?? Clock::now();

        return Database::transaction(function () use ($timer, $note, $end): array {
            $start = Clock::fromIso($timer['started_at']);

            $roundedStart = Settings::roundTimestamp((int) $start);
            $roundedEnd = Settings::roundTimestamp($end);
            if ($roundedEnd < $roundedStart) {
                $roundedEnd = $roundedStart;
            }

            Database::run('DELETE FROM timers WHERE id = :id', ['id' => $timer['id']]);

            if ($roundedEnd === $roundedStart) {
                return ['entry' => null, 'discarded' => true];
            }

            $entryId = EntryRepo::create([
                'subproject_id' => $timer['subproject_id'],
                'started_at'    => $roundedStart,
                'ended_at'      => $roundedEnd,
                'note'          => $note ?? $timer['note'],
                'source'        => 'timer',
                'round'         => false, // schon gerundet
            ]);

            return ['entry' => EntryRepo::findOrFail($entryId), 'discarded' => false];
        });
    }

    /** @param array{subproject_id?:int, note?:string, started_at?:int} $data */
    public static function update(int $id, array $data): array
    {
        $timer = self::find($id, true);
        $fields = [];

        if (array_key_exists('subproject_id', $data)) {
            $sub = SubprojectRepo::findOrFail((int) $data['subproject_id']);
            $fields['subproject_id'] = $sub['id'];
        }
        if (array_key_exists('note', $data)) {
            $fields['note'] = (string) $data['note'];
        }
        if (array_key_exists('started_at', $data)) {
            $start = (int) $data['started_at'];
            if ($start > Clock::now() + 60) {
                throw HttpException::validation(['started_at' => 'Der Beginn darf nicht in der Zukunft liegen.']);
            }
            if ($start < Clock::now() - 86400 * 7) {
                throw HttpException::validation(['started_at' => 'Der Beginn liegt mehr als sieben Tage zurück.']);
            }
            $fields['started_at'] = $start;
        }

        if ($fields === []) {
            return $timer;
        }

        Database::update('timers', $id, $fields);
        return self::find($id, true);
    }

    /** Verwirft einen Timer, ohne einen Eintrag anzulegen. */
    public static function discard(int $id): void
    {
        $timer = self::find($id, true);
        Database::run('DELETE FROM timers WHERE id = :id', ['id' => $timer['id']]);
    }

    /** @param array<string,mixed> $row */
    private static function hydrate(array $row): array
    {
        $start = (int) $row['started_at'];
        $elapsed = max(0, Clock::now() - $start);
        $sub = SubprojectRepo::find((int) $row['subproject_id']);

        return [
            'id'              => (int) $row['id'],
            'subproject_id'   => (int) $row['subproject_id'],
            'subproject_name' => $sub['name'] ?? null,
            'project_id'      => $sub['project_id'] ?? null,
            'project_name'    => $sub['project_name'] ?? null,
            'client_id'       => $sub['client_id'] ?? null,
            'client_name'     => $sub['client_name'] ?? null,
            'color'           => $sub['color'] ?? null,
            'path'            => $sub['path'] ?? null,
            'rate'            => $sub['effective_rate'] ?? null,
            'started_at'      => Clock::iso($start),
            'start_time'      => Clock::format($start, 'H:i'),
            'note'            => (string) $row['note'],
            'elapsed_sec'     => $elapsed,
            'elapsed_min'     => intdiv($elapsed, 60),
            'elapsed_hhmm'    => Clock::hhmm(intdiv($elapsed, 60)),
        ];
    }
}
