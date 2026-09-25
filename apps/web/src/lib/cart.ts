'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MenuItem } from './types';

/**
 * The basket.
 *
 * One basket per merchant, held in `sessionStorage`. Deliberately not React
 * context and not the API:
 *
 *  * Not context — the basket is read by exactly two routes (the menu and the
 *    checkout) and written by one. A provider would have to be mounted above
 *    both, which means restructuring the route tree for two consumers.
 *  * Not the API — an unpaid draft order has no business occupying a row, and
 *    `orders` carries stock holds that would need expiring. The basket becomes
 *    real the moment `POST /orders` succeeds.
 *
 * `sessionStorage` rather than `localStorage` because a basket is a
 * now-decision: leaving a day-old basket on a shared phone is worse than
 * losing it.
 */

const KEY = 'takeout.cart';

export interface CartLine {
  menuItemId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  isMainItem: boolean;
  /** Daily cap, so the stepper can stop before the API rejects the order. */
  dailyQuota: number | null;
  remainingToday: number | null;
  availability: string;
}

export interface Cart {
  merchantId: string;
  merchantSlug: string;
  merchantName: string;
  lines: CartLine[];
}

function read(): Cart | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cart;
    // Guard against a shape change between deploys leaving a broken basket in
    // an open tab.
    if (!parsed?.merchantId || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(cart: Cart | null): void {
  if (typeof window === 'undefined') return;
  if (!cart || cart.lines.length === 0) {
    window.sessionStorage.removeItem(KEY);
    return;
  }
  window.sessionStorage.setItem(KEY, JSON.stringify(cart));
}

/**
 * Read and mutate the basket.
 *
 * Every mutation writes through immediately, and `storage` is listened to so a
 * second tab cannot silently overwrite this one's basket.
 */
export function useCart() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setCart(read());
    setReady(true);

    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY) setCart(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const commit = useCallback((next: Cart | null) => {
    write(next);
    setCart(next);
  }, []);

  const add = useCallback(
    (merchant: { id: string; slug: string; name: string }, item: MenuItem, quantity = 1) => {
      setCart((current) => {
        // Switching merchant replaces the basket rather than merging it — a
        // basket spanning two kitchens cannot be collected in one trip, and
        // silently dropping the old lines would be worse than asking.
        const base: Cart =
          current && current.merchantId === merchant.id
            ? current
            : {
                merchantId: merchant.id,
                merchantSlug: merchant.slug,
                merchantName: merchant.name,
                lines: [],
              };

        const existing = base.lines.find((line) => line.menuItemId === item.id);
        const lines = existing
          ? base.lines.map((line) =>
              line.menuItemId === item.id
                ? { ...line, quantity: clampQuantity(line, line.quantity + quantity) }
                : line,
            )
          : [
              ...base.lines,
              {
                menuItemId: item.id,
                name: item.name,
                unitPriceMinor: item.priceMinor,
                quantity: clampQuantity(item, quantity),
                isMainItem: item.isMainItem,
                dailyQuota: item.dailyQuota,
                remainingToday: item.remainingToday,
                availability: item.availability,
              },
            ];

        const next = { ...base, lines };
        write(next);
        return next;
      });
    },
    [],
  );

  const setQuantity = useCallback((menuItemId: string, quantity: number) => {
    setCart((current) => {
      if (!current) return current;
      const lines =
        quantity <= 0
          ? current.lines.filter((line) => line.menuItemId !== menuItemId)
          : current.lines.map((line) =>
              line.menuItemId === menuItemId
                ? { ...line, quantity: clampQuantity(line, quantity) }
                : line,
            );
      const next = { ...current, lines };
      write(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => commit(null), [commit]);

  const quantityOf = useCallback(
    (menuItemId: string) => cart?.lines.find((line) => line.menuItemId === menuItemId)?.quantity ?? 0,
    [cart],
  );

  const totalMinor = cart?.lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0) ?? 0;
  const itemCount = cart?.lines.reduce((sum, line) => sum + line.quantity, 0) ?? 0;
  const mainItemCount =
    cart?.lines.reduce((sum, line) => sum + (line.isMainItem ? line.quantity : 0), 0) ?? 0;

  return { cart, ready, add, setQuantity, clear, quantityOf, totalMinor, itemCount, mainItemCount };
}

/**
 * Cap a line at what the kitchen can actually make today.
 *
 * The API would reject an over-quota order anyway, but doing it here means the
 * customer finds out at the stepper instead of at the payment screen.
 */
function clampQuantity(line: Pick<CartLine, 'dailyQuota' | 'remainingToday'>, quantity: number): number {
  const ceiling = line.remainingToday ?? line.dailyQuota;
  const capped = ceiling === null ? quantity : Math.min(quantity, ceiling);
  return Math.max(1, capped);
}
