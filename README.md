# vTimings

Zeiterfassung für Kunden und Projekte – Ersatz für die macOS-App *Timings*,
die mit dem Wegfall von Rosetta nicht mehr läuft.

PHP 8.2+, SQLite, keine Abhängigkeiten, kein Build-Schritt.

---

## Aufbau

```
index.php          Shell der Oberfläche
api.php            Front-Controller für API und Druckansichten
bootstrap.php      Autoloader, Konfiguration, Fehlerbehandlung
bin/console.php    Wartungskommandos

src/
  Auth/            Anmeldung, Sitzung, CSRF, Ratelimit, Tokens
  Controller/      Routen-Handler
  Db/              PDO-Wrapper, Migrationen
  Domain/          Fachlogik (Stundensatz-Vererbung)
  Export/          Ausgabeformate hinter einer Schnittstelle
  Http/            Router, Request, Response
  Import/          Timings-CSV-Import
  Report/          Anzeigemodell und Vorlagen-Renderer
  Repo/            Datenzugriff inkl. Sichtbarkeits-Scope
  Support/         Zeit, Validierung, Logging

assets/            CSS, ES-Module, Icons, Manifest, Service Worker
templates/report/  Druckvorlagen
migrations/        Schema, nummeriert
data/              Datenbank, Logs, Sicherungen  ← nie ausliefern
```

### Zwei Regeln, die überall gelten

**Zeit** wird als UTC-Unixtimestamp gespeichert und erst bei der Anzeige in die
App-Zeitzone übersetzt. Deshalb bleiben Einträge über Mitternacht und die
Zeitumstellung korrekt. Gruppierungen nach Tag/Monat rechnet PHP, nicht SQLite –
SQLite hat keine Zeitzonendatenbank und würde mit einem festen Offset an den
Umstellungstagen daneben liegen.

**Sichtbarkeit** setzt `Repo\Scope` in der Datenzugriffsschicht durch, nicht der
Controller. Ein Kundenzugang kann deshalb auch dann keine fremden Daten sehen,
wenn eine Route die Prüfung vergisst.

---

## Einrichtung

```bash
php bin/console.php install
```

Legt das Schema an und fragt nach dem ersten Administrator. Danach ist die App
unter der eingerichteten URL erreichbar.

Optionale Konfiguration in `data/config.php` (wird nicht ausgeliefert):

```php
<?php
return [
    'timezone'      => 'Europe/Berlin',
    'debug'         => false,
    'trusted_proxy' => false,   // true, wenn ein Reverse-Proxy davorsteht
    'base_path'     => null,    // null = automatisch
];
```

---

## Sprache

Oberfläche und Ausdrucke gibt es auf Deutsch und Englisch. Umgeschaltet wird
über `DE | EN` in der Kopfzeile – auch schon auf dem Anmeldebildschirm.

Wo die Wahl landet, hängt vom Zugang ab:

* **Kundenzugang** → `clients.lang` im Kundenprofil. Damit gilt dieselbe
  Sprache für das Portal und für den Leistungsnachweis, den der Kunde bekommt.
  Der Administrator gibt sie in den Stammdaten vor, der Kunde kann sie
  jederzeit selbst ändern.
* **Administrator** → Einstellung `ui_lang`, gilt nur für die eigene Ansicht.

Die Texte der Oberfläche stehen in `assets/js/i18n.js` (`t('schlüssel')`),
die der Druckvorlagen in `src/Report/Translator.php`. Deutsch ist die
Leitsprache: fehlt ein Schlüssel in `en`, erscheint der deutsche Text.
Zahlen, Beträge und Datumsangaben folgen der Sprache (`de-DE` bzw. `en-GB`).

---

## Kommandos

```bash
php bin/console.php status                      # Überblick
php bin/console.php migrate                     # offene Migrationen
php bin/console.php import --file=Export.csv --dry-run
php bin/console.php import --file=Export.csv
php bin/console.php user:add --email= --role=client --client=ID
php bin/console.php user:passwd --email=
php bin/console.php user:list
php bin/console.php backup --keep=30
```

Tägliche Sicherung per Cron:

```
15 3 * * * cd /pfad/zu/vTimings && php bin/console.php backup --keep=30
```

`backup` erzeugt zwei Dateien: eine konsistente SQLite-Kopie (`VACUUM INTO`,
funktioniert im laufenden Betrieb) und einen Timings-CSV-Dump. Die CSV ist die
Rückfallebene für den Fall, dass in einigen Jahren weder diese App noch SQLite
zur Hand ist.

---

## Betrieb auf öffentlichem Webspace

1. **HTTPS ist Pflicht.** Die `.htaccess` leitet http auf https um (localhost
   ausgenommen). Ohne HTTPS setzt der Browser das Sitzungs-Cookie nicht als
   `Secure` und der Service Worker startet nicht.
