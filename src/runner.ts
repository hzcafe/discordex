import type { Bridge } from './bridge.js';
import type { CodexClient } from './codex.js';
import type { Store } from './store.js';

/** Coordinate CLI startup with signals, including a signal during Discord login. */
export function bridgeRunner(
  codex: Pick<CodexClient, 'start' | 'stop'>,
  discord: { login(token: string): Promise<void>; close(): Promise<void> },
  bridge: Pick<Bridge, 'start' | 'stop'>,
  store: Pick<Store, 'release' | 'close'>,
  prepare: () => Promise<void>,
  connect: () => void,
) {
  let stopping = false;
  let startup: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let login: Promise<void> | undefined;
  return {
    start(token: string): Promise<void> {
      if (startup) return startup;
      startup = (async () => {
        if (stopping) return;
        await prepare();
        if (stopping) return;
        login = discord.login(token);
        await login;
        if (stopping) return;
        connect(); bridge.start(); codex.start();
      })();
      return startup;
    },
    stop(): Promise<void> {
      stopping = true;
      return cleanup ??= (async () => {
        // Login must settle before close, so it cannot resurrect a destroyed client.
        await login?.catch(() => {});
        const errors: unknown[] = [];
        for (const close of [() => codex.stop(), () => discord.close(), () => bridge.stop(), () => store.release(), () => store.close()]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Bridge shutdown failed');
      })();
    },
  };
}
