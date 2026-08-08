<?php
declare(strict_types=1);

namespace VT\Http;

/**
 * Fehler, die dem Client gezeigt werden dürfen (im Gegensatz zu allen
 * anderen Exceptions, die nur als Referenz-ID nach draußen gehen).
 */
class HttpException extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $details = []
    ) {
        parent::__construct($message);
    }

    public static function badRequest(string $message, array $details = []): self
    {
        return new self(400, 'bad_request', $message, $details);
    }

    public static function unauthorized(string $message = 'Nicht angemeldet.'): self
    {
        return new self(401, 'unauthorized', $message);
    }

    public static function forbidden(string $message = 'Kein Zugriff.'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function notFound(string $message = 'Nicht gefunden.'): self
    {
        return new self(404, 'not_found', $message);
    }

    public static function conflict(string $message, array $details = []): self
    {
        return new self(409, 'conflict', $message, $details);
    }

    public static function validation(array $errors, string $message = 'Eingaben unvollständig oder ungültig.'): self
    {
        return new self(422, 'validation_failed', $message, ['fields' => $errors]);
    }

    public static function tooManyRequests(string $message, int $retryAfter = 60): self
    {
        return new self(429, 'too_many_requests', $message, ['retry_after' => $retryAfter]);
    }
}
