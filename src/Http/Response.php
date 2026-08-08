<?php
declare(strict_types=1);

namespace VT\Http;

final class Response
{
    /** @param array<string,string> $headers */
    public function __construct(
        public int $status = 200,
        public string $body = '',
        public array $headers = []
    ) {
    }

    public static function json(mixed $data, int $status = 200, array $headers = []): self
    {
        $body = json_encode(
            $data,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION
        );
        if ($body === false) {
            $body = '{"error":{"code":"encoding_error","message":"Antwort konnte nicht kodiert werden."}}';
            $status = 500;
        }
        return new self($status, $body, $headers + ['Content-Type' => 'application/json; charset=utf-8']);
    }

    public static function noContent(): self
    {
        return new self(204);
    }

    public static function html(string $html, int $status = 200): self
    {
        return new self($status, $html, ['Content-Type' => 'text/html; charset=utf-8']);
    }

    public static function text(string $text, int $status = 200): self
    {
        return new self($status, $text, ['Content-Type' => 'text/plain; charset=utf-8']);
    }

    public static function download(string $body, string $filename, string $mime = 'application/octet-stream'): self
    {
        $safe = preg_replace('/[^A-Za-z0-9._ \-]/', '_', $filename) ?? 'download';
        return new self($body === '' ? 204 : 200, $body, [
            'Content-Type'        => $mime,
            'Content-Disposition' => sprintf(
                "attachment; filename=\"%s\"; filename*=UTF-8''%s",
                $safe,
                rawurlencode($filename)
            ),
            'Content-Length'      => (string) strlen($body),
        ]);
    }

    public static function error(HttpException $e): self
    {
        $payload = ['error' => ['code' => $e->errorCode, 'message' => $e->getMessage()]];
        if ($e->details !== []) {
            $payload['error']['details'] = $e->details;
        }
        $headers = [];
        if ($e->status === 429 && isset($e->details['retry_after'])) {
            $headers['Retry-After'] = (string) $e->details['retry_after'];
        }
        return self::json($payload, $e->status, $headers);
    }

    public function withHeader(string $name, string $value): self
    {
        $this->headers[$name] = $value;
        return $this;
    }

    public function send(): void
    {
        if (!headers_sent()) {
            http_response_code($this->status);
            foreach ($this->headers as $name => $value) {
                header($name . ': ' . $value, true);
            }
        }
        if ($this->status !== 204) {
            echo $this->body;
        }
    }
}
