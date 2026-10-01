<?php
declare(strict_types=1);

namespace VT\Controller;

use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Response;
use VT\Http\Router;
use VT\Repo\EntryRepo;
use VT\Repo\TimerRepo;
use VT\Support\Clock;
use VT\Support\Validator;

final class EntryController
{
    public static function register(Router $r): void
    {
        $r->get('/api/entries', [self::class, 'index'], ['auth' => 'user']);
        $r->get('/api/entries/recent', [self::class, 'recent'], ['auth' => 'user']);
        $r->get('/api/entries/{id}', [self::class, 'show'], ['auth' => 'user']);
        $r->post('/api/entries', [self::class, 'store']);
        $r->post('/api/entries/batch', [self::class, 'batch']);
        $r->post('/api/entries/batch/remove', [self::class, 'batchRemove']);
        $r->patch('/api/entries/{id}', [self::class, 'update']);
        $r->delete('/api/entries/{id}', [self::class, 'destroy']);
        $r->post('/api/entries/{id}/restore', [self::class, 'restore']);
        $r->delete('/api/entries/{id}/purge', [self::class, 'purge']);

        $r->get('/api/timer', [self::class, 'timers'], ['auth' => 'user']);
        $r->post('/api/timer/start', [self::class, 'startTimer']);
        $r->post('/api/timer/{id}/stop', [self::class, 'stopTimer']);
        $r->patch('/api/timer/{id}', [self::class, 'updateTimer']);
        $r->delete('/api/timer/{id}', [self::class, 'discardTimer']);
    }

    // -- Einträge -----------------------------------------------------------

    public static function index(Request $req): array
    {
        $opts = self::filters($req);

        return ($req->query['group'] ?? '') === 'day'
            ? EntryRepo::listByDay($opts)
            : EntryRepo::list($opts);
    }

    public static function show(Request $req): array
    {
        return ['entry' => EntryRepo::findOrFail(self::id($req))];
    }

    public static function recent(Request $req): array
    {
        $limit = (int) ($req->query['limit'] ?? \VT\Settings::int('recent_limit', 10));
        return ['subprojects' => EntryRepo::recentSubprojects($limit)];
    }

    public static function store(Request $req): Response
    {
        $v = new Validator($req->body);
        $subprojectId = $v->int('subproject_id', true, 1);
        $start = $v->timestamp('started_at', true);
        $end = $v->timestamp('ended_at', false);
        $durationMin = $v->int('duration_min', false, 0, 60 * 24 * 7);
        $note = $v->string('note', false, 20000, '');
        $internalNote = $v->string('internal_note', false, 20000, '');
        $type = $v->enum('type', ['time', 'expense'], false, 'time');
        $billable = $v->bool('billable', true);
        $round = $v->bool('round', true);
        $rate = $v->has('rate') ? $v->float('rate', false, 0, 100000) : null;
        $billed = $v->bool('billed', false);

        if ($end === null && $durationMin === null) {
            $v->fail('ended_at', 'Ende oder Dauer angeben.');
        }
        $v->validate();

        $end ??= (int) $start + (int) $durationMin * 60;

        $id = EntryRepo::create([
            'subproject_id' => (int) $subprojectId,
            'started_at'    => (int) $start,
            'ended_at'      => $end,
            'note'          => (string) $note,
            'internal_note' => (string) $internalNote,
            'type'          => (string) $type,
            'billable'      => (bool) $billable,
            'round'         => (bool) $round,
            'rate'          => $rate,
            'billed'        => (bool) $billed,
            'source'        => 'manual',
        ]);

        $entry = EntryRepo::findOrFail($id);
        $overlaps = EntryRepo::overlapping(
            (int) Clock::fromIso($entry['started_at']),
            (int) Clock::fromIso($entry['ended_at']),
            $id
        );

        return Response::json([
            'entry'    => $entry,
            // Überlappungen sind erlaubt (kam in 21 Jahren 1.411-mal vor),
            // werden aber gemeldet, damit man sie nicht übersieht.
            'overlaps' => $overlaps,
        ], 201);
    }

