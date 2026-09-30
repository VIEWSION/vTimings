<?php
declare(strict_types=1);

namespace VT\Report;

use VT\Db\Database;
use VT\Http\HttpException;
use VT\Repo\ClientRepo;
use VT\Repo\EntryRepo;
use VT\Repo\ProjectRepo;
use VT\Repo\Scope;
use VT\Support\Clock;

/**
 * Baut aus Filtern und Optionen ein fertiges Anzeigemodell für die
 * Druckvorlagen. Die Vorlagen selbst enthalten deshalb keine Logik –
 * nur Auszeichnung.
 */
final class ReportBuilder
{
    public const OPTIONS = [
        'costs'       => false,  // Sätze und Beträge ausweisen
        'group_days'  => false,  // Einträge eines Tages zusammenfassen
        'times'       => false,  // Uhrzeiten statt nur Dauer
        'notes'       => true,   // Notizen ausgeben
        'logo'        => true,   // Briefkopf
        'lang'        => null,   // de, en, de-en; null = Sprache des Kunden
    ];

    /**
     * @param array<string,mixed> $filters Zeitraum und Auswahl wie bei /api/entries
     * @param array<string,mixed> $options siehe OPTIONS
     */
    public static function build(array $filters, array $options = []): array
    {
        $options = array_merge(self::OPTIONS, array_intersect_key($options, self::OPTIONS));

        $entries = EntryRepo::allMatching($filters + ['order' => 'asc']);
        if ($entries === []) {
            throw HttpException::notFound('Im gewählten Zeitraum gibt es keine Einträge.');
        }

        $showCosts = $options['costs'] && Scope::current()->showCosts;

        // Bei Mehrfachauswahl gibt es keinen einzelnen Kunden/ein einzelnes Projekt.
        $pickedClients = array_values(array_filter((array) ($filters['client_id'] ?? [])));
        $pickedProjects = array_values(array_filter((array) ($filters['project_id'] ?? [])));
        $client = count($pickedClients) === 1 ? ClientRepo::find((int) $pickedClients[0]) : null;
        $project = count($pickedProjects) === 1 ? ProjectRepo::find((int) $pickedProjects[0]) : null;

        // Ohne ausdrückliche Auswahl aus den Einträgen ableiten – ein Nachweis
        // über genau einen Kunden bekommt so trotzdem dessen Kopfdaten.
        $clientIds = array_unique(array_column($entries, 'client_id'));
        $projectIds = array_unique(array_column($entries, 'project_id'));
        if ($client === null && count($clientIds) === 1) {
            $client = ClientRepo::find((int) reset($clientIds));
        }
        if ($project === null && count($projectIds) === 1) {
            $project = ProjectRepo::find((int) reset($projectIds));
        }

        $lang = $options['lang'] ?? ($client['lang'] ?? 'de');
        $lang = in_array($lang, Translator::LANGS, true) ? $lang : 'de';

        $rows = $options['group_days']
            ? self::groupByDay($entries, count($projectIds) > 1)
            : self::plainRows($entries, count($projectIds) > 1);

        $minutes = array_sum(array_column($entries, 'duration_min'));
        $amount = $showCosts ? array_sum(array_map(static fn($e) => $e['amount'] ?? 0, $entries)) : null;

        $firstStart = (int) Clock::fromIso($entries[0]['started_at']);
        $lastStart = (int) Clock::fromIso($entries[count($entries) - 1]['started_at']);

        $summary = self::summary(
            self::groupByDay($entries, count($projectIds) > 1),
            Clock::format($firstStart, 'd.m.Y'),
            Clock::format($lastStart, 'd.m.Y'),
            $minutes,
            new Translator($lang)
        );

        return [
            'client'   => $client,
            'project'  => $project,
            'lang'     => $lang,
            'options'  => $options + ['costs' => $showCosts],
            'rows'     => $rows,
            'entries'  => $entries,
            'period'   => [
                'from'       => $filters['from'] ?? Clock::day($firstStart),
                'to'         => $filters['to'] ?? Clock::day($lastStart),
                'first_at'   => Clock::iso($firstStart),
                'last_at'    => Clock::iso($lastStart),
                'first_date' => Clock::format($firstStart, 'd.m.Y'),
                'last_date'  => Clock::format($lastStart, 'd.m.Y'),
            ],
            'totals'   => [
                'entries' => count($entries),
                'minutes' => $minutes,
                'hhmm'    => Clock::hhmm($minutes),
                'decimal' => Clock::decimal($minutes),
                'amount'  => $amount === null ? null : round($amount, 2),
                'rates'   => $showCosts ? array_values(array_unique(array_column($entries, 'rate'))) : [],
            ],
            'summary'  => $summary,
            'issuer'   => self::issuer(),
            'meta'     => [
                'generated_at' => Clock::iso(Clock::now()),
                'currency'     => $client['currency'] ?? 'EUR',
                'multi_client' => count($clientIds) > 1,
                'multi_project'=> count($projectIds) > 1,
            ],
        ];
    }