2. **`data/` muss unerreichbar sein.** Zwei Sperren sind eingebaut: ein
   `RedirectMatch 404` im Wurzelverzeichnis und ein `Require all denied` in
   `data/.htaccess`. Nach dem Deploy prüfen:
   ```bash
   curl -o /dev/null -w '%{http_code}\n' https://DEINE-URL/data/vtimings.sqlite
   ```
   Erwartet wird 403 oder 404. Alles andere ist ein Datenleck.
3. **Testkonten löschen.** `php bin/console.php user:list` zeigt alle Zugänge.
4. **Schreibrechte** braucht nur `data/` (Datenbank, Logs, Sicherungen).
5. **nginx statt Apache?** Die `.htaccess` wirkt dort nicht. Nötig sind: `/api/`
   und `/report` auf `api.php`, alles Übrige auf `index.php`, und ein
   `location ~ ^/(data|src|migrations|bin)/ { deny all; }`.

Eingebaut sind Argon2id-Passwörter, `HttpOnly`/`Secure`/`SameSite=Strict`-Cookies,
Sitzungswechsel beim Anmelden, CSRF-Token auf allen schreibenden Aufrufen und
eine Login-Bremse mit wachsender Sperrzeit je IP und je E-Mail.

---

## API

Anmeldung über Sitzungs-Cookie (Web) oder `Authorization: Bearer …` (native
Clients, Tokens in den Einstellungen). Schreibende Aufrufe per Cookie brauchen
zusätzlich `X-CSRF-Token` aus `GET /api/auth/me`.

```
GET    /api/health                     ohne Anmeldung
POST   /api/auth/login · logout · password
GET    /api/auth/me                    enthält die Oberflächensprache
PATCH  /api/auth/lang                  { "lang": "de" | "en" }

GET    /api/tree                       Kunden > Projekte > Teilprojekte mit Summen
CRUD   /api/clients · projects · subprojects

GET    /api/entries?from&to&client_id&project_id&q&billed&group=day
POST   /api/entries
PATCH  /api/entries/{id}
DELETE /api/entries/{id}               Papierkorb
POST   /api/entries/{id}/restore
GET    /api/entries/recent             Schnellwahl

GET    /api/timer
POST   /api/timer/start                on_conflict: ask | stop | parallel
POST   /api/timer/{id}/stop
PATCH  /api/timer/{id}
DELETE /api/timer/{id}                 verwerfen

GET    /api/stats?group_by=client|project|subproject|day|week|month|year
GET    /api/export?format=timings-csv|csv|json
GET    /api/export/formats
GET    /report?template=&costs=&group_days=&times=&notes=&lang=

GET    /api/portal                     Kundenportal
CRUD   /api/users · /api/tokens        nur Administratoren
POST   /api/import/timings-csv?dry_run=1
```

### Konflikt beim Timer

Läuft schon ein Timer, antwortet `POST /api/timer/start` mit **409** und
`code: timer_running`. Die Antwort enthält den laufenden Timer und die
möglichen Auflösungen. Erst ein erneuter Aufruf mit `on_conflict=stop` oder
`=parallel` handelt.

---

## Erweitern

**Neues Exportformat:** eine Klasse in `src/Export/`, die `Exporter`
implementiert, und ein Eintrag in `Export\Registry::EXPORTERS`. Oberfläche,
API und Dateiname ergeben sich daraus.

**Neue Druckvorlage:** ein Verzeichnis unter `templates/report/` mit
`report.php`, `print.css` und `template.json`. Die Vorlage bekommt das fertige
Anzeigemodell aus dem `ReportBuilder` – sie enthält keine Logik.

**Schemaänderung:** eine neue Datei `migrations/000N_name.sql`. Die Nummer wird
zur `user_version`; jede Migration läuft in einer eigenen Transaktion.

---

## Import aus Timings

Der Export der Original-App (`Ablage > Exportieren`, Semikolon-getrennt) lässt
sich direkt einlesen – über die Einstellungen oder per `console.php import`.

Der Trockenlauf zeigt vorab, was passieren würde. Bereits vorhandene Einträge
werden über einen Inhalts-Hash erkannt, ein zweiter Import ändert also nichts.

Auffälligkeiten in den Altdaten werden **gemeldet, aber nicht stillschweigend
korrigiert** – Zeiten außerhalb des Rundungsrasters, Einträge über Mitternacht,
Ende vor Start, fehlende Notizen. Die Altdaten sind, wie sie sind.

Kundennamen lassen sich beim Import zusammenführen:

```bash
php bin/console.php import --file=Export.csv --alias="Fraas=Dr. Fraas,AM Etikettendruck=A.M. Etikettendruck"
```

Stundensätze werden aus den Einträgen abgeleitet: der zuletzt tatsächlich
verwendete Satz, je Kunde und je Projekt – letzteres nur, wenn er vom
Kundensatz abweicht. Bereits gepflegte Sätze bleiben unangetastet.
