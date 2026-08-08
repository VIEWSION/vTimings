<?php
declare(strict_types=1);

namespace VT\Http;

/**
 * Kleiner Router mit {platzhalter}-Segmenten.
 *
 * Handler bekommen den Request und geben eine Response zurück; ein Array
 * als Rückgabe wird automatisch als JSON verpackt.
 */
final class Router
{
    /** @var array<string, list<array{pattern:string, regex:string, keys:list<string>, handler:callable, options:array}>> */
    private array $routes = [];

    public function get(string $path, callable $handler, array $options = []): void
    {
        $this->add('GET', $path, $handler, $options);
    }

    public function post(string $path, callable $handler, array $options = []): void
    {
        $this->add('POST', $path, $handler, $options);
    }

    public function patch(string $path, callable $handler, array $options = []): void
    {
        $this->add('PATCH', $path, $handler, $options);
    }

    public function put(string $path, callable $handler, array $options = []): void
    {
        $this->add('PUT', $path, $handler, $options);
    }

    public function delete(string $path, callable $handler, array $options = []): void
    {
        $this->add('DELETE', $path, $handler, $options);
    }

    public function add(string $method, string $path, callable $handler, array $options = []): void
    {
        $keys = [];
        $regex = preg_replace_callback(
            '/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/',
            static function (array $m) use (&$keys): string {
                $keys[] = $m[1];
                return '([^/]+)';
            },
            $path
        );

        $this->routes[strtoupper($method)][] = [
            'pattern' => $path,
            'regex'   => '#^' . $regex . '$#',
            'keys'    => $keys,
            'handler' => $handler,
            'options' => $options,
        ];
    }

    /**
     * @return array{handler:callable, options:array}|null
     */
    public function match(Request $request): ?array
    {
        foreach ($this->routes[$request->method] ?? [] as $route) {
            if (preg_match($route['regex'], $request->path, $m)) {
                array_shift($m);
                $request->params = array_combine($route['keys'], array_map('rawurldecode', $m)) ?: [];
                return ['handler' => $route['handler'], 'options' => $route['options']];
            }
        }
        return null;
    }

    /** Existiert der Pfad unter einer anderen Methode? Dann 405 statt 404. */
    public function allowedMethods(string $path): array
    {
        $allowed = [];
        foreach ($this->routes as $method => $routes) {
            foreach ($routes as $route) {
                if (preg_match($route['regex'], $path)) {
                    $allowed[] = $method;
                    break;
                }
            }
        }
        return $allowed;
    }

    public function dispatch(Request $request): Response
    {
        $match = $this->match($request);

        if ($match === null) {
            $allowed = $this->allowedMethods($request->path);
            if ($allowed !== []) {
                return Response::error(new HttpException(
                    405,
                    'method_not_allowed',
                    'Methode für diese Route nicht erlaubt.'
                ))->withHeader('Allow', implode(', ', $allowed));
            }
            return Response::error(HttpException::notFound('Route nicht gefunden: ' . $request->path));
        }

        $result = ($match['handler'])($request, $match['options']);

        return match (true) {
            $result instanceof Response => $result,
            $result === null            => Response::noContent(),
            default                     => Response::json($result),
        };
    }
}
