<?php
declare(strict_types=1);

namespace VT\Http;

use VT\Config;

final class Request
{
    public readonly string $method;
    public readonly string $path;
    /** @var array<string,mixed> */
    public readonly array $query;
    /** @var array<string,mixed> */
    public readonly array $body;
    /** @var array<string,string> */
    public readonly array $headers;
    public readonly string $ip;
    public readonly string $rawBody;

    /** @var array<string,string> Platzhalter aus dem gematchten Pfad */
    public array $params = [];

    private function __construct(
        string $method,
        string $path,
        array $query,
        array $body,
        array $headers,
        string $ip,
        string $rawBody
    ) {
        $this->method  = $method;
        $this->path    = $path;
        $this->query   = $query;
        $this->body    = $body;
        $this->headers = $headers;
        $this->ip      = $ip;
        $this->rawBody = $rawBody;
    }

    public static function capture(): self
    {
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $headers = self::readHeaders();

        // Method-Override für Clients, die nur GET/POST können.
        if ($method === 'POST' && isset($headers['x-http-method-override'])) {
            $override = strtoupper($headers['x-http-method-override']);
            if (in_array($override, ['PUT', 'PATCH', 'DELETE'], true)) {
                $method = $override;
            }
        }

        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = parse_url($uri, PHP_URL_PATH) ?: '/';
        $path = self::stripBasePath($path);

        $raw = '';
        $body = [];
        $contentType = strtolower($headers['content-type'] ?? '');

        if (str_contains($contentType, 'multipart/form-data')) {
            $body = $_POST;
        } elseif (str_contains($contentType, 'application/x-www-form-urlencoded')) {
            $body = $_POST;
        } elseif (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            $raw = (string) file_get_contents('php://input');
            // Nur als JSON auslegen, wenn es auch so deklariert ist – Importe
            // schicken CSV im Body und dürfen daran nicht scheitern.
            if ($raw !== '' && str_contains($contentType, 'json')) {
                $decoded = json_decode($raw, true);
                if (json_last_error() !== JSON_ERROR_NONE) {
                    throw new HttpException(400, 'invalid_json', 'Request-Body ist kein gültiges JSON.');
                }
                $body = is_array($decoded) ? $decoded : [];
            }
        }

        return new self($method, $path, $_GET, $body, $headers, self::clientIp($headers), $raw);
    }

    /**
     * Erzeugt einen Request von Hand – für Tests und CLI-Aufrufe.
     */
    public static function make(string $method, string $path, array $query = [], array $body = [], array $headers = []): self
    {
        return new self(strtoupper($method), $path, $query, $body, $headers, '127.0.0.1', '');
    }

    /** Basis-Pfad ermitteln, damit die App in einem Unterordner laufen kann. */
    public static function basePath(): string
    {
        $configured = Config::get('base_path');
        if (is_string($configured)) {
            return rtrim($configured, '/');
        }
        $script = str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '')));
        return $script === '/' ? '' : rtrim($script, '/');
    }

    private static function stripBasePath(string $path): string
    {
        $base = self::basePath();
        if ($base !== '' && str_starts_with($path, $base)) {
            $path = substr($path, strlen($base));
        }
        $path = '/' . ltrim($path, '/');
        // api.php ist der Front-Controller; sein Name gehört nicht zur Route.
        if (str_starts_with($path, '/api.php')) {
            $path = '/api' . substr($path, strlen('/api.php'));
        }
        return rtrim($path, '/') ?: '/';
    }

    /** @return array<string,string> */
    private static function readHeaders(): array
    {
        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $name = strtolower(str_replace('_', '-', substr($key, 5)));
                $headers[$name] = (string) $value;
            }
        }
        foreach (['CONTENT_TYPE' => 'content-type', 'CONTENT_LENGTH' => 'content-length'] as $server => $name) {
            if (isset($_SERVER[$server])) {
                $headers[$name] = (string) $_SERVER[$server];
            }
        }
        return $headers;
    }

    private static function clientIp(array $headers): string
    {
        if (Config::bool('trusted_proxy') && isset($headers['x-forwarded-for'])) {
            $parts = explode(',', $headers['x-forwarded-for']);
            $ip = trim($parts[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) {
                return $ip;
            }
        }
        return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function bearerToken(): ?string
    {
        $auth = $this->header('authorization');
        if ($auth && preg_match('/^Bearer\s+(.+)$/i', trim($auth), $m)) {
            return trim($m[1]);
        }
        return null;
    }

    public function param(string $name, ?string $default = null): ?string
    {
        return $this->params[$name] ?? $default;
    }

    /** Wert aus Body, sonst Query. */
    public function input(string $key, mixed $default = null): mixed
    {
        return $this->body[$key] ?? $this->query[$key] ?? $default;
    }

    public function isJson(): bool
    {
        return str_contains(strtolower($this->header('content-type') ?? ''), 'application/json');
    }

    public function wantsJson(): bool
    {
        return str_starts_with($this->path, '/api')
            || str_contains(strtolower($this->header('accept') ?? ''), 'application/json');
    }
}
