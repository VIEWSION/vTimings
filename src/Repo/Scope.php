<?php
declare(strict_types=1);

namespace VT\Repo;

use VT\Auth\Auth;
use VT\Auth\User;

/**
 * Sichtbarkeits-Scope eines Benutzers als SQL-Fragment.
 *
 * Wird von allen Repositories angewandt. Der Kundenzugang darf dadurch
 * nie fremde Daten sehen, auch wenn ein Controller die Prüfung vergisst.
 */
final class Scope
{
    /**
     * @param list<int>|null $clientIds  null = alle Kunden
     * @param list<int>|null $projectIds null = alle Projekte der erlaubten Kunden
     */
    private function __construct(
        public readonly ?array $clientIds,
        public readonly ?array $projectIds,
        public readonly bool $showCosts,
    ) {
    }

    public static function unrestricted(): self
    {
        return new self(null, null, true);
    }

    public static function forUser(?User $user = null): self
    {
        $user ??= Auth::user();

        if ($user === null) {
            // Kein Benutzer: nichts sichtbar. Leere Listen statt null.
            return new self([], [], false);
        }
        if ($user->isAdmin()) {
            return self::unrestricted();
        }

        return new self(
            $user->clientId !== null ? [$user->clientId] : [],
            $user->projectFilter,
            $user->showCosts,
        );
    }

    public static function current(): self
    {
        return self::forUser();
    }

    public function isUnrestricted(): bool
    {
        return $this->clientIds === null && $this->projectIds === null;
    }

    /**
     * Bedingung für eine Spalte, die eine Kunden-ID enthält.
     *
     * @return array{0:string,1:array<string,int>} SQL-Fragment und Parameter
     */
    public function clientCondition(string $column, string $prefix = 'sc'): array
    {
        return self::inCondition($column, $this->clientIds, $prefix . 'c');
    }

    /** Bedingung für eine Spalte, die eine Projekt-ID enthält. */
    public function projectCondition(string $column, string $prefix = 'sc'): array
    {
        return self::inCondition($column, $this->projectIds, $prefix . 'p');
    }

    /**
     * Kombinierte Bedingung für Abfragen, die beide Spalten zur Verfügung haben.
     *
     * @return array{0:string,1:array<string,int>}
     */
    public function condition(string $clientColumn, string $projectColumn, string $prefix = 'sc'): array
    {
        [$sqlC, $paramsC] = $this->clientCondition($clientColumn, $prefix);
        [$sqlP, $paramsP] = $this->projectCondition($projectColumn, $prefix);

        if ($sqlC === '1' && $sqlP === '1') {
            return ['1', []];
        }
        $parts = array_values(array_filter([$sqlC, $sqlP], static fn($s) => $s !== '1'));

        return ['(' . implode(' AND ', $parts) . ')', $paramsC + $paramsP];
    }

    /**
     * @param list<int>|null $ids
     * @return array{0:string,1:array<string,int>}
     */
    private static function inCondition(string $column, ?array $ids, string $prefix): array
    {
        if ($ids === null) {
            return ['1', []];
        }
        if ($ids === []) {
            return ['0', []];
        }

        $params = [];
        $names = [];
        foreach (array_values($ids) as $i => $id) {
            $name = $prefix . $i;
            $names[] = ':' . $name;
            $params[$name] = (int) $id;
        }
        return [$column . ' IN (' . implode(', ', $names) . ')', $params];
    }
}
