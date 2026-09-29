<?php
declare(strict_types=1);

namespace VT\Report;

/**
 * Beschriftungen der Druckvorlagen in Deutsch, Englisch oder beidem
 * (`de-en`, für internationale Kunden). Zweisprachig steht Deutsch vorn,
 * Englisch dahinter bzw. darunter; Zahlen und Daten bleiben dann deutsch
 * formatiert (27.02.2026 liest man auch international).
 */
final class Translator
{
    public const LANGS = ['de', 'en', 'de-en'];

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
            'summary_effort' => 'Aufwand / Effort',
            // Bedienelemente der Druckansicht (Sprache der Oberfläche, nicht des Kunden)
            'ui_print'       => 'Drucken / als PDF sichern',
            'ui_summary'     => 'Zusammenfassung für die Rechnung',
            'ui_label'       => 'Bezeichnung',
            'ui_quantity'    => 'Menge (Stunden)',
            'ui_lines'       => 'Beschreibung',
            'ui_copy'        => 'Kopieren',
            'ui_copied'      => 'Kopiert',
            'ui_not_printed' => 'Wird nicht mitgedruckt.',
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
            'summary_effort' => 'Effort',
            'ui_print'       => 'Print / save as PDF',
            'ui_summary'     => 'Summary for the invoice',
            'ui_label'       => 'Title',
            'ui_quantity'    => 'Quantity (hours)',
            'ui_lines'       => 'Description',
            'ui_copy'        => 'Copy',
            'ui_copied'      => 'Copied',
            'ui_not_printed' => 'Not included in the printout.',
        ],
    ];

    /** Zweisprachig abweichende Texte, sonst "Deutsch / English". */
    private const BILINGUAL = [
        'summary_effort' => 'Aufwand / Effort',
    ];

    public function __construct(private readonly string $lang = 'de')
    {
    }

    /** Klartext, zweisprachig als "Deutsch / English". */
    public function __invoke(string $key): string
    {
        if ($this->bilingual()) {
            if (isset(self::BILINGUAL[$key])) {
                return self::BILINGUAL[$key];
            }
            [$de, $en] = $this->pair($key);
            return $en === null ? $de : $de . ' / ' . $en;
        }
        return $this->text($this->lang(), $key);
    }

    /**
     * Beschriftung als HTML (escaped). Zweisprachig in zwei Spans
     * (`.l-de`, `.l-en`), damit die Vorlage die englische Hälfte
     * zurückgenommen oder in eigener Zeile setzen kann.
     */
    public function label(string $key): string
    {
        $e = static fn(string $value): string => htmlspecialchars($value, ENT_QUOTES);
        if (!$this->bilingual()) {
            return $e($this($key));
        }
        [$de, $en] = $this->pair($key);
        return $en === null
            ? '<span class="l-de">' . $e($de) . '</span>'
            : '<span class="l-de">' . $e($de) . '</span><span class="l-en">' . $e($en) . '</span>';
    }

    /** Nur die erste Sprache – für Dateinamen und Ähnliches. */
    public function primary(string $key): string
    {
        return $this->text($this->bilingual() ? 'de' : $this->lang(), $key);
    }

    public function lang(): string
    {
        return in_array($this->lang, self::LANGS, true) ? $this->lang : 'de';
    }

    public function bilingual(): bool
    {
        return $this->lang() === 'de-en';
    }

    /** Wert für `<html lang>`. */
    public function htmlLang(): string
    {
        return $this->bilingual() ? 'de' : $this->lang();
    }

    private function text(string $lang, string $key): string
    {
        return self::STRINGS[$lang][$key] ?? self::STRINGS['de'][$key] ?? $key;
    }

    /** @return array{0:string,1:?string} Englisch null, wenn gleichlautend */
    private function pair(string $key): array
    {
        $de = $this->text('de', $key);
        $en = $this->text('en', $key);
        return [$de, $en === $de ? null : $en];
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
