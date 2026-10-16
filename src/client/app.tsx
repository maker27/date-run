import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { GameSession } from './application/game-session.js';
import type { UiSummary } from './application/ui-summary.js';
import { ConnectionBadge } from './ui/components/ConnectionBadge.js';
import { Lobby } from './ui/screens/Lobby.js';
import { Room } from './ui/screens/Room.js';
import './style.css';
import './ui/styles.css';

export function App({ session }: { session?: GameSession; children?: ComponentChildren }) {
  const [owned] = useState(() => session ?? new GameSession());
  const [summary, setSummary] = useState<UiSummary | null>(null);
  const [sceneRevision, setSceneRevision] = useState(0);
  useEffect(() => {
    const unsubscribe = owned.subscribeUi(setSummary);
    return () => { unsubscribe(); if (!session) owned.destroy(); };
  }, [owned, session]);
  if (!summary) return <main><h1>Date Run</h1><p role="status">Загрузка…</p></main>;
  return <main class={summary.screen === 'landing' ? 'app-landing' : 'app-room'}>
    {summary.screen === 'landing' ? <>
      <ConnectionBadge summary={summary} onRetry={() => void owned.retry()} />
      <Lobby session={owned} summary={summary} />
    </> : <Room key={`${summary.roomId}-${sceneRevision}`} session={owned} summary={summary} onRetryGraphics={() => setSceneRevision((revision) => revision + 1)} />}
  </main>;
}
