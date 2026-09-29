<?php
/**
 * Leistungsnachweis – Standardvorlage.
 *
 * Verfügbar: $report (Anzeigemodell aus dem ReportBuilder),
 *            $t (Translator: $t('key') als Klartext, $t->label('key') als
 *                HTML – zweisprachig mit .l-de/.l-en),
 *            $ui (Translator in der Sprache der Oberfläche, für
 *                 Bedienelemente, die nicht gedruckt werden),
 *            $css (Inhalt von print.css).
 *
 * @var array                     $report
 * @var VT\Report\Translator      $t
 * @var VT\Report\Translator      $ui
 * @var string                    $css
 */

$e = static fn($value): string => htmlspecialchars((string) $value, ENT_QUOTES);

$opt = $report['options'];
$client = $report['client'];
$project = $report['project'];
$issuer = $report['issuer'];
$currency = $report['meta']['currency'];

// Wird beim Drucken zum Vorschlag für den PDF-Dateinamen. Das Präfix
// "AN_" hat ein Kunde verlangt: dessen Buchhaltung erkennt Leistungsnachweise
// automatisch daran – nicht entfernen.
$documentTitle = sprintf(
    'AN_%s - %s - %s - %s–%s',
    $t->primary('title'),
    $client['name'] ?? '',
    $project['name'] ?? $t->primary('all_projects'),
    $report['period']['first_date'],
    $report['period']['last_date']
);
?>
<!doctype html>
<html lang="<?= $e($t->htmlLang()) ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= $e($documentTitle) ?></title>
<link rel="icon" href="assets/icons/favicon.svg" type="image/svg+xml">
<style><?= $css ?></style>
</head>
<body>

<div class="toolbar">
    <button class="primary" type="button" data-print><?= $e($ui('ui_print')) ?></button>
    <span class="toolbar__hint" data-print-hint hidden><kbd>⌘</kbd><kbd>P</kbd> <?= $e($ui('ui_print')) ?></span>
    <span class="spacer"></span>
    <span><?= $e($report['totals']['hhmm']) ?> ·
        <?= $e($t->number($report['totals']['decimal'])) ?> h ·
        <?= (int) $report['totals']['entries'] ?> <?= $e($ui('entries')) ?></span>
</div>

<?php $summary = $report['summary']; ?>
<details class="summary" open>
    <summary><?= $e($ui('ui_summary')) ?> <span class="summary__hint"><?= $e($ui('ui_not_printed')) ?></span></summary>
    <div class="summary__row">
        <label class="summary__field summary__field--grow">
            <span><?= $e($ui('ui_label')) ?></span>
            <input type="text" id="sum-label" value="<?= $e($summary['label']) ?>">
        </label>
        <button type="button" data-copy="sum-label"><?= $e($ui('ui_copy')) ?></button>
        <label class="summary__field">
            <span><?= $e($ui('ui_quantity')) ?></span>
            <input type="text" id="sum-qty" class="summary__qty" value="<?= $e($summary['quantity']) ?>">
        </label>
        <button type="button" data-copy="sum-qty"><?= $e($ui('ui_copy')) ?></button>
    </div>
    <div class="summary__row">
        <label class="summary__field summary__field--grow">
            <span><?= $e($ui('ui_lines')) ?></span>
            <textarea id="sum-lines" rows="<?= min(12, max(3, substr_count($summary['lines'], "\n") + 1)) ?>"><?= $e($summary['lines']) ?></textarea>
        </label>
        <button type="button" data-copy="sum-lines"><?= $e($ui('ui_copy')) ?></button>
    </div>
</details>

