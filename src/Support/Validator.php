<?php
declare(strict_types=1);

namespace VT\Support;

use VT\Http\HttpException;

/**
 * Sehr schlanke Eingabeprüfung. Sammelt alle Fehler und wirft am Ende
 * eine 422 mit Feldliste, damit das Frontend sie direkt anzeigen kann.
 */
final class Validator
{
    /** @var array<string,string> */
    private array $errors = [];
    /** @var array<string,mixed> */
    private array $clean = [];

    public function __construct(private readonly array $data)
    {
    }

    public function has(string $field): bool
    {
        return array_key_exists($field, $this->data);
    }

    public function raw(string $field): mixed
    {
        return $this->data[$field] ?? null;
    }

    public function string(string $field, bool $required = false, int $max = 5000, string $default = ''): ?string
    {
        if (!$this->has($field)) {
            if ($required) {
                $this->errors[$field] = 'Pflichtfeld.';
                return null;
            }
            return $default;
        }
        $value = $this->data[$field];
        if ($value === null) {
            if ($required) {
                $this->errors[$field] = 'Pflichtfeld.';
            }
            return null;
        }
        if (!is_scalar($value)) {
            $this->errors[$field] = 'Text erwartet.';
            return null;
        }
        $value = trim((string) $value);
        if ($required && $value === '') {
            $this->errors[$field] = 'Pflichtfeld.';
            return null;
        }
        if (mb_strlen($value) > $max) {
            $this->errors[$field] = "Höchstens $max Zeichen.";
            return null;
        }
        return $this->clean[$field] = $value;
    }

    public function int(string $field, bool $required = false, ?int $min = null, ?int $max = null): ?int
    {
        if (!$this->has($field) || $this->data[$field] === null || $this->data[$field] === '') {
            if ($required) {
                $this->errors[$field] = 'Pflichtfeld.';
            }
            return null;
        }
        $value = $this->data[$field];
        if (!is_int($value) && !(is_string($value) && preg_match('/^-?\d+$/', $value))) {
            $this->errors[$field] = 'Ganze Zahl erwartet.';
            return null;
        }
        $value = (int) $value;
        if ($min !== null && $value < $min) {
            $this->errors[$field] = "Mindestens $min.";
            return null;
        }
        if ($max !== null && $value > $max) {
            $this->errors[$field] = "Höchstens $max.";
            return null;
        }
        return $this->clean[$field] = $value;
    }

    public function float(string $field, bool $required = false, ?float $min = null, ?float $max = null): ?float
    {
        if (!$this->has($field) || $this->data[$field] === null || $this->data[$field] === '') {
            if ($required) {
                $this->errors[$field] = 'Pflichtfeld.';
            }
            return null;
        }
        $value = $this->data[$field];
        if (is_string($value)) {
            $value = str_replace(',', '.', trim($value)); // deutsche Eingaben mitnehmen
        }
        if (!is_numeric($value)) {
            $this->errors[$field] = 'Zahl erwartet.';
            return null;
        }
        $value = (float) $value;
        if ($min !== null && $value < $min) {
            $this->errors[$field] = "Mindestens $min.";
            return null;
        }
        if ($max !== null && $value > $max) {
            $this->errors[$field] = "Höchstens $max.";
            return null;
        }
        return $this->clean[$field] = $value;
    }

    public function bool(string $field, ?bool $default = null): ?bool
    {
        if (!$this->has($field)) {
            return $default;
        }
        $value = $this->data[$field];
        if (is_bool($value)) {
            return $this->clean[$field] = $value;
        }
        if (in_array($value, [1, '1', 'true', 'yes', 'on'], true)) {
            return $this->clean[$field] = true;
        }
        if (in_array($value, [0, '0', 'false', 'no', 'off', ''], true)) {
            return $this->clean[$field] = false;
        }
        $this->errors[$field] = 'Ja/Nein erwartet.';
        return null;
    }

    /** @param list<string> $allowed */
    public function enum(string $field, array $allowed, bool $required = false, ?string $default = null): ?string
    {
        if (!$this->has($field) || $this->data[$field] === null || $this->data[$field] === '') {
            if ($required) {
                $this->errors[$field] = 'Pflichtfeld.';
                return null;
            }
            return $default;
        }
        $value = (string) $this->data[$field];
        if (!in_array($value, $allowed, true)) {
            $this->errors[$field] = 'Erlaubt: ' . implode(', ', $allowed) . '.';
            return null;
        }
        return $this->clean[$field] = $value;
    }

    public function email(string $field, bool $required = false): ?string
    {
        $value = $this->string($field, $required, 320);
        if ($value === null || $value === '') {
            return $value;
        }
        if (!filter_var($value, FILTER_VALIDATE_EMAIL)) {
            $this->errors[$field] = 'Keine gültige E-Mail-Adresse.';
            return null;
        }
        return $this->clean[$field] = strtolower($value);
    }

    public function color(string $field, bool $required = false): ?string
    {
        $value = $this->string($field, $required, 7);
        if ($value === null || $value === '') {
            return $value;
        }
        if (!preg_match('/^#[0-9a-fA-F]{6}$/', $value)) {
            $this->errors[$field] = 'Farbe im Format #rrggbb erwartet.';
            return null;
        }
        return $this->clean[$field] = strtolower($value);
    }

    /** Zeitpunkt als ISO-8601 oder "Y-m-d H:i"; liefert einen UTC-Timestamp. */
    public function timestamp(string $field, bool $required = false): ?int
    {
        $value = $this->string($field, $required, 64);
        if ($value === null || $value === '') {
            return $value === '' ? null : null;
        }
        $ts = Clock::fromIso($value);
        if ($ts === null) {
            $this->errors[$field] = 'Zeitpunkt nicht lesbar (erwartet z. B. 2026-08-08T11:45:00+02:00).';
            return null;
        }
        return $this->clean[$field] = $ts;
    }

    /** Datum als "Y-m-d". */
    public function date(string $field, bool $required = false): ?string
    {
        $value = $this->string($field, $required, 10);
        if ($value === null || $value === '') {
            return null;
        }
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) || !checkdate((int) substr($value, 5, 2), (int) substr($value, 8, 2), (int) substr($value, 0, 4))) {
            $this->errors[$field] = 'Datum im Format JJJJ-MM-TT erwartet.';
            return null;
        }
        return $this->clean[$field] = $value;
    }

    public function fail(string $field, string $message): void
    {
        $this->errors[$field] = $message;
    }

    public function failed(): bool
    {
        return $this->errors !== [];
    }

    /** @return array<string,string> */
    public function errors(): array
    {
        return $this->errors;
    }

    public function validate(): void
    {
        if ($this->errors !== []) {
            throw HttpException::validation($this->errors);
        }
    }
}
