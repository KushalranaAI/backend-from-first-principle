import { useCallback, useSyncExternalStore } from "react";

// Progress lives only in this browser. Reads and writes never throw: private windows and blocked storage just forget.
const cache = new Map<string, unknown>();
const listeners = new Set<() => void>();

function read<T>(key: string, fallback: T): T {
  if (!cache.has(key)) {
    let value: unknown = fallback;
    try {
      value = JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
    } catch {
      /* keep fallback */
    }
    cache.set(key, value);
  }
  return cache.get(key) as T;
}

function write(key: string, value: unknown) {
  cache.set(key, value);
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* memory only */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(subscribe, () => read(key, fallback));
  return [value, useCallback((v: T) => write(key, v), [key])];
}

type Flags = Record<string, number>;
const NONE: Flags = {};

/** Finished lessons: slug → time it was ticked. */
export function useDone(): [Flags, (slug: string, done: boolean) => void] {
  const [done, setDone] = useStored<Flags>("bfp:done", NONE);
  const toggle = useCallback(
    (slug: string, on: boolean) => {
      const next = { ...done };
      if (on) next[slug] = Date.now();
      else delete next[slug];
      setDone(next);
    },
    [done, setDone],
  );
  return [done, toggle];
}

/** Ticked checklist items in one lesson, keyed by the item's position in the source. */
export function useTasks(slug: string): [Flags, (id: string, on: boolean) => void] {
  const [ticks, setTicks] = useStored<Flags>(`bfp:tasks:${slug}`, NONE);
  const toggle = useCallback(
    (id: string, on: boolean) => {
      const next = { ...ticks };
      if (on) next[id] = 1;
      else delete next[id];
      setTicks(next);
    },
    [ticks, setTicks],
  );
  return [ticks, toggle];
}
