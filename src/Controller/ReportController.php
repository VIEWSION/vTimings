<?php
declare(strict_types=1);

namespace VT\Controller;

use VT\Export\Registry;
use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Response;
use VT\Http\Router;
use VT\Report\ReportBuilder;
use VT\Report\Renderer;
use VT\Repo\EntryRepo;
use VT\Support\Clock;

final class ReportController
{
    public static function register(Router $r): void
    {
        $r->get('/api/stats', [self::class, 'stats'], ['auth' => 'user']);
        $r->get('/api/export/formats', [self::class, 'formats'], ['auth' => 'user']);
        $r->get('/api/export', [self::class, 'export'], ['auth' => 'user']);
        $r->get('/api/report/templates', [self::class, 'templates'], ['auth' => 'user']);

        // Der Ausdruck ist eine ganze Seite, keine JSON-Antwort.
        $r->get('/report', [self::class, 'report'], ['auth' => 'user']);
    }

    /** Summen, gruppiert nach Kunde/Projekt/Teilprojekt/Tag/Woche/Monat/Jahr. */
    public static function stats(Request $req): array
    {
        $by = (string) ($req->query['group_by'] ?? 'client');
        $filters = self::filters($req);

        $groups = EntryRepo::grouped($filters, $by);

        $minutes = array_sum(array_column($groups, 'minutes'));
        $entries = array_sum(array_column($groups, 'entries'));

        $totals = [
            'minutes' => $minutes,
            'hhmm'    => Clock::hhmm($minutes),
            'decimal' => Clock::decimal($minutes),
            'entries' => $entries,
        ];
        if (\VT\Repo\Scope::current()->showCosts) {
            $totals['amount'] = round(array_sum(array_map(static fn($g) => $g['amount'] ?? 0, $groups)), 2);
        }

        return ['group_by' => $by, 'groups' => $groups, 'totals' => $totals];
    }

    public static function formats(): array
    {
        return ['formats' => Registry::all()];
    }

    public static function templates(): array
    {
        return ['templates' => Renderer::templates()];
    }

    public static function export(Request $req): Response
    {
        $format = (string) ($req->query['format'] ?? 'timings-csv');
        $exporter = Registry::get($format);

        $filters = self::filters($req);
        $entries = EntryRepo::allMatching($filters + ['order' => 'desc']);

        if ($entries === []) {
            throw HttpException::notFound('Im gewählten Zeitraum gibt es nichts zu exportieren.');
        }

        $minutes = array_sum(array_column($entries, 'duration_min'));
        $body = $exporter->render($entries, [
            'filters'      => $filters,
            'generated_at' => Clock::iso(Clock::now()),
            'user'         => \VT\Auth\Auth::require()->name,
            'totals'       => [
                'entries' => count($entries),
                'minutes' => $minutes,
                'hhmm'    => Clock::hhmm($minutes),
                'decimal' => Clock::decimal($minutes),
                'amount'  => round(array_sum(array_map(static fn($e) => $e['amount'] ?? 0, $entries)), 2),
            ],
        ]);

        return Response::download(
            $body,
            self::filename($entries, $filters, $exporter::extension()),
            $exporter::mimeType()
        );
    }

    /** Druckfertiger Leistungsnachweis als HTML-Seite. */
    public static function report(Request $req): Response
    {
        $template = (string) ($req->query['template'] ?? 'leistungsnachweis');

        $report = ReportBuilder::build(self::filters($req), [
            'costs'      => self::flag($req, 'costs', false),
            'group_days' => self::flag($req, 'group_days', false),
            'times'      => self::flag($req, 'times', false),
            'notes'      => self::flag($req, 'notes', true),
            'logo'       => self::flag($req, 'logo', true),
            'lang'       => $req->query['lang'] ?? null,
        ]);

        return Response::html(Renderer::render($template, $report));
    }

    // -- Hilfen -------------------------------------------------------------

    /** @return array<string,mixed> */
    private static function filters(Request $req): array
    {
        $q = $req->query;

        return array_filter([
            'from'          => $q['from'] ?? null,
            'to'            => $q['to'] ?? null,
            'client_id'     => isset($q['client_id']) ? (int) $q['client_id'] : null,
            'project_id'    => isset($q['project_id']) ? (int) $q['project_id'] : null,
            'subproject_id' => isset($q['subproject_id']) ? (int) $q['subproject_id'] : null,
            'q'             => $q['q'] ?? null,
            'billed'        => isset($q['billed']) && $q['billed'] !== ''
                ? in_array((string) $q['billed'], ['1', 'true'], true) : null,
            'billable'      => isset($q['billable']) && $q['billable'] !== ''
                ? in_array((string) $q['billable'], ['1', 'true'], true) : null,
            'type'          => $q['type'] ?? null,
            'ids'           => self::ids($q['ids'] ?? null),
        ], static fn($value) => $value !== null && $value !== '');
    }

    /**
     * Angehakte Einträge als kommagetrennte Liste (`ids=12,15,19`). Kommt als
     * GET, weil Druckansicht und Download in einem neuen Tab bzw. als
     * Navigation öffnen – daher die Obergrenze, damit die URL nicht an
     * Server-Limits stößt.
     *
     * @return list<int>|null
     */
    private static function ids(mixed $raw): ?array
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        if (!is_string($raw) || !preg_match('/^\d+(,\d+)*$/', $raw)) {
            throw HttpException::badRequest('Ungültige Auswahl.');
        }
        $ids = array_values(array_unique(array_map('intval', explode(',', $raw))));
        if (count($ids) > 1000) {
            throw HttpException::badRequest('Höchstens 1000 Einträge auf einmal.');
        }
        return $ids;
    }

    private static function flag(Request $req, string $name, bool $default): bool
    {
        if (!isset($req->query[$name]) || $req->query[$name] === '') {
            return $default;
        }
        return in_array((string) $req->query[$name], ['1', 'true', 'yes', 'on'], true);
    }

    /** Sprechender Dateiname im Stil der bisherigen Exporte. */
    private static function filename(array $entries, array $filters, string $extension): string
    {
        $clients = array_unique(array_column($entries, 'client_name'));
        $projects = array_unique(array_column($entries, 'project_name'));

        $parts = ['vTimings'];
        if (count($clients) === 1) {
            $parts[] = reset($clients);
        }
        if (count($projects) === 1) {
            $parts[] = reset($projects);
        }

        $first = (int) Clock::fromIso($entries[count($entries) - 1]['started_at']);
        $last = (int) Clock::fromIso($entries[0]['started_at']);
        $parts[] = Clock::format(min($first, $last), 'Y-m-d') . '_' . Clock::format(max($first, $last), 'Y-m-d');

        $name = implode(' - ', array_map(
            static fn(string $part) => trim(preg_replace('/[\/\\\\:*?"<>|]+/', '-', $part) ?? $part),
            $parts
        ));

        return $name . '.' . $extension;
    }
}
