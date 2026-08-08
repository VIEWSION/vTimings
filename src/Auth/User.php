<?php
declare(strict_types=1);

namespace VT\Auth;

/**
 * Der angemeldete Benutzer als Wertobjekt.
 *
 * `clientId` und `projectFilter` bilden den Sichtbarkeits-Scope ab. Er wird
 * in der Repository-Schicht durchgesetzt, nicht erst im Controller – sonst
 * reicht ein vergessener Check und ein Kunde sieht fremde Projekte.
 */
final class User
{
    /** @param list<int>|null $projectFilter */
    public function __construct(
        public readonly int $id,
        public readonly string $name,
        public readonly string $email,
        public readonly string $role,
        public readonly ?int $clientId = null,
        public readonly ?array $projectFilter = null,
        public readonly bool $showCosts = true,
    ) {
    }

    public static function fromRow(array $row): self
    {
        $filter = null;
        if (!empty($row['project_filter'])) {
            $decoded = json_decode((string) $row['project_filter'], true);
            if (is_array($decoded) && $decoded !== []) {
                $filter = array_values(array_map('intval', $decoded));
            }
        }

        return new self(
            (int) $row['id'],
            (string) $row['name'],
            (string) $row['email'],
            (string) $row['role'],
            isset($row['client_id']) ? (int) $row['client_id'] : null,
            $filter,
            (bool) ($row['show_costs'] ?? 1),
        );
    }

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

    public function isClient(): bool
    {
        return $this->role === 'client';
    }

    public function toArray(): array
    {
        return [
            'id'         => $this->id,
            'name'       => $this->name,
            'email'      => $this->email,
            'role'       => $this->role,
            'client_id'  => $this->clientId,
            'projects'   => $this->projectFilter,
            'show_costs' => $this->showCosts,
        ];
    }
}
