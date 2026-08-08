<?php
declare(strict_types=1);

namespace VT\Auth;

use VT\Http\HttpException;
use VT\Http\Request;

/**
 * CSRF-Schutz für session-authentifizierte, schreibende Requests.
 *
 * Token-authentifizierte Aufrufe (native Clients) brauchen das nicht –
 * dort schickt kein Browser automatisch Anmeldedaten mit.
 */
final class Csrf
{
    public const HEADER = 'x-csrf-token';

    public static function token(): string
    {
        Session::start();
        if (empty($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
        return (string) $_SESSION['csrf'];
    }

    public static function rotate(): string
    {
        Session::start();
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        return (string) $_SESSION['csrf'];
    }

    public static function verify(Request $request): void
    {
        if (in_array($request->method, ['GET', 'HEAD', 'OPTIONS'], true)) {
            return;
        }

        $expected = $_SESSION['csrf'] ?? null;
        $given = $request->header(self::HEADER) ?? (string) $request->input('_csrf', '');

        if (!is_string($expected) || $expected === '' || !is_string($given) || !hash_equals($expected, $given)) {
            throw new HttpException(419, 'csrf_mismatch', 'Sitzung abgelaufen. Bitte Seite neu laden.');
        }
    }
}
