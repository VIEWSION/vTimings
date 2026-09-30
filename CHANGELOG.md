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

## [1.13.0] – 2026-09-30

### Neu
- Einträge: Kunde und Projekt lassen sich im Filter mehrfach auswählen. API:
  `client_id` und `project_id` nehmen auch Listen (`1,2,3`).
- Die Filter bedingen sich gegenseitig: Kunden- und Projektliste zeigen nur,
  wozu es im gewählten Zeitraum (und bei Status, Suche …) Einträge gibt.
  Was gerade gewählt ist, bleibt in der Liste stehen, auch ohne Einträge.
- Schalter „Archivierte“ bei den Einträgen. Standardmäßig sind archivierte
  Kunden und Projekte samt ihren Einträgen ausgeblendet (auch in Summen,
  Leistungsnachweis und Export); eingeblendet sind sie abgedunkelt und mit
  „Archiv“ gekennzeichnet. API: `archived=0|1`, ohne Angabe gilt kein Filter.
- Stammdaten: archivierte Kunden, Projekte und Teilprojekte deutlicher
  abgedunkelt und mit „Archiv“-Label; hinter Kunden und Projekten steht ein
  Badge mit der Anzahl der Einträge.
- Mehrfachauswahl auch im Papierkorb: „Wiederherstellen“ und „Endgültig
  löschen“. In der normalen Liste gibt es „In den Papierkorb“ für die
  Auswahl. Einzelne Einträge im Papierkorb lassen sich endgültig löschen.
  API: `POST /api/entries/batch/remove`.
- Gemeinsam bearbeiten: Das Satzfeld zeigt in Grau den Satz der Auswahl bzw.
  den Stammdatensatz („≠ unterschiedlich“, wenn sie abweichen). Ein eigener
  Satz schaltet automatisch auf „festen Satz setzen“.
- Abgerechnete Einträge haben einen leicht grünen Hintergrund; die grüne
  Linie bleibt beim Überfahren unverändert.

### Geändert
- Kunden, Projekte und Teilprojekte lassen sich nicht löschen, solange es
  Einträge dafür gibt (auch im Papierkorb). Die Meldung nennt, ob sie im
  Papierkorb liegen; der Löschen-Knopf ist dann gesperrt.

### Behoben
- Nach dem Bearbeiten oder Löschen von Einträgen waren die Auswahlfelder für
  Kunde und Projekt leer, bis die Seite neu geladen wurde.
- Ein gewählter Kunde sprang beim Umschalten des Status oder Zeitraums auf
  „alle“ zurück, wenn es dazu keine Einträge gab.

## [1.12.0] – 2026-09-29

