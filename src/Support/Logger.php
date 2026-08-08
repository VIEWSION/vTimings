<?php
declare(strict_types=1);

namespace VT\Support;

use VT\Config;

/**
 * Schlanker Datei-Logger. Fehler landen nie im Response-Body, sondern
 * in data/logs/ – der Client bekommt nur eine Referenz-ID.
 */
final class Logger
{
    private static bool $registered = false;

    public static function register(): void
    {
        if (self::$registered) {
            return;
        }
        self::$registered = true;

        error_reporting(E_ALL);
        ini_set('display_errors', '0');
        ini_set('log_errors', '0'); // wir loggen selbst

        set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
            if (!(error_reporting() & $no)) {
                return false;
            }
            throw new \ErrorException($str, 0, $no, $file, $line);
        });

        set_exception_handler(static function (\Throwable $e): void {
            $ref = self::exception($e);
            if (PHP_SAPI === 'cli') {
                fwrite(STDERR, "Fehler [$ref]: " . $e->getMessage() . "\n" . $e->getTraceAsString() . "\n");
                exit(1);
            }
            if (!headers_sent()) {
                http_response_code(500);
                header('Content-Type: application/json; charset=utf-8');
            }
            $body = ['error' => ['code' => 'internal_error', 'message' => 'Interner Fehler', 'ref' => $ref]];
            if (Config::bool('debug')) {
                $body['error']['debug'] = $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine();
            }
            echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        });

        register_shutdown_function(static function (): void {
            $err = error_get_last();
            if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
                self::write('fatal', $err['message'] . ' @ ' . $err['file'] . ':' . $err['line']);
            }
        });
    }

    public static function exception(\Throwable $e): string
    {
        $ref = substr(bin2hex(random_bytes(4)), 0, 8);
        self::write('error', sprintf(
            "[%s] %s: %s @ %s:%d\n%s",
            $ref,
            $e::class,
            $e->getMessage(),
            $e->getFile(),
            $e->getLine(),
            $e->getTraceAsString()
        ));
        return $ref;
    }

    public static function info(string $message): void
    {
        self::write('info', $message);
    }

    public static function warn(string $message): void
    {
        self::write('warn', $message);
    }

    public static function write(string $level, string $message): void
    {
        $dir = VT_DATA . '/logs';
        if (!is_dir($dir)) {
            @mkdir($dir, 0770, true);
        }
        $line = sprintf(
            "%s %-5s %s\n",
            (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d H:i:s'),
            strtoupper($level),
            str_replace("\n", "\n      ", $message)
        );
        @file_put_contents($dir . '/' . gmdate('Y-m') . '.log', $line, FILE_APPEND | LOCK_EX);
    }
}
