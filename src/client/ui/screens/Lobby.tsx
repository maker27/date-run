import { useEffect, useRef, useState } from 'preact/hooks';
import type { Role, RoomPreview, ThemeId } from '../../../shared/model.js';
import { normalizeRoomCode } from '../../../shared/room-code.js';
import { GameSessionError, type GameSession } from '../../application/game-session.js';
import type { UiSummary } from '../../application/ui-summary.js';
import { appUrls } from '../../platform/app-urls.js';
import { errorMessages } from '../components/ConnectionBadge.js';
import { InvitePanel } from '../components/InvitePanel.js';
import { RolePicker } from '../components/RolePicker.js';
import { ThemePicker, themes } from '../components/ThemePicker.js';

export type LobbySession = Pick<GameSession, 'preview' | 'create' | 'join' | 'configure' | 'setReady' | 'leave'>;

export function Lobby({ session, summary }: { session: LobbySession; summary: UiSummary }) {
  const [theme, setTheme] = useState<ThemeId>('first-date');
  const [role, setRole] = useState<Role>('a');
  const [code, setCode] = useState(() => new URL(location.href).searchParams.get('room') ?? '');
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef<AbortController | null>(null);
  const version = useRef(0);
  useEffect(() => { heading.current?.focus(); }, [summary.screen]);
  useEffect(() => {
    if (summary.screen === 'landing' && new URL(location.href).searchParams.has('room')) void checkCode(code);
    return () => { version.current += 1; pending.current?.abort(); };
  }, []);
  const changeCode = (value: string) => {
    version.current += 1;
    pending.current?.abort();
    setCode(value.toUpperCase());
    setPreview(null);
    setPreviewing(false);
    setFormError(null);
  };
  const checkCode = async (raw: string) => {
    const normalized = normalizeRoomCode(raw);
    if (!normalized) { setFormError('Введите код комнаты из восьми символов.'); setPreview(null); return; }
    const request = ++version.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setPreviewing(true);
    setPreview(null);
    setFormError(null);
    setCode(normalized);
    try {
      const found = await session.preview(normalized, controller.signal);
      if (request !== version.current || controller.signal.aborted) return;
      setPreview(found);
      if (!found.availableRole) setFormError('В комнате нет свободных мест.');
    } catch (error) {
      if (request !== version.current || controller.signal.aborted) return;
      setFormError(error instanceof GameSessionError ? errorMessages[error.code] : errorMessages.network_error);
    } finally {
      if (request === version.current && !controller.signal.aborted) setPreviewing(false);
    }
  };
  const join = async (event: Event) => {
    event.preventDefault();
    const normalized = normalizeRoomCode(code);
    if (!normalized) { setFormError('Введите код комнаты из восьми символов.'); return; }
    if (previewing || (preview && preview.roomId !== normalized)) return;
    if (preview && !preview.availableRole) { setFormError('В комнате нет свободных мест.'); return; }
    await session.join(normalized);
  };
  if (summary.screen !== 'landing') {
    const own = summary.players.find((player) => player.role === summary.ownRole);
    const configDisabled = !summary.isHost || summary.players.some((player) => player.ready) || summary.loading;
    const inviteUrl = summary.roomId ? appUrls(location.origin).invite(summary.roomId) : '';
    return <div class="lobby-room">
      <h2 ref={heading} tabIndex={-1}>Комната {summary.roomId}</h2>
      <p class="room-intro">{summary.players.length < 2 ? 'Ждём партнёра…' : 'Оба игрока в комнате. Выберите сторону и подготовьтесь к старту.'}</p>
      {summary.roomId && <InvitePanel roomId={summary.roomId} inviteUrl={inviteUrl} />}
      <div class="lobby-config">
        <ThemePicker value={summary.selectedTheme} disabled={configDisabled} onChange={(next) => { if (summary.ownRole) void session.configure(next, summary.ownRole); }} />
        <RolePicker value={summary.ownRole ?? 'a'} disabled={configDisabled} onChange={(next) => void session.configure(summary.selectedTheme, next)} />
      </div>
      {!summary.isHost && <p>Настройки комнаты выбирает создатель.</p>}
      {summary.players.some((player) => player.ready) && <p>Чтобы изменить тему или сторону, сначала отмените готовность.</p>}
      <ul class="player-list">{summary.players.map((player) => <li key={player.role}>Игрок {player.role.toUpperCase()}: {player.connected ? 'в сети' : 'не в сети'}, {player.ready ? 'готов' : 'ожидает'}</li>)}</ul>
      {!summary.sceneReady && <p>Подготавливаем игровую сцену…</p>}
      <div class="actions">
        <button type="button" disabled={summary.loading || (!own?.ready && (!summary.sceneReady || summary.error !== null))} onClick={() => void session.setReady(!own?.ready)}>{own?.ready ? 'Отменить готовность' : 'Готов'}</button>
        <button type="button" class="quiet" onClick={() => void session.leave()}>Выйти</button>
      </div>
    </div>;
  }
  return <div class="landing">
    <header class="hero"><span class="eyebrow">Игра для двоих</span><h1 ref={heading} tabIndex={-1}>Date Run</h1><p>Выберите свидание, пригласите партнёра и бегите навстречу друг другу.</p></header>
    <div class="landing-grid">
      <section class="card create-card"><h2>Создать комнату</h2><p>Настройте место встречи и стартовую сторону.</p>
        <ThemePicker value={theme} onChange={setTheme} />
        <RolePicker value={role} onChange={setRole} />
        <button type="button" class="primary" disabled={summary.loading} onClick={() => void session.create(theme, role)}>Создать комнату</button>
      </section>
      <section class="card join-card"><h2>Уже пригласили?</h2><p>Введите код из приглашения.</p>
        <form onSubmit={(event) => void join(event)}>
          <label>Код комнаты<input value={code} maxLength={8} autoCapitalize="characters" autoComplete="off" spellcheck={false} onInput={(event) => changeCode(event.currentTarget.value)} onChange={(event) => changeCode(event.currentTarget.value)} onPaste={(event) => { const pasted = event.clipboardData?.getData('text') ?? ''; if (!normalizeRoomCode(pasted)) { event.preventDefault(); changeCode(pasted); setFormError('Введите код комнаты из восьми символов.'); } }} /></label>
          {previewing && <p role="status">Проверяем комнату…</p>}
          {preview && <div class="preview" role="status"><p>Комната найдена: {themes.find((item) => item.id === preview.themeId)?.label}. Занято мест: {preview.occupiedPlaces} из 2.</p><p>{preview.availableRole ? `Свободная сторона: ${preview.availableRole === 'a' ? 'слева' : 'справа'}.` : 'Свободных мест нет.'}</p></div>}
          {formError && <p class="error" role="alert">{formError}</p>}
          <div class="actions"><button type="button" class="secondary" onClick={() => void checkCode(code)}>Проверить комнату</button><button type="submit" class="primary" disabled={summary.loading || previewing || (!!preview && !preview.availableRole)}>Войти в комнату</button></div>
          {(preview || formError) && <div class="actions"><button type="button" class="quiet" onClick={() => void checkCode(code)}>Повторить</button><button type="button" class="quiet" onClick={() => { setPreview(null); setFormError(null); }}>Назад</button></div>}
        </form>
      </section>
    </div>
  </div>;
}
