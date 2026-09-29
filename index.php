<?php
/**
 * Shell der Oberfläche. Der Rest passiert clientseitig gegen die API.
 */
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use VT\Config;
use VT\Http\Request;

$base = Request::basePath();
// Cache-Buster über den jüngsten Zeitstempel aller Assets – sonst hängen
// nach einem Deploy einzelne Module in der alten Version fest.
$version = 0;
foreach (['/assets/js', '/assets/js/views', '/assets/css'] as $dir) {
    foreach (glob(__DIR__ . $dir . '/*.{js,css}', GLOB_BRACE) ?: [] as $asset) {
        $version = max($version, (int) filemtime($asset));
    }
}
$version = $version ?: time();
$e = static fn(string $value): string => htmlspecialchars($value, ENT_QUOTES);

header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
?>
<!doctype html>
<html lang="de" data-base="<?= $e($base) ?>" data-version="<?= $e(VT_VERSION) ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1c22" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="vTimings">
<title><?= $e((string) Config::get('app_name')) ?></title>
<link rel="manifest" href="<?= $e($base) ?>/assets/manifest.webmanifest">
<link rel="icon" href="<?= $e($base) ?>/assets/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="<?= $e($base) ?>/assets/icons/icon-180.png">
<link rel="stylesheet" href="<?= $e($base) ?>/assets/css/app.css?v=<?= $version ?>">
</head>
<body>
<div id="app">
    <div class="loading">Lade …</div>
</div>
<noscript>
    <div class="login"><div class="login__box card">
        <h1>vTimings</h1>
        <p>Für die Oberfläche wird JavaScript benötigt.</p>
    </div></div>
</noscript>
<script type="module" src="<?= $e($base) ?>/assets/js/app.js?v=<?= $version ?>"></script>
</body>
</html>
