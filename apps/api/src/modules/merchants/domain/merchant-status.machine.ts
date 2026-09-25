import { MerchantStatus } from '@prisma/client';
import { MerchantStatusTransitionError } from './merchant.errors';

/**
 * The administrative actions that move a merchant through its lifecycle.
 *
 * Approve, suspend, reinstate and close are *platform* decisions. A merchant
 * cannot suspend itself into a state that hides a complaint, and cannot approve
 * itself into `ACTIVE` — which is why none of these appear on the merchant's own
 * endpoints.
 */
export enum MerchantAdminAction {
  /** 核准上線 — the merchant becomes orderable and visible in discovery. */
  APPROVE = 'APPROVE',
  /** 暫停營業 — hidden from new orders, but the details stay editable. */
  SUSPEND = 'SUSPEND',
  /** 恢復營業. */
  REINSTATE = 'REINSTATE',
  /** 結業 — terminal. */
  CLOSE = 'CLOSE',
}

interface MerchantActionRule {
  readonly to: MerchantStatus;
  readonly from: readonly MerchantStatus[];
  /**
   * Forced onto the merchant as part of the action. `undefined` leaves the
   * merchant's own 接單/停單 switch alone.
   */
  readonly acceptsOrders?: boolean;
  readonly label: string;
}

/**
 * The table. Adding a lifecycle state means editing this and nothing else —
 * no scattered `if (status === ...)` anywhere in the admin services.
 */
const RULES: Readonly<Record<MerchantAdminAction, MerchantActionRule>> = {
  [MerchantAdminAction.APPROVE]: {
    to: MerchantStatus.ACTIVE,
    from: [MerchantStatus.DRAFT, MerchantStatus.PENDING_REVIEW],
    label: '核准上線',
  },
  [MerchantAdminAction.SUSPEND]: {
    to: MerchantStatus.SUSPENDED,
    from: [MerchantStatus.ACTIVE],
    // A suspended shop must stop receiving orders immediately. Leaving the
    // switch on would let a paid order arrive at a kitchen nobody is watching.
    acceptsOrders: false,
    label: '暫停營業',
  },
  [MerchantAdminAction.REINSTATE]: {
    to: MerchantStatus.ACTIVE,
    from: [MerchantStatus.SUSPENDED],
    label: '恢復營業',
  },
  [MerchantAdminAction.CLOSE]: {
    to: MerchantStatus.CLOSED,
    from: [
      MerchantStatus.DRAFT,
      MerchantStatus.PENDING_REVIEW,
      MerchantStatus.ACTIVE,
      MerchantStatus.SUSPENDED,
    ],
    acceptsOrders: false,
    label: '結業',
  },
};

export interface MerchantActionOutcome {
  readonly from: MerchantStatus;
  readonly to: MerchantStatus;
  readonly acceptsOrders?: boolean;
}

/** Every action legal from `from`, in the order the admin UI should show them. */
export function allowedMerchantActions(from: MerchantStatus): MerchantAdminAction[] {
  return (Object.keys(RULES) as MerchantAdminAction[]).filter((action) =>
    RULES[action].from.includes(from),
  );
}

export function describeMerchantAction(action: MerchantAdminAction): string {
  return RULES[action].label;
}

/**
 * Resolve an action, or throw.
 *
 * Throws rather than returning a sentinel so a caller cannot forget to check —
 * the same contract as `OrderStateMachine.transition`.
 */
export function applyMerchantAction(
  from: MerchantStatus,
  action: MerchantAdminAction,
): MerchantActionOutcome {
  const rule = RULES[action];
  if (!rule) throw new MerchantStatusTransitionError(action, from, []);

  if (!rule.from.includes(from)) {
    throw new MerchantStatusTransitionError(action, from, allowedMerchantActions(from));
  }

  return { from, to: rule.to, acceptsOrders: rule.acceptsOrders };
}

/** `CLOSED` is the only terminal merchant status. */
export function isMerchantTerminal(status: MerchantStatus): boolean {
  return status === MerchantStatus.CLOSED;
}
