<?php
/**
 * Leistungsnachweis – Standardvorlage.
 *
 * Verfügbar: $report (Anzeigemodell aus dem ReportBuilder),
 *            $t (Translator, aufrufbar als $t('key')),
 *            $css (Inhalt von print.css).
 *
 * @var array                     $report
 * @var VT\Report\Translator      $t
 * @var string                    $css
 */

$e = static fn($value): string => htmlspecialchars((string) $value, ENT_QUOTES);

$opt = $report['options'];
$client = $report['client'];
$project = $report['project'];
$issuer = $report['issuer'];
$currency = $report['meta']['currency'];

// Wird beim Drucken zum Vorschlag für den PDF-Dateinamen.
$documentTitle = sprintf(
    '%s - %s - %s - %s–%s',
    $t('title'),
    $client['name'] ?? '',
    $project['name'] ?? $t('all_projects'),
    $report['period']['first_date'],
    $report['period']['last_date']
);
?>
<!doctype html>
<html lang="<?= $e($t->lang()) ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= $e($documentTitle) ?></title>
<style><?= $css ?></style>
</head>
<body>

<div class="toolbar">
    <button class="primary" onclick="window.print()">Drucken / als PDF sichern</button>
    <span class="spacer"></span>
    <span><?= $e($report['totals']['hhmm']) ?> ·
        <?= $e($t->number($report['totals']['decimal'])) ?> h ·
        <?= (int) $report['totals']['entries'] ?> <?= $e($t('entries')) ?></span>
</div>

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

    <h1 class="title <?= $hasHead ? '' : 'title--top' ?>"><?= $e($t('title')) ?></h1>

    <dl class="meta">
        <dt><?= $e($t('customer')) ?></dt>
        <dd><?= $e($client['name'] ?? '—') ?></dd>

        <dt><?= $e($report['meta']['multi_project'] ? $t('projects') : $t('project')) ?></dt>
        <dd><?= $e($project['name'] ?? $t('all_projects')) ?></dd>

        <dt><?= $e($t('period')) ?></dt>
        <dd><?= $e($report['period']['first_date']) ?> – <?= $e($report['period']['last_date']) ?></dd>

        <dt><?= $e($t('effort')) ?></dt>
        <dd><?= $e($report['totals']['hhmm']) ?>
            (<?= $e($t->number($report['totals']['decimal'])) ?> h)</dd>
    </dl>

    <p class="listing__label"><?= $e($t('listing')) ?></p>

    <table class="items">
        <thead>
            <tr>
                <th class="col-date"><?= $e($t('date')) ?></th>
                <?php if ($opt['times']): ?>
                    <th class="col-time"><?= $e($t('time')) ?></th>
                <?php endif; ?>
                <th><?= $e($t('description')) ?></th>
                <th class="col-dur"><?= $e($t('duration')) ?></th>
                <?php if ($opt['costs']): ?>
                    <th class="col-rate"><?= $e($t('rate')) ?></th>
                    <th class="col-sum"><?= $e($t('amount')) ?></th>
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
        <span class="totals__label"><?= $e($t('total')) ?></span>
        <div class="totals__values">
            <div class="totals__hours">
                <?= $e($report['totals']['hhmm']) ?>
                <span class="totals__hint">|
                    <?= $e($t->number($report['totals']['decimal'])) ?> <?= $e($t('total_hours')) ?></span>
            </div>
            <?php if ($opt['costs'] && $report['totals']['amount'] !== null): ?>
                <div class="totals__amount">
                    <?= $e($t->money((float) $report['totals']['amount'], $currency)) ?>
                    <span class="totals__hint"><?= $e($t('net')) ?></span>
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
</body>
</html>