<div class="sheet">

    <?php
    // Briefkopf nur zeigen, wenn Absenderdaten gepflegt sind – sonst
    // klaffte oben eine leere Fläche.
    $hasHead = $opt['logo'] && ($issuer['logo'] !== '' || $issuer['name'] !== '' || $issuer['address'] !== '');
    ?>
    <?php if ($hasHead): ?>
        <header class="head">
            <div class="head__logo">
                <?php if ($issuer['logo'] !== ''): ?>
                    <img src="<?= $e($issuer['logo']) ?>" alt="">
                <?php elseif ($issuer['name'] !== ''): ?>
                    <div class="head__logo-text"><?= $e($issuer['name']) ?></div>
                <?php endif; ?>
            </div>
            <?php if ($issuer['address'] !== ''): ?>
                <div class="head__issuer"><?= $e($issuer['address']) ?></div>
            <?php endif; ?>
        </header>
    <?php endif; ?>

    <h1 class="title <?= $hasHead ? '' : 'title--top' ?>"><?= $t->label('title') ?></h1>

    <dl class="meta">
        <dt><?= $t->label('customer') ?></dt>
        <dd><?= $e($client['name'] ?? '—') ?></dd>

        <dt><?= $t->label($report['meta']['multi_project'] ? 'projects' : 'project') ?></dt>
        <dd><?= $project !== null ? $e($project['name']) : $t->label('all_projects') ?></dd>

        <dt><?= $t->label('period') ?></dt>
        <dd><?= $e($report['period']['first_date']) ?> – <?= $e($report['period']['last_date']) ?></dd>

        <dt><?= $t->label('effort') ?></dt>
        <dd><?= $e($report['totals']['hhmm']) ?>
            (<?= $e($t->number($report['totals']['decimal'])) ?> h)</dd>
    </dl>

    <p class="listing__label"><?= $t->label('listing') ?></p>

    <table class="items">
        <thead>
            <tr>
                <th class="col-date"><?= $t->label('date') ?></th>
                <?php if ($opt['times']): ?>
                    <th class="col-time"><?= $t->label('time') ?></th>
                <?php endif; ?>
                <th><?= $t->label('description') ?></th>
                <th class="col-dur"><?= $t->label('duration') ?></th>
                <?php if ($opt['costs']): ?>
                    <th class="col-rate"><?= $t->label('rate') ?></th>
                    <th class="col-sum"><?= $t->label('amount') ?></th>
                <?php endif; ?>
            </tr>
        </thead>
        <tbody>
        <?php foreach ($report['rows'] as $row): ?>
            <tr>
                <td class="col-date"><?= $e($row['date_label']) ?></td>

                <?php if ($opt['times']): ?>
                    <td class="col-time"><?= $e($row['start']) ?>–<?= $e($row['end']) ?><?php
                        // Ohne diesen Hinweis liest sich "20:00–01:15" wie ein Fehler.
                        if (!empty($row['overnight'])): ?><sup class="overnight">+1</sup><?php endif; ?></td>
                <?php endif; ?>

                <td>
                    <div class="item__title"><?= $e($row['title']) ?><?php
                        if (($row['count'] ?? 1) > 1): ?> <span class="item__count">(<?= (int) $row['count'] ?>×)</span><?php
                        endif; ?></div>
                    <?php if ($opt['notes'] && trim((string) $row['note']) !== ''): ?>
                        <p class="item__note"><?= $e($row['note']) ?></p>
                    <?php endif; ?>
                </td>

                <td class="col-dur"><?= $e($row['hhmm']) ?></td>

                <?php if ($opt['costs']): ?>
                    <td class="col-rate"><?= $e($t->number((float) ($row['rate'] ?? 0))) ?></td>
                    <td class="col-sum"><?= $e($t->money((float) ($row['amount'] ?? 0), $currency)) ?></td>
                <?php endif; ?>
            </tr>
        <?php endforeach; ?>
        </tbody>
    </table>

    <div class="totals">
        <span class="totals__label"><?= $t->label('total') ?></span>
        <div class="totals__values">
            <div class="totals__hours">
                <?= $e($report['totals']['hhmm']) ?>
                <span class="totals__hint">|
                    <?= $e($t->number($report['totals']['decimal'])) ?> <?= $t->label('total_hours') ?></span>
            </div>
            <?php if ($opt['costs'] && $report['totals']['amount'] !== null): ?>
                <div class="totals__amount">
                    <?= $e($t->money((float) $report['totals']['amount'], $currency)) ?>
                    <span class="totals__hint"><?= $t->label('net') ?></span>
                </div>
            <?php endif; ?>
        </div>
    </div>

    <?php if ($opt['logo'] && ($issuer['footer'] !== '' || $issuer['contact'] !== '')): ?>
        <footer class="footer">
            <span><?= $e($issuer['footer']) ?></span>
            <span><?= $e($issuer['contact']) ?></span>
        </footer>
    <?php endif; ?>

</div>

<script>
(function () {
    // Safari: window.print() hält den Webprozess an, solange der Druckdialog
    // offen ist. Teilen sich weitere, gerade unsichtbare Tabs derselben Seite
    // den Prozess (die App, aus der der Nachweis geöffnet wurde), hält Safari
    // sie nach ~3 s für hängend und beendet den ganzen Prozess – Dialog weg,
    // Vorschau leer. Über ⌘P bzw. „Ablage > Drucken“ passiert das nicht, weil
    // dabei kein Skript wartet. In Safari daher kein Knopf, sondern der
    // Hinweis auf ⌘P; alle anderen Browser drucken über den Knopf.
    var isSafari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
    var button = document.querySelector('[data-print]');

    if (isSafari) {
        button.hidden = true;
        document.querySelector('[data-print-hint]').hidden = false;
    } else {
        button.addEventListener('click', function () { window.print(); });
    }

    // Zusammenfassung in die Zwischenablage.
    function copyText(field) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(field.value);
        }
        field.select();
        return document.execCommand('copy') ? Promise.resolve() : Promise.reject();
    }

    document.querySelectorAll('[data-copy]').forEach(function (button) {
        var label = button.textContent;
        button.addEventListener('click', function () {
            copyText(document.getElementById(button.dataset.copy)).then(function () {
                button.textContent = <?= json_encode($ui('ui_copied'), JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?>;
                button.classList.add('is-done');
                setTimeout(function () {
                    button.textContent = label;
                    button.classList.remove('is-done');
                }, 1500);
            });
        });
    });
})();
</script>
</body>
</html>
