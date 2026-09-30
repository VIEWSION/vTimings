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

## Anmeldung und gemerkte Einstellungen

**Angemeldet bleiben** (Häkchen beim Anmelden, Vorgabe an): Die eigentliche
Sitzung endet mit dem Browser bzw. nach `session_lifetime` (12 h) ohne
Aktivität. Zusätzlich setzt die App ein Cookie `vtsid_r` mit einem
Zufallstoken (Tabelle `remember_tokens`, nur der Hash). Läuft die Sitzung ab,
eröffnet sie darüber still eine neue; die Laufzeit (`remember_lifetime`,
90 Tage) verlängert sich bei jeder Nutzung. Abmelden entwertet das Token des
Browsers, ein Passwortwechsel die aller anderen Geräte. Das neue CSRF-Token
holt sich die Oberfläche bei einer 419 selbst nach (`api.js`).

Sitzungsdateien liegen in `data/sessions/`, nicht im systemweiten Ordner –
dort räumen andere PHP-Anwendungen mit ihrer eigenen `gc_maxlifetime` auf
(unter MAMP 24 Minuten) und nehmen fremde Sitzungen mit.

**Filter und Ansichten** (Zeitraum, Kunde/Projekt, Suche, Status, Liste/
Kalender/Summen, Gruppierung, Druck- und Exportoptionen, Stammdaten-Auswahl) merkt sich der
Browser im `localStorage`, je Benutzer getrennt (`assets/js/prefs.js`). Ein
Schnellzeitraum wie „Dieser Monat“ wird als solcher gespeichert und beim
nächsten Aufruf neu berechnet. Der Ankertag im Kalender liegt im
`sessionStorage`: er übersteht ein Neuladen, ein neuer Tab beginnt bei heute.

**Darstellung** (automatisch/hell/dunkel, Symbol oben rechts) liegt als
`vt.theme` im `localStorage` – für den ganzen Browser, nicht je Benutzer, weil
sie schon vor der Anmeldung gilt. Ein kleines Inline-Skript in `index.php`
setzt `html[data-theme]`, bevor das Stylesheet zeichnet; ohne Eintrag folgt
die Oberfläche dem System (`assets/js/theme.js`).

**Version:** steht in `VERSION`, die Änderungen je Version in
[CHANGELOG.md](CHANGELOG.md).

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
4. **Schreibrechte** braucht nur `data/` (Datenbank, Logs, Sicherungen,
   Sitzungen).
5. **nginx statt Apache?** Die `.htaccess` wirkt dort nicht. Nötig sind: `/api/`
   und `/report` auf `api.php`, alles Übrige auf `index.php`, und ein
   `location ~ ^/(data|src|migrations|bin)/ { deny all; }`.

Eingebaut sind Argon2id-Passwörter, `HttpOnly`/`Secure`/`SameSite=Strict`-Cookies
(auch für „Angemeldet bleiben“),
Sitzungswechsel beim Anmelden, CSRF-Token auf allen schreibenden Aufrufen und
eine Login-Bremse mit wachsender Sperrzeit je IP und je E-Mail.

---

## API

Anmeldung über Sitzungs-Cookie (Web) oder `Authorization: Bearer …` (native
Clients, Tokens in den Einstellungen). Schreibende Aufrufe per Cookie brauchen
zusätzlich `X-CSRF-Token` aus `GET /api/auth/me`.

```
GET    /api/health                     ohne Anmeldung
POST   /api/auth/login · logout · password   login: { email, password, remember }
GET    /api/auth/me                    enthält die Oberflächensprache
PATCH  /api/auth/lang                  { "lang": "de" | "en" }

GET    /api/tree                       Kunden > Projekte > Teilprojekte mit Summen
CRUD   /api/clients · projects · subprojects

GET    /api/budgets?client_id&project_id   Stundenkontingente mit Verbrauch (s. u.)
POST   /api/budgets                    { client_id, project_id?, hours, starts_on,
                                         expires_on?, price?, note? }
PATCH  /api/budgets/{id}
DELETE /api/budgets/{id}
POST   /api/budgets/bill               { client_id, project_id?, split = true, dry_run }
                                         aufgebrauchte Pakete abrechnen (s. u.)
DELETE /api/budgets/{id}/bill          Abrechnung des zuletzt abgerechneten Pakets aufheben

GET    /api/entries?from&to&client_id&project_id&q&billed&archived&group=day
                                       client_id/project_id auch als Liste (1,2,3);
                                       archived=0 blendet Einträge archivierter
                                       Kunden/Projekte aus (ohne Angabe: alle)
POST   /api/entries
PATCH  /api/entries/{id}               billed: true|false setzt den Status (s. u.)
POST   /api/entries/batch              { ids, subproject_id?, rate_mode?: keep|inherit|fixed,
                                         rate?, billable?, billed?: true|false }
                                         – keine Zeiten/Notizen. billed=false öffnet
                                         abgerechnete Einträge wieder (nicht mit Rechnung),
                                         sonst bleiben sie gesperrt und werden übersprungen
DELETE /api/entries/{id}               Papierkorb
POST   /api/entries/batch/remove       { ids, action: trash|restore|purge } – mehrere auf einmal;
                                       abgerechnete werden nicht gelöscht, purge nur aus dem Papierkorb
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

       stats, export und report nehmen dieselben Filter wie /api/entries
       (from, to, client_id, project_id, subproject_id, q, billed, archived) oder
       ids=12,15,19 für eine ausdrückliche Auswahl (höchstens 1000).

GET    /api/portal                     Kundenportal
CRUD   /api/users · /api/tokens        nur Administratoren
POST   /api/import/timings-csv?dry_run=1
```

