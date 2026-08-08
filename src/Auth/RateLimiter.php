<?php
declare(strict_types=1);

namespace VT\Auth;

use VT\Db\Database;
use VT\Http\HttpException;
use VT\Support\Clock;

/**
 * Brute-Force-Bremse für den Login.
 *
 * Gezählt wird pro IP und pro E-Mail getrennt – sonst sperrt ein Angreifer
 * durch stumpfes Raten fremde Konten aus oder umgeht die Sperre einfach
 * durch Wechseln der Zieladresse.
 */
final class RateLimiter
{
    private const WINDOW       = 900;  // 15 Minuten Beobachtungsfenster
    private const MAX_PER_IP   = 20;
    private const MAX_PER_MAIL = 8;

    public static function check(string $ip, string $email): void
    {
        $since = Clock::now() - self::WINDOW;

        $byIp = (int) Database::value(
            'SELECT COUNT(*) FROM login_attempts WHERE ip = :ip AND at > :since AND ok = 0',
            ['ip' => $ip, 'since' => $since]
        );
        $byMail = $email === '' ? 0 : (int) Database::value(
            'SELECT COUNT(*) FROM login_attempts WHERE email = :email AND at > :since AND ok = 0',
            ['email' => $email, 'since' => $since]
        );

        if ($byIp >= self::MAX_PER_IP || $byMail >= self::MAX_PER_MAIL) {
            // Wartezeit wächst mit der Zahl der Fehlversuche.
            $over = max($byIp - self::MAX_PER_IP, $byMail - self::MAX_PER_MAIL) + 1;
            $retry = min(self::WINDOW, 30 * (2 ** min($over, 5)));
            throw HttpException::tooManyRequests(
                'Zu viele Anmeldeversuche. Bitte in ' . ceil($retry / 60) . ' Minuten erneut versuchen.',
                $retry
            );
        }
    }

    public static function record(string $ip, string $email, bool $ok): void
    {
        Database::insert('login_attempts', [
            'ip'    => $ip,
            'email' => $email,
            'at'    => Clock::now(),
            'ok'    => $ok ? 1 : 0,
        ]);

        // Bei Erfolg das Konto entlasten und alte Einträge aufräumen.
        if ($ok && $email !== '') {
            Database::run('DELETE FROM login_attempts WHERE email = :email AND ok = 0', ['email' => $email]);
        }
        if (random_int(1, 50) === 1) {
            Database::run('DELETE FROM login_attempts WHERE at < :cut', ['cut' => Clock::now() - 86400 * 7]);
        }
    }
}
