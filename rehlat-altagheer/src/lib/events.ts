/**
 * Realtime fan-out.
 *
 * An in-process publish/subscribe hub feeding Server-Sent Events. When any
 * participant changes something, every connected client is told to refresh its
 * snapshot, which satisfies the spec's requirement that nobody has to press
 * reload to see the leaderboard move.
 *
 * Scope note: this works because the app runs as one long-lived Node process,
 * which is the case for `npm run dev` and for `npm start` on a normal server.
 * It would not survive a move to serverless functions, where each request is
 * isolated — that deployment needs Supabase Realtime (or similar) instead, and
 * only this file would change.
 */

import 'server-only';

export type Listener = (payload: string) => void;

const globalForEvents = globalThis as unknown as { __appListeners?: Set<Listener> };

function listeners(): Set<Listener> {
  if (!globalForEvents.__appListeners) globalForEvents.__appListeners = new Set();
  return globalForEvents.__appListeners;
}

export function subscribe(listener: Listener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

/**
 * Announce that shared state changed.
 *
 * The payload carries only a reason and a timestamp, never participant data.
 * Clients respond by re-fetching /api/state, which re-applies every permission
 * check server-side — so a realtime message can never leak something the
 * receiver is not allowed to see.
 */
export function publish(reason: string): void {
  const payload = JSON.stringify({ reason, at: Date.now() });
  for (const listener of listeners()) {
    try {
      listener(payload);
    } catch {
      // A dead connection must not stop the others from being notified.
    }
  }
}
