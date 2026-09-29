<?php
declare(strict_types=1);

namespace VT;

use VT\Auth\Auth;
use VT\Auth\Csrf;
use VT\Db\Database;
use VT\Db\Migrator;
use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Response;
use VT\Http\Router;
use VT\Support\Logger;

/**
 * Bindet Routen, Authentifizierung und Fehlerbehandlung zusammen.
 */
final class Kernel
{
    private Router $router;

    public function __construct()
    {
        $this->router = new Router();
        $this->registerRoutes();
    }

    public function router(): Router
    {
        return $this->router;
    }

    public function handle(Request $request): Response
    {
        try {
            $this->assertSchemaCurrent();

            Auth::resolve($request);

            $match = $this->router->match($request);
            if ($match !== null) {
                $this->authorize($request, $match['options']);
            }

            return $this->router->dispatch($request);
        } catch (HttpException $e) {
            return Response::error($e);
        } catch (\Throwable $e) {
            $ref = Logger::exception($e);
            $payload = ['error' => ['code' => 'internal_error', 'message' => 'Interner Fehler.', 'ref' => $ref]];
            if (Config::bool('debug')) {
                $payload['error']['debug'] = $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine();
            }
            return Response::json($payload, 500);
        }
    }

    /**
     * Route-Option 'auth':
     *   'none'   – offen
     *   'user'   – angemeldet (Admin oder Kunde)
     *   'admin'  – nur Administrator (Vorgabe)
     */
    private function authorize(Request $request, array $options): void
    {
        $level = $options['auth'] ?? 'admin';

        if ($level !== 'none') {
            $user = Auth::require();
            if ($level === 'admin' && !$user->isAdmin()) {
                throw HttpException::forbidden('Diese Funktion ist Administratoren vorbehalten.');
            }
        }

        // CSRF nur bei Cookie-Anmeldung; Token-Clients senden keinen Cookie mit.
        if ($request->bearerToken() === null && ($options['csrf'] ?? true)) {
            Csrf::verify($request);
        }
    }

    private function assertSchemaCurrent(): void
    {
        static $checked = false;
        if ($checked) {
            return;
        }
        $checked = true;

        if (!is_file((string) Config::get('db_file'))) {
            throw new HttpException(
                503,
                'not_installed',
                'Datenbank fehlt. Bitte einmalig "php bin/console.php install" ausführen.'
            );
        }
        if (Migrator::pending() !== []) {
            throw new HttpException(
                503,
                'migration_pending',
                'Datenbankschema ist veraltet. Bitte "php bin/console.php migrate" ausführen.'
            );
        }
    }

    private function registerRoutes(): void
    {
        $r = $this->router;

        // -- Systemstatus ---------------------------------------------------
        $r->get('/api/health', function (): array {
            return [
                'app'     => Config::get('app_name'),
                'php'     => PHP_VERSION,
                'sqlite'  => (string) Database::value('SELECT sqlite_version()'),
                'schema'  => Migrator::currentVersion(),
                'pending' => count(Migrator::pending()),
                'time'    => Support\Clock::iso(Support\Clock::now()),
                'tz'      => Config::get('timezone'),
            ];
        }, ['auth' => 'none']);

        // -- Anmeldung ------------------------------------------------------
        $r->post('/api/auth/login', function (Request $req): Response {
            $v = new Support\Validator($req->body);
            $email = $v->email('email', true);
            $password = $v->string('password', true, 200);
            $remember = $v->bool('remember', false);
            $v->validate();

            $user = Auth::login($req, (string) $email, (string) $password, (bool) $remember);

            return Response::json([
                'user' => $user->toArray() + ['lang' => Auth::lang()],
                'csrf' => Csrf::token(),
            ]);
        }, ['auth' => 'none', 'csrf' => false]);

        $r->post('/api/auth/logout', function (): Response {
            Auth::logout();
            return Response::json(['ok' => true]);
        }, ['auth' => 'user']);

        $r->get('/api/auth/me', function (): array {
            $user = Auth::user();
            return [
                'user' => $user === null ? null : $user->toArray() + ['lang' => Auth::lang()],
                'csrf' => Csrf::token(),
            ];
        }, ['auth' => 'none']);

        // Sprachumschalter der Oberfläche. Wo die Wahl landet, entscheidet
        // Auth::setLang() – beim Kunden im Kundenprofil, beim Administrator
        // in den Einstellungen.
        $r->patch('/api/auth/lang', function (Request $req): array {
            $v = new Support\Validator($req->body);
            $lang = $v->enum('lang', Auth::LANGS, true);
            $v->validate();

            return ['lang' => Auth::setLang((string) $lang)];
        }, ['auth' => 'user']);

        // -- Einstellungen --------------------------------------------------
        $r->get('/api/settings', function (): array {
            return ['settings' => Settings::all()];
        }, ['auth' => 'user']);

        $r->patch('/api/settings', function (Request $req): array {
            // Absenderdaten sind freier Text (Briefkopf), der Rest ist getypt.
            $text = ['issuer_name', 'issuer_logo', 'issuer_address', 'issuer_footer', 'issuer_contact'];
            $allowed = array_merge([
                'rounding_enabled', 'rounding_minutes', 'rounding_mode',
                'default_rate', 'currency', 'week_start', 'recent_limit',
            ], $text);

            $v = new Support\Validator($req->body);
            $values = [];

            foreach ($text as $key) {
                if ($v->has($key)) {
                    $values[$key] = (string) $v->string($key, false, 2000, '');
                }
            }

            if ($v->has('rounding_enabled')) {
                $values['rounding_enabled'] = $v->bool('rounding_enabled') ? '1' : '0';
            }
            if ($v->has('rounding_minutes')) {
                $values['rounding_minutes'] = (string) $v->int('rounding_minutes', true, 1, 240);
            }
            if ($v->has('rounding_mode')) {
                $values['rounding_mode'] = (string) $v->enum('rounding_mode', ['nearest', 'up', 'down'], true);
            }
            if ($v->has('default_rate')) {
                $values['default_rate'] = (string) $v->float('default_rate', true, 0, 100000);
            }
            if ($v->has('currency')) {
                $values['currency'] = (string) $v->string('currency', true, 3);
            }
            if ($v->has('week_start')) {
                $values['week_start'] = (string) $v->int('week_start', true, 0, 1);
            }
            if ($v->has('recent_limit')) {
                $values['recent_limit'] = (string) $v->int('recent_limit', true, 1, 50);
            }
            $v->validate();

            $unknown = array_diff(array_keys($req->body), $allowed);
            if ($unknown !== []) {
                throw HttpException::badRequest('Unbekannte Einstellung: ' . implode(', ', $unknown));
            }

            Settings::setMany($values);
            return ['settings' => Settings::all()];
        });

        // -- Stammdaten -----------------------------------------------------
        Controller\MasterDataController::register($r);

        // -- Einträge und Timer ---------------------------------------------
        Controller\EntryController::register($r);

        // -- Auswertung, Export, Leistungsnachweis --------------------------
        Controller\ReportController::register($r);

        // -- Import ---------------------------------------------------------
        Controller\ImportController::register($r);

        // -- Benutzer, Tokens, Kundenportal ---------------------------------
        Controller\UserController::register($r);
        Controller\PortalController::register($r);
    }
}
