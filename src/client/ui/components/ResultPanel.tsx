import { useEffect, useRef } from 'preact/hooks';
import type { UiSummary } from '../../application/ui-summary.js';

export function ResultPanel({ summary, onRematch, onBackToLobby, onLeave }: { summary: UiSummary; onRematch: () => void; onBackToLobby: () => void; onLeave: () => void }) {
  const own = summary.players.find((player) => player.role === summary.ownRole);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section class="result-panel">
    <p class="eyebrow">Свидание состоялось</p>
    <h2 ref={heading} tabIndex={-1}>Вы встретились!</h2>
    <p>Оба подарка доставлены к финишу.</p>
    <h3>Готовность к новой игре</h3>
    <ul>{summary.players.map((player) => <li key={player.role}>Игрок {player.role.toUpperCase()}: {player.rematch ? 'готов' : 'ожидает'}</li>)}</ul>
    <div class="actions">
      <button type="button" disabled={own?.rematch} onClick={onRematch}>Сыграть снова</button>
      {summary.isHost && <button type="button" class="secondary" onClick={onBackToLobby}>В лобби</button>}
      <button type="button" class="quiet" onClick={onLeave}>Выйти</button>
    </div>
  </section>;
}
