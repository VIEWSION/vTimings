<?php
/**
 * Gemeinsamer Einstiegspunkt für Web und CLI.
 */
declare(strict_types=1);

if (PHP_VERSION_ID < 80200) {
    http_response_code(500);
    exit('vTimings benötigt PHP 8.2 oder neuer.');
}

define('VT_ROOT', __DIR__);
define('VT_DATA', VT_ROOT . '/data');
define('VT_START', microtime(true));

// Gerechnet und gespeichert wird durchgängig in UTC; die Anzeige-Zeitzone
// steckt in der Konfiguration und wird erst bei der Formatierung angewandt.
date_default_timezone_set('UTC');

spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, 'VT\\')) {
        return;
    }
    $path = VT_ROOT . '/src/' . str_replace('\\', '/', substr($class, 3)) . '.php';
    if (is_file($path)) {
        require $path;
    }
});

VT\Config::load();
VT\Support\Logger::register();
