import { useState } from 'preact/hooks';

export function InvitePanel({ roomId, inviteUrl }: { roomId: string; inviteUrl: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const copy = async (value: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setMessage(label === 'Код' ? 'Код скопирован.' : 'Ссылка скопирована.');
    } catch {
      setFailed(true);
      setMessage('Не удалось скопировать. Выделите и скопируйте текст вручную.');
    }
  };
  return <section class="invite-panel" aria-label="Приглашение">
    <h3>Пригласите партнёра</h3>
    <p>Отправьте ссылку или код комнаты.</p>
    <div class="invite-fields">
      <label>Ссылка-приглашение<input readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} /></label>
      <button type="button" onClick={() => void copy(inviteUrl, 'Ссылка')}>Скопировать ссылку</button>
      <label>Код комнаты<input readOnly value={roomId} onFocus={(event) => event.currentTarget.select()} /></label>
      <button type="button" onClick={() => void copy(roomId, 'Код')}>Скопировать код</button>
    </div>
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
  </section>;
}
