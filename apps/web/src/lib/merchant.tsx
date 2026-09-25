'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { useAsync } from './use-async';
import type { OwnedMerchant } from './types';

/**
 * Which merchant the portal is currently acting as.
 *
 * A merchant owner may legitimately run two shops — a stall and a kitchen —
 * and every merchant-scoped endpoint takes `:merchantId` in the path. Without a
 * single place holding the selection, each page would either invent its own
 * picker or silently assume "the first one", and the two would disagree the
 * moment a second shop exists.
 *
 * The selection is persisted so a reload does not silently switch shops
 * mid-service — that is the kind of bug that gets an order made in the wrong
 * kitchen.
 */

const STORAGE_KEY = 'takeout.merchantId';

interface MerchantContextValue {
  /** Every merchant this principal may act for. Empty while loading. */
  merchants: OwnedMerchant[];
  /** The one in focus. `null` only before the first load resolves. */
  merchant: OwnedMerchant | null;
  merchantId: string | null;
  select: (merchantId: string) => void;
  loading: boolean;
  error: Error | null;
  /** Re-read the list — after a settings save, so the header reflects it. */
  reload: () => Promise<OwnedMerchant[] | null>;
  /** Replace one merchant in place without a round trip. */
  patchLocal: (merchant: OwnedMerchant) => void;
}

const MerchantContext = createContext<MerchantContextValue | null>(null);

export function MerchantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * Fetch only once there is a principal.
   *
   * `useAsync` runs on mount regardless, so calling `mine()` unconditionally
   * would fire an unauthenticated request on every cold load and log a 401 in
   * the console for a user who is about to be redirected to `/login` anyway.
   */
  const state = useAsync<OwnedMerchant[]>(
    () => (user ? api.merchant.mine() : Promise.resolve([])),
    [user?.id ?? null],
  );

  const merchants = state.data ?? [];

  // Restore the persisted choice once the list arrives.
  useEffect(() => {
    if (merchants.length === 0) return;
    setSelectedId((current) => {
      if (current && merchants.some((m) => m.id === current)) return current;
      const stored =
        typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY);
      if (stored && merchants.some((m) => m.id === stored)) return stored;
      return merchants[0]?.id ?? null;
    });
  }, [merchants]);

  const select = useCallback((merchantId: string) => {
    setSelectedId(merchantId);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, merchantId);
  }, []);

  const patchLocal = useCallback(
    (updated: OwnedMerchant) => {
      state.set((state.data ?? []).map((m) => (m.id === updated.id ? updated : m)));
    },
    [state],
  );

  const merchant = useMemo(
    () => merchants.find((m) => m.id === selectedId) ?? merchants[0] ?? null,
    [merchants, selectedId],
  );

  const value = useMemo<MerchantContextValue>(
    () => ({
      merchants,
      merchant,
      merchantId: merchant?.id ?? null,
      select,
      loading: state.loading,
      error: state.error,
      reload: state.reload,
      patchLocal,
    }),
    [merchants, merchant, select, state.loading, state.error, state.reload, patchLocal],
  );

  return <MerchantContext.Provider value={value}>{children}</MerchantContext.Provider>;
}

export function useMerchant(): MerchantContextValue {
  const context = useContext(MerchantContext);
  if (!context) throw new Error('useMerchant must be used inside <MerchantProvider>');
  return context;
}
