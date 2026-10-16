import { useEffect, useRef } from 'preact/hooks';
import type { GameSession } from '../../application/game-session.js';
import type { UiSummary } from '../../application/ui-summary.js';
import { ConnectionBadge } from '../components/ConnectionBadge.js';
import { GameHud, gameInstruction } from '../components/GameHud.js';
import { ResultPanel } from '../components/ResultPanel.js';
import { TouchControls } from '../components/TouchControls.js';
import { Lobby, type LobbySession } from './Lobby.js';

export type RoomSession = LobbySession &
    Pick<GameSession, 'attachScene' | 'detachScene' | 'retry' | 'rematch' | 'backToLobby'>;

export function Room({
    session,
    summary,
    onRetryGraphics
}: {
    session: RoomSession;
    summary: UiSummary;
    onRetryGraphics: () => void;
}) {
    const container = useRef<HTMLDivElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
        if (container.current) void session.attachScene(container.current);
        return () => session.detachScene();
    }, [session]);
    useEffect(() => {
        if (summary.screen === 'game') heading.current?.focus();
    }, [summary.screen]);
    const retry = () => (summary.error === 'graphics_error' ? onRetryGraphics() : void session.retry());
    return (
        <section class={`room room-${summary.screen}`} aria-label="Игра">
            <div class="room-content">
                {summary.screen === 'lobby' ? (
                    <Lobby session={session} summary={summary} />
                ) : (
                    <div class="room-toolbar">
                        <span class="room-mark">Date Run</span>
                        <span>Комната {summary.roomId}</span>
                        {summary.error !== 'session_replaced' && summary.screen !== 'result' && (
                            <button type="button" class="quiet" onClick={() => void session.leave()}>
                                Выйти
                            </button>
                        )}
                    </div>
                )}
                <ConnectionBadge
                    summary={summary}
                    onRetry={retry}
                    onLeave={summary.screen === 'result' ? undefined : () => void session.leave()}
                />
                {summary.screen === 'game' && (
                    <div class="play-info">
                        <h2 ref={heading} tabIndex={-1}>
                            {summary.phase === 'complete' ? 'Вы встретились!' : 'Бегите навстречу!'}
                        </h2>
                        <p role="status" aria-live="polite">
                            {gameInstruction(summary)}
                        </p>
                        <GameHud summary={summary} />
                    </div>
                )}
                {summary.screen === 'result' && (
                    <ResultPanel
                        summary={summary}
                        onRematch={() => void session.rematch()}
                        onBackToLobby={() => void session.backToLobby()}
                        onLeave={() => void session.leave()}
                    />
                )}
            </div>
            <div class="game-canvas" ref={container} role="img" aria-label="Игровой мир Date Run" />
            {summary.screen === 'game' && summary.phase === 'playing' && (
                <>
                    <TouchControls />
                    <p class="keyboard-hint">
                        Клавиатура: A/D или стрелки - движение, пробел - прыжок, E - взять подарок.
                    </p>
                </>
            )}
        </section>
    );
}
