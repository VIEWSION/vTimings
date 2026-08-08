<?php
/**
 * Front-Controller der API.
 */
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use VT\Http\HttpException;
use VT\Http\Request;
use VT\Http\Response;
use VT\Kernel;

try {
    $request = Request::capture();
} catch (HttpException $e) {
    Response::error($e)->send();
    exit;
}

// Preflight braucht keine Anmeldung und keine Session.
if ($request->method === 'OPTIONS') {
    (new Response(204, '', [
        'Allow'                 => 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age' => '600',
    ]))->send();
    exit;
}

$response = (new Kernel())->handle($request);
$response
    ->withHeader('X-Content-Type-Options', 'nosniff')
    ->withHeader('Cache-Control', 'no-store')
    ->send();