    public static function update(Request $req): array
    {
        $v = new Validator($req->body);
        $data = [];

        if ($v->has('subproject_id')) {
            $data['subproject_id'] = $v->int('subproject_id', true, 1);
        }
        if ($v->has('started_at')) {
            $data['started_at'] = $v->timestamp('started_at', true);
        }
        if ($v->has('ended_at')) {
            $data['ended_at'] = $v->timestamp('ended_at', true);
        }
        if ($v->has('note')) {
            $data['note'] = $v->string('note', false, 20000, '');
        }
        if ($v->has('internal_note')) {
            $data['internal_note'] = $v->string('internal_note', false, 20000, '');
        }
        if ($v->has('billable')) {
            $data['billable'] = $v->bool('billable', true);
        }
        if ($v->has('type')) {
            $data['type'] = $v->enum('type', ['time', 'expense'], true);
        }
        if ($v->has('rate')) {
            $raw = $req->body['rate'];
            $data['rate'] = ($raw === null || $raw === '') ? null : $v->float('rate', false, 0, 100000);
        }
        if ($v->has('round')) {
            $data['round'] = $v->bool('round', false);
        }
        if ($v->has('billed')) {
            $data['billed'] = $v->bool('billed', false);
        }
        $v->validate();

        if ($data === []) {
            throw HttpException::badRequest('Keine Änderungen übergeben.');
        }

        return ['entry' => EntryRepo::update(self::id($req), $data)];
    }

    /**
     * Sammelbearbeitung. `rate_mode`: keep = Satz behalten, inherit = aus
     * der Stammdaten-Hierarchie (ggf. des neuen Teilprojekts) übernehmen,
     * fixed = `rate` für alle setzen. `billed`: true = abrechnen,
     * false = wieder öffnen. `internal_note` (+ `internal_note_mode`
     * replace|append) setzt die interne Notiz, auch an abgerechneten Einträgen.
     */
    public static function batch(Request $req): array
    {
        // Nur was sich sinnvoll für viele Einträge gleichzeitig setzen lässt.
        $allowed = ['ids', 'subproject_id', 'rate_mode', 'rate', 'billable', 'billed', 'internal_note', 'internal_note_mode'];
        $unknown = array_diff(array_keys($req->body), $allowed);
        if ($unknown !== []) {
            throw HttpException::badRequest(
                'Im Sammelbearbeiten nicht änderbar: ' . implode(', ', $unknown)
            );
        }

        $v = new Validator($req->body);
        $ids = $req->body['ids'] ?? null;
        if (!is_array($ids) || $ids === [] || count($ids) > 1000) {
            $v->fail('ids', 'Zwischen 1 und 1000 Einträge auswählen.');
        } elseif (array_filter($ids, static fn($id) => !is_int($id) && !(is_string($id) && ctype_digit($id))) !== []) {
            $v->fail('ids', 'Ungültige Eintrags-IDs.');
        }

        $data = [];
        if ($v->has('subproject_id')) {
            $data['subproject_id'] = $v->int('subproject_id', true, 1);
        }
        $rateMode = $v->enum('rate_mode', ['keep', 'inherit', 'fixed'], false, 'keep');
        if ($rateMode === 'fixed') {
            $data['rate'] = $v->float('rate', true, 0, 100000);
        } elseif ($rateMode === 'inherit') {
            $data['rate'] = null;
        }
        if ($v->has('billable')) {
            $data['billable'] = $v->bool('billable', true);
        }
        // Interne Notiz: ersetzen (leer = löschen) oder anhängen. Gilt auch für
        // abgerechnete Einträge.
        if ($v->has('internal_note')) {
            $data['internal_note'] = $v->string('internal_note', false, 20000, '');
            $data['internal_note_mode'] = $v->enum('internal_note_mode', ['replace', 'append'], false, 'replace');
        }
        // Status: true = abgerechnet, false = offen, fehlt = unverändert.
        $billed = $v->has('billed') ? $v->bool('billed', null) : null;
        $v->validate();

        if ($data === [] && $billed === null) {
            throw HttpException::badRequest('Keine Änderungen übergeben.');
        }

        return EntryRepo::batchUpdate(array_map('intval', $ids), $data, $billed);
    }

    /**
     * Mehrere Einträge auf einmal in den Papierkorb legen, wiederherstellen
     * oder endgültig löschen. `action`: trash | restore | purge.
     */
    public static function batchRemove(Request $req): array
    {
        $unknown = array_diff(array_keys($req->body), ['ids', 'action']);
        if ($unknown !== []) {
            throw HttpException::badRequest('Unbekannte Angaben: ' . implode(', ', $unknown));
        }

        $v = new Validator($req->body);
        $ids = $req->body['ids'] ?? null;
        if (!is_array($ids) || $ids === [] || count($ids) > 1000) {
            $v->fail('ids', 'Zwischen 1 und 1000 Einträge auswählen.');
        } elseif (array_filter($ids, static fn($id) => !is_int($id) && !(is_string($id) && ctype_digit($id))) !== []) {
            $v->fail('ids', 'Ungültige Eintrags-IDs.');
        }
        $action = $v->enum('action', ['trash', 'restore', 'purge'], true);
        $v->validate();

        return EntryRepo::batchRemove(array_map('intval', $ids), (string) $action);
    }

