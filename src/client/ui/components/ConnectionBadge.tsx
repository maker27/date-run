import { useEffect, useState } from 'preact/hooks';
import type { UiSummary } from '../../application/ui-summary.js';

export const errorMessages: Record<NonNullable<UiSummary['error']>, string> = {
  unexpected_error: 'Не удалось выполнить действие. Попробуйте ещё раз.',
  busy: 'Дождитесь завершения текущего действия.', room_full: 'В комнате нет свободных мест.', room_not_found: 'Комната не найдена.',
  session_expired: 'Срок действия приглашения истёк.', session_replaced: 'Это место открыто в другой вкладке.',
  invalid_message: 'Проверьте код комнаты.', unsupported_version: 'Обновите страницу.',
  not_in_room: 'Вы больше не в этой комнате.', not_host: 'Изменять комнату может только создатель.',
  invalid_phase: 'Сейчас это действие недоступно.', stale_epoch: 'Синхронизация игры.',
  stale_input_generation: 'Синхронизация игры.', queue_full: 'Синхронизация игры.',
  server_full: 'Сервер заполнен. Попробуйте позже.', rate_limited: 'Подождите и попробуйте снова.',
  network_error: 'Не удалось подключиться. Повторите попытку.', timeout: 'Время ожидания истекло. Повторите попытку.',
  aborted: 'Запрос отменён.', invalid_response: 'Сервер прислал неверный ответ.',
  graphics_error: 'Не удалось показать игру. Нажмите «Повторить», чтобы загрузить сцену снова.', interaction_failed: 'Подойдите ближе к своему подарку.',
};

export function ConnectionBadge({ summary, onRetry, onLeave }: { summary: UiSummary; onRetry: () => void; onLeave?: (() => void) | undefined }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const replaced = summary.error === 'session_replaced';
  const disconnected = summary.roomId !== null && summary.connection === 'closed' && !summary.loading && !replaced;
  return <div class="connection-status">
    <div aria-live="polite">
      {!online && <p>Нет подключения к интернету.</p>}
      {summary.connection === 'reconnecting' && <p>Восстанавливаем соединение…</p>}
      {disconnected && <p>Соединение прервано. Попробуйте подключиться снова.</p>}
      {summary.loading && <p>Подключение…</p>}
      {summary.storageWarning && <p>Браузер не может сохранить место в комнате для перезагрузки.</p>}
      {summary.closing && <p>{summary.closing === 'idle' ? 'Комната скоро закроется из-за бездействия.' : 'Сервер перезапускается. Комната скоро закроется.'}</p>}
    </div>
    {summary.error && <p class="error" role="alert">{errorMessages[summary.error]}</p>}
    {(summary.error || disconnected) && !replaced && <button type="button" onClick={onRetry}>Повторить</button>}
    {replaced && onLeave && <button type="button" onClick={onLeave}>Выйти</button>}
  </div>;
}