### Neu
- Stundenpakete abrechnen (#6): In den Stammdaten rechnet „Aufgebrauchte
  Pakete abrechnen“ volle oder abgelaufene Pakete der Reihe nach ab. Ihre
  Einträge werden „abgerechnet“ und tragen das Paket. Eine Vorschau zeigt
  vorher, wie viele Pakete und Einträge betroffen sind.
- Fällt ein Eintrag über eine Paketgrenze, wird er dort geteilt
  (voreingestellt, abwählbar). Jedes Paket geht dann genau auf.
- Abgerechnete Pakete zählen fest mit ihren Einträgen. Nachträge fallen in
  das laufende Paket. Stunden und Zeitraum sind gesperrt, Preis und Notiz
  bleiben änderbar. „Abrechnung aufheben“ öffnet das zuletzt abgerechnete
  Paket wieder.
- Einträge zeigen, über welches Stundenpaket sie abgerechnet sind. Der
  Status lässt sich dort nicht einzeln zurücksetzen.

### Geändert
- Einträge: Die Kunden- und Projektauswahl im Filter ist nach „zuletzt
  aktiv“ sortiert. Wo zuletzt gebucht wurde, steht oben, archivierte stehen
  hinten.

## [1.11.0] – 2026-09-29

### Neu
- Stundenkontingente: Für Kunden und Projekte lassen sich vorab gekaufte
  Stundenpakete erfassen (Stammdaten, „Stundenpaket“), jeweils mit
  Stunden, Beginn, optionalem Ablaufdatum, Preis (nur zur Information) und
  Notiz. Abrechenbare Zeiten werden der Reihe nach verrechnet, das älteste
  Paket zuerst. Eine Überziehung zieht das nächste Paket ab. Ohne
  Ablaufdatum verfallen Reststunden nicht. Ein Kundenkontingent gilt für
  alle Projekte ohne eigenes Kontingent.
- Stammdaten zeigen je Kontingent das Guthaben bzw. die Überziehung, das
  laufende Paket und darunter die abgeschlossenen Pakete. Klick auf ein
  Paket öffnet es zum Bearbeiten oder Löschen.
- Kundenportal: Die Karte „Stundenkontingent“ zeigt das aktuelle Paket,
  das Guthaben und auf Wunsch alle Pakete.

### Geändert
- Das bisherige Feld „Budget (Std.)“ am Projekt entfällt. Vorhandene Werte
  werden beim Update (`php bin/console.php migrate`) zu einem ersten
  Stundenpaket ab der ersten Buchung. Nicht abrechenbare Einträge zählen
  nicht mehr gegen das Kontingent.

## [1.10.0] – 2026-09-29

### Neu
- Einträge: Die Auswahlleiste zeigt neben der Anzahl auch Stunden und
  Betrag der angehakten Einträge; das ✕ davor hebt die Auswahl auf.
- Einträge: Mehrfachauswahl wie in Desktop-Programmen – Umschalt-Klick auf
  ein Kästchen oder eine Zeile gibt dem Bereich bis zum zuletzt angeklickten
  Eintrag dessen Zustand, ⌘-/Strg-Klick hakt einen Eintrag an oder ab, ohne
  ihn zu öffnen. ⌘/Strg+A wählt alle geladenen Einträge aus, Esc hebt die
  Auswahl auf (nicht in Eingabefeldern und Dialogen).
- Einträge: Die Liste lädt in Schritten zu 500 und bietet am Ende „Weitere
  500 laden“ und „Alle laden“ an. Oben neben den Summen steht deutlich, wie
  viele von wie vielen geladen sind.

### Behoben
- Einträge: Bei mehr als 500 Treffern (etwa mit Zeitraum „Gesamt“) fehlten
  die älteren Einträge in der Liste ohne jeden Hinweis – die Summen oben
  zählten dagegen alle. Der Hinweis „zeigt … von …“ erschien nie.

## [1.9.0] – 2026-09-29

### Neu
- Leistungsnachweis mit Zusammenfassung für die Rechnung: oben in der
  Druckansicht stehen Bezeichnung (Zeitraum, Gesamtdauer, „Aufwand /
  Effort“), Menge in Stunden und eine Beschreibung mit einer Zeile je Tag
  und Teilprojekt – jeweils mit „Kopieren“-Knopf für die Buchhaltung. Die
  Felder lassen sich vor dem Kopieren anpassen; gedruckt wird die
  Zusammenfassung nicht.
- Leistungsnachweis zweisprachig: Sprache „Deutsch / English“ im Dialog
  setzt alle Beschriftungen deutsch mit englischer Übersetzung (Titel und
  Spaltenköpfe zweizeilig, sonst „Kunde / Customer“). Zahlen und Daten
  bleiben deutsch formatiert. Die Wahl wird wie die übrigen Optionen gemerkt.
- Einträge: Schnellwahl „Zeitraum“ direkt vor Von/Bis – heute, diese und
  letzte Woche, dieser und letzter Monat, dieses und letztes Quartal, dieses
  und letztes Jahr, gesamt, dazu jedes Jahr mit Einträgen als ganzes Jahr.
  Eigene Daten zeigen „Benutzerdefiniert“. Die angebotenen Jahre richten
  sich nach den übrigen Filtern (z. B. nur Jahre, in denen der gewählte Kunde
  Einträge hat).
- Neues, monochromes App-Symbol: Stoppuhr mit offenem Ring, deren Zeiger ein
  „v“ bilden. Das Favicon passt sich hellem und dunklem Browser an.
- „Über vTimings“: Ein Klick auf den Namen oben links zeigt Version und
  Kurzbeschreibung, für Administratoren außerdem Links zu Changelog,
  Quellcode und Wünschen/Fehlern auf GitHub.

### Geändert
- Der vorgeschlagene PDF-Dateiname des Leistungsnachweises beginnt mit
  „AN_“, damit Buchhaltungen ihn automatisch zuordnen können.
- Einträge: Alle sichtbaren Einträge wählt jetzt ein Kästchen in der
  Summenzeile aus bzw. ab (teilweise Auswahl wird angezeigt). Die Knöpfe
  „Alle sichtbaren auswählen“ und „Auswahl aufheben“ in der Auswahlleiste
  entfallen, ebenso die Zeitraum-Chips unter den Filtern.

### Behoben
- Safari: Der Druckdialog des Leistungsnachweises verschwand nach etwa drei
  Sekunden, danach war die Vorschau leer. Ursache: Ein per Skript
  ausgelöster Druck hält in Safari den Webprozess an, den sich die Vorschau
  mit dem vTimings-Tab teilt; Safari hielt diesen für abgestürzt und beendete
  ihn. In Safari wird deshalb nur noch über ⌘P gedruckt (Hinweis statt Knopf
  in der Leiste), andere Browser drucken weiter über den Knopf.

## [1.8.0] – 2026-09-29

### Neu
- Darstellung wählbar: automatisch (folgt dem System), hell oder dunkel –
  Symbol oben rechts neben dem Abmelden, schaltet reihum. Die Wahl gilt für
  den Browser und greift schon beim Laden, ohne kurzes Aufblitzen.
- Dialoge legen einen abgedunkelten, weichgezeichneten Schleier über den
  Hintergrund und erscheinen mit einer kurzen Animation (mobil als Blatt von
  unten; bei „Bewegung reduzieren“ ohne).
- Ein Klick auf einen Eintrag öffnet ihn zum Bearbeiten (auch per Enter);
  die Stift- und Papierkorb-Symbole in der Liste entfallen. Gelöscht wird im
  Bearbeiten-Dialog über das Papierkorb-Symbol links unten, mit Rückfrage.
- Einheitliche, schlichte Liniensymbole überall (Tabbar, Stammdaten,
  Zugänge, Timer, Zeitschritte) statt Schriftzeichen wie ✎ 🗑 ▶.

### Geändert
- Dialoge ohne „Abbrechen“-Button – geschlossen wird über das ✕ oben, Esc
  oder einen Klick daneben. Speichern/Übernehmen ist ein Häkchen,
  Herunterladen und Öffnen haben eigene Symbole; die Beschriftung steht im
  Tooltip. Bei zwei übereinanderliegenden Dialogen schließt Esc nur den
  oberen.
- Überarbeitetes Erscheinungsbild: ruhigere Farben in hell und dunkel,
  einheitlicher Fokusring, Eingabefelder und Auswahllisten mit gleichem Pfeil
  wie die Kunden-/Projektauswahl, Buttons mit Hover- und Klickzustand,
  gestaltete Dateiauswahl, Tabellenköpfe abgesetzt, Kopfzeile und Tabbar
  durchscheinend.

### Behoben
- Zu wenig Abstand über den Feldbeschriftungen in Dialogen (u. a. Eintrag
  bearbeiten, Sammelbearbeiten, Leistungsnachweis): die Beschriftung klebte
  am Feld darüber.

## [1.7.0] – 2026-09-29

### Neu
- Auswahlfelder für Kunde, Projekt und Teilprojekt zeigen die hinterlegten
  Farben (Projekte erben die Kundenfarbe) und haben ab acht Einträgen ein
  Suchfeld – Tippen grenzt ein, Enter übernimmt den ersten Treffer.
  Bedienbar mit Pfeiltasten, Enter und Esc.
- Gilt für die Filter in „Einträge“ und den Zugangs-Dialog; die sichtbaren
  Projekte eines Kundenzugangs werden dort per Häkchen gewählt statt mit
  Cmd-Klick in einer Mehrfachliste.
- Status „offen“ / „abgerechnet“ beim Anlegen, Bearbeiten und im
  Sammelbearbeiten – bisher gab es keinen Weg, Einträge als abgerechnet zu
  markieren. „Abgerechnet“ wendet zuerst die übrigen Änderungen an und
  sperrt dann; „offen“ gibt gesperrte Einträge wieder frei und korrigiert sie
  im selben Schritt. Einträge, die an einer Rechnung hängen, bleiben gesperrt.
- Bearbeiten-Dialog eines abgerechneten Eintrags: Felder ausgegraut mit
  Hinweis, frei erst nach Wechsel auf „offen“.

### Geändert
- Status als Symbol vor der Dauer: grünes Häkchen = abgerechnet (Datum und
  ggf. Rechnungsnummer als Tooltip), dezenter leerer Kreis = offen – jede
  Zeile hat ein Symbol, die Proportionen bleiben gleich. Abgerechnete
  Einträge haben zusätzlich einen grünen Rahmen; im Kalender steht das
  Häkchen vor der Uhrzeit. Das Etikett „Rechnung —“ und das Abblenden
  entfallen. Die Sperrmeldung sagt, wie man sie wieder freigibt.

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
