# CLAUDE.md

Projektkontext für Claude Code. Für Architektur, API-Referenz, Setup und
Betrieb siehe [README.md](README.md) – hier stehen nur Dinge, die beim
*Arbeiten* an diesem Repo wichtig sind: Konventionen, die nicht aus dem Code
allein ersichtlich sind, bekannte Stolperfallen und Testzugänge.

## Was das ist

Ersatz für die macOS-App *Timings* (Zeiterfassung), die mit dem Wegfall von
Rosetta nicht mehr läuft. PHP 8.2+/SQLite-Backend, Vanilla-JS-Frontend ohne
Build-Schritt, kein Framework. Der Anwender (Matthias) ist Web-Entwickler,
Deutsch als Projektsprache – Code-Kommentare, Commit-Messages und die
Oberfläche selbst sind durchgehend Deutsch.

## Backlog

Feature-Wünsche und Bugs stehen als GitHub Issues unter
[VIEWSION/vTimings](https://github.com/VIEWSION/vTimings/issues), nicht in
diesem Repo als Datei. `gh issue list --repo VIEWSION/vTimings` vor größeren
Änderungen prüfen, ob es dazu schon einen offenen Punkt gibt.

## Frontend-Konventionen (nicht optional)

Diese drei Regeln existieren wegen eines konkreten Vorfalls: eine Ansicht
hängte ihren Klick-Handler an ein Element, das jedes Neuzeichnen überlebt.
Pro Durchlauf kam ein weiterer Handler dazu, ein Klick löste die Aktion
vervielfacht aus, die CPU ging hoch. Seitdem:

1. **Nie `root.addEventListener(...)` direkt in einer View.** Immer
   `bindOnce(root, 'EindeutigerKey', 'click', handler)` aus `assets/js/ui.js`.
   Der Key muss je View eindeutig sein (wird als `data-bound<Key>`-Attribut
   geführt). Alle bestehenden Views (`timer.js`, `master.js`, `reports.js`,
   `portal.js`) nutzen das – neue Views ebenso.
2. **Der Router gibt jeder View ein frisches `#view`-Element**
   (`app.js`, `route()`): `app.querySelector('#view').replaceWith(host)`
   statt `innerHTML` auf dem bestehenden Element. Daran nichts ändern, ohne
   Punkt 1 erneut zu berücksichtigen – beides zusammen verhindert das
   Anhäufen von Listenern.
3. **Modul-State statt Closures für den View-Zustand**, wenn eine View sich
   selbst neu zeichnet (Beispiel: `portal.js` mit `let data`, `let selected`
   auf Modulebene, `paint(root)` als reine Zeichenfunktion). Das hält
   `render()` und Klick-Handler synchron, ohne dass bindOnce mit alten
   Closures arbeitet.

Templating: `html\`...\`` aus `util.js` escaped automatisch, verschachtelte
`html\`\`\`-Ergebnisse werden nicht doppelt escaped (liefert eine `Html`-
Instanz). Rohes Markup nur explizit über `raw()` oder `{ __raw: '...' }`.
**Nie** `${wert}` für Text verwenden, der aus der API kommt, ohne dass es
durch `html\`\`` läuft – das ist der einzige XSS-Schutz im Frontend.

**Sprache:** Kein sichtbarer Text gehört fest in eine View. Beschriftungen
kommen aus `assets/js/i18n.js` über `t('schlüssel')`, Zahlen und Daten über
`money()`/`decimal()`/`formatDate()`/`dayLabel()` aus `util.js` – die kennen
die Sprache und legen die passenden `Intl`-Formatierer an. Neue Schlüssel
immer in **beiden** Blöcken (`de` und `en`) eintragen; `de` ist die
Leitsprache und dient als Rückfallebene. Konstanten auf Modulebene dürfen
kein `t()` enthalten (das liefe einmal beim Laden und bliebe dann stehen) –
stattdessen eine Funktion, siehe `ADMIN_NAV()` in `app.js` und
`groupLabel()` in `reports.js`. Wo die gewählte Sprache gespeichert wird,
steht im README-Abschnitt „Sprache“.

Formulare in Dialogen: `saveDialog()` + `showFieldErrors()` aus `ui.js`
verwenden, nicht `dialog()` direkt mit manuellem try/catch. `saveDialog`
hält den Dialog bei einem Fehler offen (Eingaben bleiben erhalten) und
`showFieldErrors` ordnet 422-Feldfehler den Eingabefeldern zu statt nur
einen Toast zu zeigen. Vorher (bis inkl. Commit `91e110a`) schloss sich der
Dialog bei jedem Fehler und die Eingaben waren weg – das war ein Bug, kein
gewolltes Verhalten.

## Backend-Konventionen

**Zeit:** UTC-Unixtimestamp in der DB, `Support\Clock` übersetzt in die
App-Zeitzone erst bei der Anzeige. Gruppierungen nach Tag/Monat/Woche/Jahr
rechnet PHP (`EntryRepo::grouped()`), nicht SQL – SQLite hat keine
Zeitzonendatenbank, ein fester Offset läge an Umstellungstagen daneben.
Bei neuen zeitbasierten Auswertungen diesem Muster folgen, nicht `strftime`
direkt auf `started_at` anwenden.

**Sichtbarkeit:** `Repo\Scope` wird in jedem Repository angewandt, nicht im
Controller. Ein Kundenzugang darf dadurch auch dann keine fremden Daten
sehen, wenn eine Route die Prüfung vergisst. Neue Repository-Methoden mit
Datenzugriff müssen `Scope::current()` einbeziehen (siehe `ClientRepo`,
`EntryRepo` als Vorlage) – nicht die Filterung dem aufrufenden Controller
überlassen.

**Farben:** Projekte/Teilprojekte ohne eigene Farbe erben die Kundenfarbe.
Für Darstellungen, die mehrere Projekte desselben Kunden gleichzeitig und
unterscheidbar zeigen (z. B. der segmentierte Tagesbalken im Kundenportal),
reicht die geerbte Farbe nicht – siehe `PortalController::PALETTE` als
Muster für eine Ersatzpalette.

## Bekannte Baustellen (aus offenen Issues)

- **#3 Kunden-Zeit-Offset:** Kundenportal zeigt aktuell ungefiltert bis zur
  Sekunde. Gewünscht: pro Kunde einstellbare Sichtbarkeitsgrenze nach
  Kalendertag (nicht rollierende Stunden), damit frische/unfertige Einträge
  nicht sofort sichtbar sind.
- **#4 Druckausgabe leer:** Safari auf dem Mac erzeugt aus der Druckansicht
  ein leeres bzw. unvollständiges PDF.
- **#1 Projekt-Selektion:** Klickbarkeit bei nur einem Projekt behoben
  (`e7369d1`). Offen: Höhenzittern zwischen `.badge` und `.btn--small`
  (unterschiedliche `min-height`) beim Umschalten der Projektauswahl im
  Portal-Kopf.

## Testzugänge (lokal)

```
Admin:  info@viewsion.de / vTimings-dev-2026
Kunde:  kunde@prophysio.test / portal-test-2026   (client_id=1, prophysio)
```

Beide nur für die lokale Entwicklungsumgebung unter `http://localhost/vTimings/`.
Vor jedem Livegang laut README ändern/entfernen. Testkonten, die während
einer Session zu Prüfzwecken angelegt werden, danach wieder löschen
(`php bin/console.php user:list` zeigt alle Zugänge) – mehrfach sind
Test-Accounts (`viewsion@me.com` u. ä.) liegen geblieben, weil das
vergessen wurde.

## Datenbestand

Lokale DB enthält den echten CSV-Import aus der alten Timings-App: 110
Kunden, ~320 Projekte, ~425 Teilprojekte, ~8.844 Einträge, Zeitraum 2005–
heute. Reale Kundennamen und Notizen – beim Anlegen von Testdaten (z. B. für
Screenshots oder um einen Edge Case wie „mehrere Projekte an einem Tag“
nachzustellen) hinterher wieder löschen, nicht im Bestand liegen lassen.

## Nach jeder Änderung

```bash
# PHP
find src bin templates -name "*.php" -exec php -l {} \; | grep -v "No syntax errors"

# JS (Syntax-Check, kein Linter vorhanden)
for f in assets/js/*.js assets/js/views/*.js assets/sw.js; do node --check "$f"; done
```

Kein Test-Framework, kein Build-Schritt. Änderungen an `assets/js/*` oder
`assets/css/*` im Browser mit `cache: 'reload'` neu laden (der Service
Worker cacht die Programmhülle) oder Hard-Reload, bevor man im Browser
testet – sonst hängt man an altem Cache-Stand fest und diagnostiziert
Phantomfehler.
