// App-wide event bus. Bridges Wails (Go -> JS) events into local handlers
// and carries frontend-only messages (core <-> addons, addon <-> addon).
// Unlike raw EventsOn there is an off(), so addons can be deactivated
// without leaking handlers.

import { EventsOn } from '../../wailsjs/runtime/runtime';

const handlers = new Map(); // name -> Set<fn>
const bridged = new Set();

function deliver(name, payload) {
  const set = handlers.get(name);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.warn(`bus handler for "${name}" failed:`, err);
    }
  }
}

function bridge(name) {
  if (bridged.has(name)) return;
  bridged.add(name);
  EventsOn(name, (payload) => deliver(name, payload));
}

export function on(name, fn) {
  bridge(name);
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(fn);
  return () => off(name, fn);
}

export function off(name, fn) {
  handlers.get(name)?.delete(fn);
}

// emit is frontend-local: it reaches bus subscribers in this window,
// not Go. Backend-originated events arrive through the Wails bridge.
export function emit(name, payload) {
  deliver(name, payload);
}
