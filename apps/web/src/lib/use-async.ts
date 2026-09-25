'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | Error | null;
  /** Re-run the loader. Returns the fresh value so callers can chain. */
  reload: () => Promise<T | null>;
  /** Optimistically replace the local value without a round trip. */
  set: (value: T) => void;
}

/**
 * Run an async loader and track its state.
 *
 * `deps` behaves like `useEffect`'s. The loader is kept in a ref so an inline
 * arrow function does not re-fire the request on every render — a mistake that
 * turns a table into an infinite request loop.
 *
 * Late responses are dropped: if the component re-fetches (or unmounts) before
 * an earlier request resolves, the earlier one is ignored rather than
 * overwriting newer data.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const runId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (): Promise<T | null> => {
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    try {
      const value = await loaderRef.current();
      if (runId.current === id && mounted.current) {
        setData(value);
        setLoading(false);
      }
      return value;
    } catch (caught) {
      if (runId.current === id && mounted.current) {
        setError(caught as Error);
        setLoading(false);
      }
      return null;
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void run();
  }, deps);

  return { data, loading, error, reload: run, set: setData };
}

/**
 * A monotonic clock for countdowns.
 *
 * `Date.now()` inside render is not reactive, so a deadline never appears to
 * move. This ticks on an interval and forces a re-render, which is what the
 * kitchen board's accept countdown needs.
 */
export function useTicker(intervalMs = 1000): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return tick;
}

/** Debounce a rapidly changing value — search boxes. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
