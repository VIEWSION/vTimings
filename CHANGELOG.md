# Changelog

Alle nennenswerten Änderungen an vTimings. Format nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach
[Semantic Versioning](https://semver.org/lang/de/): **Major** bei Brüchen in
API oder Datenbestand, die Handarbeit erfordern, **Minor** bei neuen
Funktionen, **Patch** bei reinen Fehlerbehebungen.

Die aktuelle Version steht in der Datei `VERSION` und erscheint oben links in
der Oberfläche, in `GET /api/health` und in `php bin/console.php status`.

Die Versionen bis 1.5.0 wurden nachträglich aus der Git-Historie
zusammengestellt.

## [1.6.0] – 2026-09-29

### Neu
- Versionsnummer dezent oben links neben „vTimings“, dazu dieses Changelog.

### Geändert
- Kopfzeile: Abmelden ist ein Power-Symbol, der Sprachumschalter steht rechts
  daneben. Beide sind von den Menüpunkten abgesetzt, die etwas mehr Abstand
  untereinander haben.
- Abmelden ist jetzt auch auf schmalen Displays erreichbar (vorher nur in der
  Desktop-Navigation).
- Einheitlicher Abstand zwischen allen Karten – vorher lagen Summe,
  Gruppierung und Tabelle in den Einträgen sowie die Karten der
  Benutzerverwaltung direkt aneinander.
- Dialoge setzen den Fokus auf das erste Feld im Inhalt statt auf das ✕ – im
  Teilprojekt-Picker kann man sofort lostippen, beim Löschen steht der Fokus
  auf „Abbrechen“.

## [1.5.0] – 2026-09-29

### Neu
- Einträge: Darstellung „Summen“ neben Liste und Kalender, mit Gruppierung
  nach Kunde, Projekt, Teilprojekt, Tag, Woche, Monat oder Jahr.
- Leistungsnachweis und Export direkt aus den Einträgen, als Dialog – über
  die aktuellen Filter oder über die angehakten Einträge. Der Dialog nennt
  den Umfang und warnt bei aktiver Suche, fehlendem oder mehreren Kunden.
- API: `stats`, `export` und `report` nehmen `ids=…` für eine ausdrückliche
  Auswahl sowie alle Filter der Einträge (auch Teilprojekt und Suche).

### Geändert
- Abgerechnete Einträge lassen sich anhaken (für einen erneuten Nachweis);
  das Sammelbearbeiten lässt sie unverändert und sagt das vorher.

### Entfernt
- Eigene Seite „Auswertung“. `#/auswertung` leitet auf die Einträge um.

## [1.4.0] – 2026-09-29

### Neu
- Anmeldung: „Angemeldet bleiben“ (90 Tage, verlängert sich bei Nutzung).
- Filter und Ansichten bleiben über ein Neuladen erhalten – Einträge,
  Auswertung, Stammdaten, Kundenportal; je Benutzer getrennt.
- Einträge: mehrere auswählen und gemeinsam bearbeiten – Teilprojekt,
  Stundensatz, abrechenbar (`POST /api/entries/batch`). Zeiten und Notizen
  bewusst ausgenommen.
- Einträge: Stundensatz dezent je Eintrag sichtbar.

### Geändert
- Einträge-Liste mit Abstand zwischen den Einträgen.
- Sitzung ohne „Angemeldet bleiben“ endet mit dem Browser bzw. nach 12 h
  ohne Aktivität. Sitzungsdateien liegen in `data/sessions/`.

### Behoben
- Häufiges Abmelden: Sitzungen im gemeinsamen PHP-Ordner wurden von anderen
  Anwendungen nach 24 Minuten weggeräumt.
- Nach einer erneuerten Sitzung schlugen Schreibzugriffe mit 419 fehl; die
  Oberfläche holt das CSRF-Token jetzt nach und wiederholt den Aufruf.

## [1.3.0] – 2026-08-10

### Neu
- Einträge: Kalenderdarstellung (Tag, Woche, Monat) als Alternative zur Liste.
- Stammdaten: Sortierung nach „zuletzt aktiv“, wahlweise alphabetisch.

### Behoben
- Leistungsnachweis: leeres bzw. unvollständiges PDF beim Drucken aus Safari
  (#4).

## [1.2.0] – 2026-08-08

### Neu
- Oberfläche und Ausdrucke auf Deutsch und Englisch, umschaltbar (#2).

## [1.1.0] – 2026-08-08

### Neu
- Kundenportal: Übersicht der letzten 100 Tage mit Tagesbalken je Projekt
  und Projektauswahl.
- Kundenportal: einstellbarer Sichtbarkeits-Offset je Kunde nach Kalendertag
  (#3).

### Behoben
- Leistungen-Ansicht des Kundenportals; Filter erweitert.
- Projektauswahl im Portal nur noch bei mehreren Projekten (#1), ohne
  Höhenzittern der Kopfzeile.
- Formular-Dialoge bleiben bei Fehlern offen, Fehler stehen am Feld.

## [1.0.0] – 2026-08-08

### Neu
- Erste Version als Ersatz für die macOS-App *Timings*: PHP/SQLite-API,
  Weboberfläche ohne Build-Schritt, Timer, Einträge, Stammdaten (Kunde →
  Projekt → Teilprojekt), Auswertung, Leistungsnachweis, Export,
  CSV-Import aus Timings, Kundenzugänge.
