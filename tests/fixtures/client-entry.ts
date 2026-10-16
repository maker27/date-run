import { h, render } from 'preact';
import { App } from '../../src/client/app.js';
import { GameSession } from '../../src/client/application/game-session.js';
import { CredentialStore } from '../../src/client/realtime/credentials.js';
import { SocketClient } from '../../src/client/realtime/socket-client.js';
import type { ServerMessage } from '../../src/shared/protocol.js';
import { appUrls } from '../../src/client/platform/app-urls.js';
import { SHORT_LEVEL } from './short-level.js';
import { TestTransport } from './test-transport.js';
import { createRequestId } from '../../src/client/platform/request-id.js';

type InteractionOutcome = Extract<ServerMessage, { type: 'world:interact:result' }>['outcome'];

class TestVisibility extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';

  set(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('App mount element is missing');
const transport = new TestTransport();
const visibility = new TestVisibility();
let storageFailure = false;
const credentials = new CredentialStore({
  getItem: (key) => {
    if (storageFailure) throw new Error('Test storage failure');
    return sessionStorage.getItem(key);
  },
  setItem: (key, value) => {
    if (storageFailure) throw new Error('Test storage failure');
    sessionStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (storageFailure) throw new Error('Test storage failure');
    sessionStorage.removeItem(key);
  },
});
const socketClient = new SocketClient(appUrls(location.origin).ws, { socketFactory: transport.createSocket });
const session = new GameSession({
  level: SHORT_LEVEL,
  transport: socketClient,
  credentials,
  visibility,
});

window.__dateRunTest = {
  snapshot: () => transport.snapshot,
  connectionId: () => transport.connectionId(),
  dropNext: (type) => transport.dropNext(type),
  setVisibility: (state) => visibility.set(state),
  setStorageFailure: (value) => { storageFailure = value; },
  attemptInteraction: async (objectId) => {
    const snapshot = transport.snapshot;
    if (!snapshot) throw new Error('No authoritative snapshot');
    const reply = await socketClient.request({
      version: 1,
      type: 'world:interact',
      requestId: createRequestId(),
      epoch: snapshot.epoch,
      objectId,
    });
    if (reply.type !== 'world:interact:result') throw new Error(reply.type === 'error' ? reply.code : 'Unexpected reply');
    return reply.outcome;
  },
  lastResyncedInputGeneration: () => transport.lastResyncedInputGeneration,
};
window.addEventListener('pagehide', () => session.destroy(), { once: true });
render(h(App, { session }), root);

declare global {
  interface Window {
    __dateRunTest: {
      snapshot(): import('../../src/shared/model.js').WorldSnapshot | null;
      connectionId(): string;
      dropNext(type: 'room:complete' | 'world:update' | 'room:state'): void;
      setVisibility(state: DocumentVisibilityState): void;
      setStorageFailure(value: boolean): void;
      attemptInteraction(objectId: string): Promise<InteractionOutcome>;
      lastResyncedInputGeneration(): number | null;
    };
  }
}