    /** @param list<array<string,mixed>> $entries */
    private static function plainRows(array $entries, bool $withProject): array
    {
        return array_map(static fn(array $entry) => [
            'date'       => $entry['date'],
            'date_label' => Clock::format((int) Clock::fromIso($entry['started_at']), 'd.m.Y'),
            'start'      => $entry['start_time'],
            'end'        => $entry['end_time'],
            'hhmm'       => $entry['hhmm'],
            'decimal'    => $entry['decimal'],
            'minutes'    => $entry['duration_min'],
            'title'      => $withProject
                ? $entry['project_name'] . ' – ' . $entry['subproject_name']
                : $entry['subproject_name'],
            'note'       => $entry['note'],
            'rate'       => $entry['rate'] ?? null,
            'amount'     => $entry['amount'] ?? null,
            'overnight'  => $entry['overnight'],
            'count'      => 1,
        ], $entries);
    }

    /**
     * Fasst alle Einträge eines Tages (je Teilprojekt) zu einer Zeile zusammen
     * und führt die Notizen zusammen.
     *
     * @param list<array<string,mixed>> $entries
     */
    private static function groupByDay(array $entries, bool $withProject): array
    {
        $groups = [];

        foreach ($entries as $entry) {
            $key = $entry['date'] . "\0" . $entry['subproject_id'];

            if (!isset($groups[$key])) {
                $groups[$key] = [
                    'date'       => $entry['date'],
                    'date_label' => Clock::format((int) Clock::fromIso($entry['started_at']), 'd.m.Y'),
                    'start'      => $entry['start_time'],
                    'end'        => $entry['end_time'],
                    'minutes'    => 0,
                    'title'      => $withProject
                        ? $entry['project_name'] . ' – ' . $entry['subproject_name']
                        : $entry['subproject_name'],
                    'notes'      => [],
                    'rate'       => $entry['rate'] ?? null,
                    'amount'     => 0.0,
                    'count'      => 0,
                    'overnight'  => false,
                ];
            }

            $group = &$groups[$key];
            $group['minutes'] += $entry['duration_min'];
            $group['amount']  += $entry['amount'] ?? 0;
            $group['count']++;
            $group['end'] = $entry['end_time'];
            $group['overnight'] = $group['overnight'] || $entry['overnight'];
            if (trim((string) $entry['note']) !== '') {
                $group['notes'][] = trim((string) $entry['note']);
            }
            unset($group);
        }

        return array_map(static function (array $group): array {
            $group['hhmm'] = Clock::hhmm($group['minutes']);
            $group['decimal'] = Clock::decimal($group['minutes']);
            // Doppelte Stichpunkte eines Tages nur einmal ausgeben.
            $group['note'] = implode("\n", array_values(array_unique($group['notes'])));
            $group['amount'] = round($group['amount'], 2);
            unset($group['notes']);
            return $group;
        }, array_values($groups));
    }

    /**
     * Kurzfassung für die Rechnungsposition (zum Kopieren in die
     * Buchhaltung): eine Bezeichnung mit Zeitraum und Gesamtdauer, die Menge
     * in Stunden und je Tag und Teilprojekt eine Zeile.
     *
     * Die Menge steht immer mit Dezimalkomma und ohne Tausenderpunkt – sie
     * landet in einer deutschen Buchhaltung, unabhängig von der Sprache des
     * Nachweises.
     *
     * @param list<array<string,mixed>> $days Ergebnis von groupByDay()
     */
    private static function summary(array $days, string $from, string $to, int $minutes, Translator $t): array
    {
        return [
            'label'    => sprintf('%s - %s %s - %s', $from, $to, Clock::hhmm($minutes), $t('summary_effort')),
            'quantity' => number_format(Clock::decimal($minutes), 2, ',', ''),
            'lines'    => implode("\n", array_map(
                static fn(array $day) => sprintf('%s - %s - %s', $day['date_label'], $day['hhmm'], $day['title']),
                $days
            )),
        ];
    }

    /** Absenderdaten aus den Einstellungen. */
    private static function issuer(): array
    {
        $keys = ['issuer_name', 'issuer_address', 'issuer_contact', 'issuer_footer', 'issuer_logo'];
        $out = [];
        foreach ($keys as $key) {
            $out[substr($key, 7)] = (string) Database::value(
                'SELECT value FROM settings WHERE key = :k',
                ['k' => $key]
            );
        }
        return $out;
    }
}
