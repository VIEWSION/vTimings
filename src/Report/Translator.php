<?php
declare(strict_types=1);

namespace VT\Report;

/** Beschriftungen der Druckvorlagen in Deutsch und Englisch. */
final class Translator
{
    private const STRINGS = [
        'de' => [
            'title'          => 'Leistungsnachweis',
            'customer'       => 'Kunde',
            'project'        => 'Projekt',
            'projects'       => 'Projekte',
            'period'         => 'Zeitraum',
            'effort'         => 'Aufwand',
            'listing'        => 'Aufstellung',
            'date'           => 'Datum',
            'time'           => 'Uhrzeit',
            'description'    => 'Leistung',
            'duration'       => 'Dauer',
            'rate'           => 'Satz',
            'amount'         => 'Betrag',
            'total'          => 'Gesamt',
            'total_hours'    => 'Stunden',
            'net'            => 'Summe netto',
            'entries'        => 'Einträge',
            'page'           => 'Seite',
            'created'        => 'Erstellt am',
            'all_projects'   => 'Alle Projekte',
            'no_notes'       => 'ohne Beschreibung',
        ],
        'en' => [
            'title'          => 'Statement of Work',
            'customer'       => 'Customer',
            'project'        => 'Project',
            'projects'       => 'Projects',
            'period'         => 'Period',
            'effort'         => 'Effort',
            'listing'        => 'Time log',
            'date'           => 'Date',
            'time'           => 'Time',
            'description'    => 'Description',
            'duration'       => 'Duration',
            'rate'           => 'Rate',
            'amount'         => 'Amount',
            'total'          => 'Total',
            'total_hours'    => 'hours',
            'net'            => 'Total net',
            'entries'        => 'entries',
            'page'           => 'Page',
            'created'        => 'Created on',
            'all_projects'   => 'All projects',
            'no_notes'       => 'no description',
        ],
    ];

    public function __construct(private readonly string $lang = 'de')
    {
    }

    public function __invoke(string $key): string
    {
        $lang = isset(self::STRINGS[$this->lang]) ? $this->lang : 'de';
        return self::STRINGS[$lang][$key] ?? self::STRINGS['de'][$key] ?? $key;
    }

    public function lang(): string
    {
        return isset(self::STRINGS[$this->lang]) ? $this->lang : 'de';
    }

    /** Datumsformat der jeweiligen Sprache. */
    public function dateFormat(): string
    {
        return $this->lang() === 'en' ? 'd/m/Y' : 'd.m.Y';
    }

    public function number(float $value, int $decimals = 2): string
    {
        return $this->lang() === 'en'
            ? number_format($value, $decimals, '.', ',')
            : number_format($value, $decimals, ',', '.');
    }

    public function money(float $value, string $currency = 'EUR'): string
    {
        $symbol = $currency === 'EUR' ? '€' : $currency;
        return $this->number($value) . ' ' . $symbol;
    }
}