### Konflikt beim Timer

Läuft schon ein Timer, antwortet `POST /api/timer/start` mit **409** und
`code: timer_running`. Die Antwort enthält den laufenden Timer und die
möglichen Auflösungen. Erst ein erneuter Aufruf mit `on_conflict=stop` oder
`=parallel` handelt.

### Stundenkontingente

Ein Kontingent besteht aus vorab gekauften Stundenpaketen, entweder für ein
Projekt oder ohne `project_id` für alle Projekte eines Kunden, die kein
eigenes haben. Den Verbrauch speichert die Datenbank nicht; `BudgetRepo`
rechnet ihn bei jedem Abruf aus:

- Gezählt werden abrechenbare Zeiteinträge ab dem Beginn des ersten Pakets.
- Die Einträge werden in zeitlicher Reihenfolge verrechnet, das älteste
  Paket zuerst.
- Was kein Paket mehr aufnimmt, ist Überziehung (`balance_hours` negativ).
  Ein neues Paket zieht sie ab, auch wenn es erst später beginnt.
- Mit `expires_on` nimmt ein Paket nach diesem Tag nichts mehr auf. Seine
  Reststunden verfallen dann (`expired_hours`). Ohne `expires_on` verfallen
  sie nie.
- Gerechnet wird nur in Stunden. `price` ist eine reine Information und für
  Kundenzugänge ohne Kostenrecht nicht sichtbar. Ein später erhöhter
  Stundensatz ändert am Kontingent nichts.

**Abrechnen.** `POST /api/budgets/bill` rechnet die aufgebrauchten oder
abgelaufenen Pakete eines Kontingents der Reihe nach ab. Ihre Einträge
werden „abgerechnet“ und tragen das Paket in `budget_id`, so wie
`invoice_id` die Rechnung. Einen neuen Status gibt es nicht.

- Fällt ein Eintrag über eine Paketgrenze, teilt ihn `split` genau an der
  Grenze in zwei Einträge. Jedes Paket geht dann auf die Minute auf.
- Ohne `split` gehört der Eintrag ganz zu dem Paket, in dem er vollständig
  bezahlt ist. Die Differenz geht als Übertrag (`carry_hours`) weiter.
- Ab dann zählt ein abgerechnetes Paket fest mit genau seinen Einträgen. Ein
  nachgetragener alter Eintrag fällt dadurch in das laufende Paket, statt
  abgerechnete zu verschieben.
- Über ein Paket abgerechnete Einträge lassen sich nicht einzeln wieder
  öffnen, sondern nur über `DELETE /api/budgets/{id}/bill`. Das geht jeweils
  für das zuletzt abgerechnete Paket.
- Bei abgerechneten Paketen stehen Stunden, Zeitraum und Zuordnung fest.

`/api/tree`, `/api/projects` und `/api/portal` liefern die Kontingente mit:
als `budget` an Kunde und Projekt, im Portal als `budgets`. `progress` am
Projekt zeigt weiterhin das laufende Paket. Das frühere Feld
`projects.budget_hours` ist mit Migration 0004 in ein erstes Paket
übergegangen und wird nicht mehr gelesen.

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
php bin/console.php import --file=Export.csv --alias="Meier=Dr. Meier,Muster Druck=Muster Druck GmbH"
```

Stundensätze werden aus den Einträgen abgeleitet: der zuletzt tatsächlich
verwendete Satz, je Kunde und je Projekt – letzteres nur, wenn er vom
Kundensatz abweicht. Bereits gepflegte Sätze bleiben unangetastet.

## Lizenz

MIT – siehe [LICENSE](LICENSE). „Timings“ ist eine Software eines anderen
Herstellers; vTimings ist ein unabhängiger Ersatz und liest lediglich deren
CSV-Export.
