import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  REFUND_REASON_CODES,
  RefundAmountInvalidError,
  RefundReasonCode,
  RefundRequestActor,
  RefundRequestAlreadyTerminalError,
  RefundRequestNotPermittedError,
  RefundRequestSideEffect,
  RefundRequestStateMachine,
  RefundRequestStatus,
  RefundSettlementDetailsRequiredError,
  isActiveRefundRequestStatus,
  isOrderRefundRequestable,
  isRefundReasonCode,
  isTerminalRefundRequestStatus,
  requiresNote,
  validateRequestedAmount,
} from '../src/index';

/**
 * 退款申請工單.
 *
 * This is a **ticket** flow and the tests say so in the places that matter. The
 * two assertions that carry the most weight are:
 *
 *   - the side-effect enum contains **no** money-moving member, and
 *   - `RESOLVED_OFFLINE` cannot be reached without saying what was handed over.
 *
 * The first pins the boundary against a future edit that quietly adds
 * `REFUND_PAYMENT`; the second pins the one rule that stops a shop from clearing
 * its complaint queue by pressing a button.
 */

const AT = '2026-09-25T10:00:00.000Z';

const makeMachine = () => new RefundRequestStateMachine(new FixedClock(AT));

const base = {
  refundRequestId: 'rr_1',
  orderId: 'ord_1',
  merchantId: 'mer_1',
  actorId: 'usr_1',
} as const;

const settlement = { settledAmountMinor: 5800, settlementReference: 'FPS-88213' };

// ---------------------------------------------------------------------------