    public static function destroy(Request $req): array
    {
        EntryRepo::delete(self::id($req));
        return ['ok' => true];
    }

    public static function restore(Request $req): array
    {
        return ['entry' => EntryRepo::restore(self::id($req))];
    }

    public static function purge(Request $req): array
    {
        EntryRepo::purge(self::id($req));
        return ['ok' => true];
    }

    // -- Timer --------------------------------------------------------------

    public static function timers(): array
    {
        return ['timers' => TimerRepo::running()];
    }

    public static function startTimer(Request $req): Response
    {
        $v = new Validator($req->body);
        $subprojectId = $v->int('subproject_id', true, 1);
        $note = $v->string('note', false, 20000, '');
        $onConflict = $v->enum('on_conflict', ['ask', 'stop', 'parallel'], false, 'ask');
        $startedAt = $v->has('started_at') ? $v->timestamp('started_at', false) : null;
        $v->validate();

        $result = TimerRepo::start(
            (int) $subprojectId,
            (string) $note,
            (string) $onConflict,
            $startedAt
        );

        return Response::json($result, 201);
    }

    public static function stopTimer(Request $req): array
    {
        $v = new Validator($req->body);
        $note = $v->has('note') ? $v->string('note', false, 20000, '') : null;
        $endedAt = $v->has('ended_at') ? $v->timestamp('ended_at', false) : null;
        $v->validate();

        return TimerRepo::stop(self::id($req), $note, $endedAt);
    }

    public static function updateTimer(Request $req): array
    {
        $v = new Validator($req->body);
        $data = [];

        if ($v->has('subproject_id')) {
            $data['subproject_id'] = $v->int('subproject_id', true, 1);
        }
        if ($v->has('note')) {
            $data['note'] = $v->string('note', false, 20000, '');
        }
        if ($v->has('started_at')) {
            $data['started_at'] = $v->timestamp('started_at', true);
        }
        $v->validate();

        return ['timer' => TimerRepo::update(self::id($req), $data)];
    }

    public static function discardTimer(Request $req): array
    {
        TimerRepo::discard(self::id($req));
        return ['ok' => true];
    }

    // -- Hilfen -------------------------------------------------------------

    /** @return array<string,mixed> */
    private static function filters(Request $req): array
    {
        $q = $req->query;

        return [
            'from'          => $q['from'] ?? null,
            'to'            => $q['to'] ?? null,
            'client_id'     => self::idList($q['client_id'] ?? null, 'client_id'),
            'project_id'    => self::idList($q['project_id'] ?? null, 'project_id'),
            'subproject_id' => isset($q['subproject_id']) ? (int) $q['subproject_id'] : null,
            'q'             => (string) ($q['q'] ?? ''),
            'billed'        => self::tribool($q['billed'] ?? null),
            'uncovered'     => self::tribool($q['uncovered'] ?? null) === true,
            'archived'      => self::tribool($q['archived'] ?? null),
            'billable'      => self::tribool($q['billable'] ?? null),
            'type'          => $q['type'] ?? null,
            'trashed'       => (string) ($q['trashed'] ?? '0') === '1',
            'limit'         => isset($q['limit']) ? (int) $q['limit'] : 200,
            'offset'        => isset($q['offset']) ? (int) $q['offset'] : 0,
            'order'         => (string) ($q['order'] ?? 'desc'),
        ];
    }

    /** `client_id=3` oder `client_id=3,5` -> Liste (null = kein Filter). */
    private static function idList(mixed $raw, string $name): ?array
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        if (!is_string($raw) || !preg_match('/^\d+(,\d+)*$/', $raw)) {
            throw HttpException::badRequest("Ungültige Angabe für $name.");
        }
        $ids = array_values(array_unique(array_map('intval', explode(',', $raw))));
        return count($ids) > 200 ? throw HttpException::badRequest("Zu viele Werte für $name.") : $ids;
    }

    private static function tribool(mixed $value): ?bool
    {
        if ($value === null || $value === '') {
            return null;
        }
        return in_array((string) $value, ['1', 'true', 'yes'], true);
    }

    private static function id(Request $req): int
    {
        $id = $req->param('id');
        if ($id === null || !ctype_digit($id)) {
            throw HttpException::badRequest('Ungültige ID.');
        }
        return (int) $id;
    }
}
