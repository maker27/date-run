import type { UiSummary } from '../../application/ui-summary.js';

export function gameInstruction(summary: UiSummary): string {
    if (summary.phase === 'complete') return 'Обмениваемся подарками…';
    if (summary.paused) return 'Пауза: ждём возвращения партнёра.';
    if (summary.gateOpen) return 'Ворота открыты - идите оба под арку. Подарками обменяетесь автоматически.';
    if (!summary.ownGift) return 'Заберите свой подарок: подойдите к нему и нажмите E или «Взять подарок».';
    if (!summary.partnerGift)
        return 'Ваш подарок с вами. Дождитесь подарка партнёра и найдите площадки у ворот.';
    return 'Встаньте каждый на подсвеченную площадку у ворот - одновременно. Затем идите под арку.';
}

export function GameHud({ summary }: { summary: UiSummary }) {
    return (
        <div class="game-hud" role="region" aria-label="Статус игры">
            <span>{summary.ownGift ? 'Ваш подарок собран' : 'Ваш подарок ждёт'}</span>
            <span>{summary.partnerGift ? 'Подарок партнёра собран' : 'Подарок партнёра ждёт'}</span>
            <span>{summary.gateOpen ? 'Ворота открыты' : 'Ворота закрыты'}</span>
            {!summary.gateOpen && <span>Площадки: {summary.occupiedPlates} из 2</span>}
            {summary.paused && <span>Пауза: ждём партнёра</span>}
        </div>
    );
}