describe('refund vocabulary', () => {
  it('classifies OPEN and IN_DISCUSSION as active, the rest as terminal', () => {
    expect(isActiveRefundRequestStatus(RefundRequestStatus.OPEN)).toBe(true);
    expect(isActiveRefundRequestStatus(RefundRequestStatus.IN_DISCUSSION)).toBe(true);

    expect(isTerminalRefundRequestStatus(RefundRequestStatus.RESOLVED_OFFLINE)).toBe(true);
    expect(isTerminalRefundRequestStatus(RefundRequestStatus.DECLINED)).toBe(true);
    expect(isTerminalRefundRequestStatus(RefundRequestStatus.CANCELLED)).toBe(true);
  });

  it('every status is either active or terminal — never neither, never both', () => {
    for (const status of Object.values(RefundRequestStatus)) {
      const active = isActiveRefundRequestStatus(status);
      const terminal = isTerminalRefundRequestStatus(status);
      expect(active !== terminal, `${status} is active=${active} terminal=${terminal}`).toBe(
        true,
      );
    }
  });

  it('rejects a reason code that is not on the closed list', () => {
    expect(isRefundReasonCode('QUALITY')).toBe(true);
    expect(isRefundReasonCode('quality')).toBe(false);
    expect(isRefundReasonCode('SOMETHING_ELSE')).toBe(false);
    expect(isRefundReasonCode(null)).toBe(false);
    expect(REFUND_REASON_CODES).toHaveLength(6);
  });

  it('allows a request on any order that has been paid for, and no other', () => {
    for (const status of ['PAID', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'COMPLETED', 'REJECTED', 'REFUNDED']) {
      expect(isOrderRefundRequestable(status), status).toBe(true);
    }
    for (const status of ['PENDING_PAYMENT', 'EXPIRED', 'CANCELLED']) {
      expect(isOrderRefundRequestable(status), status).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the boundary — no money side effect exists', () => {
  it('RefundRequestSideEffect contains only notification members', () => {
    const members = Object.keys(RefundRequestSideEffect).sort();
    expect(members).toEqual(['NOTIFY_CUSTOMER', 'NOTIFY_MERCHANT']);
  });

  it('no transition anywhere carries a money-moving side effect', () => {
    const machine = makeMachine();
    for (const from of Object.values(RefundRequestStatus)) {
      for (const rule of machine.transitionsFrom(from)) {
        for (const effect of rule.sideEffects) {
          expect(
            Object.values(RefundRequestSideEffect).includes(effect),
            `${from} -> ${rule.to} emitted ${effect}`,
          ).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('customer filing permissions', () => {
  it('a customer may withdraw their own ticket from either active status', () => {
    const machine = makeMachine();
    expect(machine.can(RefundRequestStatus.OPEN, RefundRequestStatus.CANCELLED, RefundRequestActor.CUSTOMER)).toBe(true);
    expect(machine.can(RefundRequestStatus.IN_DISCUSSION, RefundRequestStatus.CANCELLED, RefundRequestActor.CUSTOMER)).toBe(true);
  });

  it('a customer may never resolve or decline — only the shop decides', () => {
    const machine = makeMachine();
    for (const from of [RefundRequestStatus.OPEN, RefundRequestStatus.IN_DISCUSSION]) {
      expect(machine.can(from, RefundRequestStatus.RESOLVED_OFFLINE, RefundRequestActor.CUSTOMER), from).toBe(false);
      expect(machine.can(from, RefundRequestStatus.DECLINED, RefundRequestActor.CUSTOMER), from).toBe(false);
      expect(machine.can(from, RefundRequestStatus.IN_DISCUSSION, RefundRequestActor.CUSTOMER), from).toBe(false);
    }
  });

  it('the shop drives every decision that changes what the customer gets', () => {
    const machine = makeMachine();
    expect(machine.can(RefundRequestStatus.OPEN, RefundRequestStatus.RESOLVED_OFFLINE, RefundRequestActor.MERCHANT)).toBe(true);
    expect(machine.can(RefundRequestStatus.OPEN, RefundRequestStatus.DECLINED, RefundRequestActor.MERCHANT)).toBe(true);
    expect(machine.can(RefundRequestStatus.OPEN, RefundRequestStatus.IN_DISCUSSION, RefundRequestActor.MERCHANT)).toBe(true);
  });

  it('allowedTransitions drives the queue buttons per actor', () => {
    const machine = makeMachine();
    expect(machine.allowedTransitions(RefundRequestStatus.OPEN, RefundRequestActor.MERCHANT).sort()).toEqual(
      ['DECLINED', 'IN_DISCUSSION', 'RESOLVED_OFFLINE'].sort(),
    );
    expect(machine.allowedTransitions(RefundRequestStatus.OPEN, RefundRequestActor.CUSTOMER)).toEqual([
      RefundRequestStatus.CANCELLED,
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('open -> in_discussion notifies both sides', () => {
    const result = makeMachine().transition({
      ...base,
      from: RefundRequestStatus.OPEN,
      to: RefundRequestStatus.IN_DISCUSSION,
      actor: RefundRequestActor.MERCHANT,
    });
    expect(result.sideEffects).toEqual([
      RefundRequestSideEffect.NOTIFY_CUSTOMER,
      RefundRequestSideEffect.NOTIFY_MERCHANT,
    ]);
    expect(result.occurredAt).toEqual(new Date(AT));
  });

  it('a terminal ticket cannot move again', () => {
    for (const from of [
      RefundRequestStatus.RESOLVED_OFFLINE,
      RefundRequestStatus.DECLINED,
      RefundRequestStatus.CANCELLED,
    ]) {
      expect(() =>
        makeMachine().transition({
          ...base,
          from,
          to: RefundRequestStatus.IN_DISCUSSION,
          actor: RefundRequestActor.ADMIN,
        }),
      ).toThrow(RefundRequestAlreadyTerminalError);
    }
  });

  it('a move the table does not allow names who IS allowed', () => {
    // A customer trying to resolve. The target is legal for the ticket — just
    // not for them — so the error names the actors who may, not the customer's
    // own (much shorter) list. "This move is not yours to make" and "there is
    // no such move" are different answers, and the machine keeps them apart.
    const probe = makeMachine().tryTransition({
      ...base,
      from: RefundRequestStatus.OPEN,
      to: RefundRequestStatus.RESOLVED_OFFLINE,
      actor: RefundRequestActor.CUSTOMER,
    });
    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error('unreachable');
    expect(probe.error).toBeInstanceOf(RefundRequestNotPermittedError);
    expect((probe.error as RefundRequestNotPermittedError).allowed).toEqual([
      RefundRequestActor.MERCHANT,
      RefundRequestActor.ADMIN,
    ]);
  });

  it('a move that does not exist at all names every target from here', () => {
    const probe = makeMachine().tryTransition({
      ...base,
      from: RefundRequestStatus.OPEN,
      to: 'REFUNDED' as RefundRequestStatus,
      actor: RefundRequestActor.MERCHANT,
    });
    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error('unreachable');
    // The fallback lists the row's real exits — never a money status.
    expect((probe.error as RefundRequestNotPermittedError).allowed).not.toContain('REFUNDED');
    expect((probe.error as RefundRequestNotPermittedError).allowed).toEqual([
      RefundRequestStatus.IN_DISCUSSION,
      RefundRequestStatus.RESOLVED_OFFLINE,
      RefundRequestStatus.DECLINED,
      RefundRequestStatus.CANCELLED,
    ]);
  });

  it('ADMIN can move a ticket the shop has abandoned', () => {
    const result = makeMachine().transition({
      ...base,
      from: RefundRequestStatus.OPEN,
      to: RefundRequestStatus.DECLINED,
      actor: RefundRequestActor.ADMIN,
      reason: '店家已結業',
    });
    expect(result.to).toBe(RefundRequestStatus.DECLINED);
    expect(result.reason).toBe('店家已結業');
  });
});

// ---------------------------------------------------------------------------

describe('RESOLVED_OFFLINE must say what was handed over', () => {
  it('rejects a resolution with neither amount nor reference', () => {
    for (const from of [RefundRequestStatus.OPEN, RefundRequestStatus.IN_DISCUSSION]) {
      expect(() =>
        makeMachine().transition({
          ...base,
          from,
          to: RefundRequestStatus.RESOLVED_OFFLINE,
          actor: RefundRequestActor.MERCHANT,
        }),
      ).toThrow(RefundSettlementDetailsRequiredError);
    }
  });

  it('rejects a blank or whitespace-only reference', () => {
    expect(() =>
      makeMachine().transition({
        ...base,
        from: RefundRequestStatus.OPEN,
        to: RefundRequestStatus.RESOLVED_OFFLINE,
        actor: RefundRequestActor.MERCHANT,
        settlementReference: '   ',
      }),
    ).toThrow(RefundSettlementDetailsRequiredError);
  });

  it('rejects a zero or negative amount with no reference', () => {
    for (const amount of [0, -100]) {
      expect(() =>
        makeMachine().transition({
          ...base,
          from: RefundRequestStatus.OPEN,
          to: RefundRequestStatus.RESOLVED_OFFLINE,
          actor: RefundRequestActor.MERCHANT,
          settledAmountMinor: amount,
        }),
      ).toThrow(RefundSettlementDetailsRequiredError);
    }
  });

  it('accepts an amount alone', () => {
    const result = makeMachine().transition({
      ...base,
      from: RefundRequestStatus.OPEN,
      to: RefundRequestStatus.RESOLVED_OFFLINE,
      actor: RefundRequestActor.MERCHANT,
      settledAmountMinor: 5800,
    });
    expect(result.to).toBe(RefundRequestStatus.RESOLVED_OFFLINE);
  });

  it('accepts a reference alone — cash with no split to record', () => {
    const result = makeMachine().transition({
      ...base,
      from: RefundRequestStatus.OPEN,
      to: RefundRequestStatus.RESOLVED_OFFLINE,
      actor: RefundRequestActor.MERCHANT,
      settlementReference: 'CASH-AT-COUNTER',
    });
    expect(result.to).toBe(RefundRequestStatus.RESOLVED_OFFLINE);
  });

  it('resolving from IN_DISCUSSION needs the details too', () => {
    expect(() =>
      makeMachine().transition({
        ...base,
        from: RefundRequestStatus.IN_DISCUSSION,
        to: RefundRequestStatus.RESOLVED_OFFLINE,
        actor: RefundRequestActor.MERCHANT,
      }),
    ).toThrow(RefundSettlementDetailsRequiredError);

    expect(() =>
      makeMachine().transition({
        ...base,
        from: RefundRequestStatus.IN_DISCUSSION,
        to: RefundRequestStatus.RESOLVED_OFFLINE,
        actor: RefundRequestActor.MERCHANT,
        ...settlement,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('filing policy', () => {
  it('the requested amount is advisory but must be a plausible ask', () => {
    expect(validateRequestedAmount(null, 13400)).toBeNull();
    expect(validateRequestedAmount(undefined, 13400)).toBeNull();
    expect(validateRequestedAmount(5800, 13400)).toBe(5800);
    expect(validateRequestedAmount(13400, 13400)).toBe(13400);
  });

  it('rejects a fraction, a zero and anything above the order total', () => {
    for (const amount of [1.5, 0, -1, 13401]) {
      expect(() => validateRequestedAmount(amount, 13400), String(amount)).toThrow(
        RefundAmountInvalidError,
      );
    }
  });

  it('OTHER with no note is unanswerable and must be refused', () => {
    expect(requiresNote(RefundReasonCode.OTHER)).toBe(true);
    expect(requiresNote(RefundReasonCode.OTHER, '   ')).toBe(true);
    expect(requiresNote(RefundReasonCode.OTHER, '等了一小時')).toBe(false);
  });

  it('a specific reason needs no note', () => {
    expect(requiresNote(RefundReasonCode.QUALITY)).toBe(false);
    expect(requiresNote(RefundReasonCode.WRONG_ITEM)).toBe(false);
  });
});
