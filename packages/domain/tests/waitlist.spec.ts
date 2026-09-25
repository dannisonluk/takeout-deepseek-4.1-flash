import { describe, expect, it } from 'vitest';
import { FixedClock } from '../src/shared/index';
import {
  DEFAULT_WAITLIST_POLICY,
  WaitlistActor,
  WaitlistSideEffect,
  WaitlistStateMachine,
  WaitlistStatus,
  assertPartySize,
  dayLetterFor,
  estimateWaitMinutes,
  isActiveWaitlistStatus,
  isTerminalWaitlistStatus,
  isWaitlistReason,
  nextTicketNo,
  normalizeGuestName,
  normalizePhone,
  normalizeTableCode,
  queuePosition,
  WAITLIST_REASON,
  type QueueTicket,
} from '../src/waitlist/index';

const NOW = new Date('2026-09-25T12:00:00.000Z');

function ticket(over: Partial<QueueTicket> = {}): QueueTicket {
  return {
    id: 't1',
    status: WaitlistStatus.WAITING,
    joinedAt: new Date('2026-09-25T11:00:00.000Z'),
    calledAt: null,
    ...over,
  };
}

function machine() {
  return new WaitlistStateMachine(new FixedClock(NOW));
}

describe('waitlist vocabulary', () => {
  it('classifies WAITING and CALLED as active, the rest as terminal', () => {
    expect(isActiveWaitlistStatus(WaitlistStatus.WAITING)).toBe(true);
    expect(isActiveWaitlistStatus(WaitlistStatus.CALLED)).toBe(true);
    expect(isTerminalWaitlistStatus(WaitlistStatus.SEATED)).toBe(true);
    expect(isTerminalWaitlistStatus(WaitlistStatus.NO_SHOW)).toBe(true);
    expect(isTerminalWaitlistStatus(WaitlistStatus.CANCELLED)).toBe(true);
  });

  it('makes every status either active or terminal — never neither, never both', () => {
    for (const status of Object.values(WaitlistStatus)) {
      const active = isActiveWaitlistStatus(status);
      const terminal = isTerminalWaitlistStatus(status);
      expect(active !== terminal, `${status} must be exactly one of active/terminal`).toBe(true);
    }
  });

  it('has no PENDING — taking a ticket IS the confirmation', () => {
    expect('PENDING' in WaitlistStatus).toBe(false);
  });

  it('recognises only the declared reasons', () => {
    expect(isWaitlistReason(WAITLIST_REASON.CALL_TIMEOUT)).toBe(true);
    expect(isWaitlistReason('MADE_UP')).toBe(false);
  });
});

describe('waitlist permissions', () => {
  it('lets a guest leave the queue only while waiting', () => {
    const m = machine();
    expect(m.can(WaitlistStatus.WAITING, WaitlistStatus.CANCELLED, WaitlistActor.CUSTOMER)).toBe(
      true,
    );
    // Once called, the shop is holding a table. Vanishing is a no-show, not a
    // cancellation, and the two need different books.
    expect(m.can(WaitlistStatus.CALLED, WaitlistStatus.CANCELLED, WaitlistActor.CUSTOMER)).toBe(
      false,
    );
  });

  it('never lets a guest seat themselves', () => {
    const m = machine();
    for (const from of [WaitlistStatus.WAITING, WaitlistStatus.CALLED]) {
      expect(m.can(from, WaitlistStatus.SEATED, WaitlistActor.CUSTOMER)).toBe(false);
    }
  });

  it('lets the host seat a waiting guest directly, without the call', () => {
    // The guest is already at the door; making the host call then seat is theatre.
    expect(
      machine().can(WaitlistStatus.WAITING, WaitlistStatus.SEATED, WaitlistActor.MERCHANT),
    ).toBe(true);
  });

  it('lets the system time out a called guest, but never a waiting one', () => {
    const m = machine();
    expect(m.can(WaitlistStatus.CALLED, WaitlistStatus.NO_SHOW, WaitlistActor.SYSTEM)).toBe(true);
    expect(m.can(WaitlistStatus.WAITING, WaitlistStatus.NO_SHOW, WaitlistActor.SYSTEM)).toBe(false);
  });

  it('drives the board buttons per actor', () => {
    const m = machine();
    expect(m.allowedTransitions(WaitlistStatus.WAITING, WaitlistActor.MERCHANT)).toEqual([
      WaitlistStatus.CALLED,
      WaitlistStatus.SEATED,
      WaitlistStatus.CANCELLED,
      WaitlistStatus.NO_SHOW,
    ]);
    expect(m.allowedTransitions(WaitlistStatus.WAITING, WaitlistActor.CUSTOMER)).toEqual([
      WaitlistStatus.CANCELLED,
    ]);
  });
});

describe('waitlist lifecycle', () => {
  it('starts a call timer when a guest is called, and only then', () => {
    const result = machine().transition(
      {
        waitlistEntryId: 't1',
        merchantId: 'm1',
        from: WaitlistStatus.WAITING,
        to: WaitlistStatus.CALLED,
        actor: WaitlistActor.MERCHANT,
        now: NOW,
      },
      { callTimeoutMinutes: 10 },
    );
    expect(result.sideEffects).toContain(WaitlistSideEffect.START_CALL_TIMEOUT);
    expect(result.sideEffects).toContain(WaitlistSideEffect.NOTIFY_CUSTOMER);
    expect(result.callDeadlineAt?.toISOString()).toBe('2026-09-25T12:10:00.000Z');
  });

  it('does not start a timer when seating a waiting guest directly', () => {
    const result = machine().transition({
      waitlistEntryId: 't1',
      merchantId: 'm1',
      from: WaitlistStatus.WAITING,
      to: WaitlistStatus.SEATED,
      actor: WaitlistActor.MERCHANT,
      now: NOW,
    });
    expect(result.callDeadlineAt).toBeUndefined();
  });

  it('carries no release effect — a ticket never held a table', () => {
    // This is why the waitlist machine is genuinely smaller than the
    // reservation one rather than a copy of it with the nouns changed.
    const members = Object.values(WaitlistSideEffect) as string[];
    expect(members).not.toContain('RELEASE_TABLE_SLOT');
  });

  it('refuses to move a terminal ticket', () => {
    expect(() =>
      machine().transition({
        waitlistEntryId: 't1',
        merchantId: 'm1',
        from: WaitlistStatus.SEATED,
        to: WaitlistStatus.CANCELLED,
        actor: WaitlistActor.MERCHANT,
      }),
    ).toThrow(/已結束/);
  });

  it('distinguishes "not a move" from "not yours to make"', () => {
    const m = machine();
    // Reachable, but not by a customer -> the actor error.
    expect(() =>
      m.transition({
        waitlistEntryId: 't1',
        merchantId: 'm1',
        from: WaitlistStatus.CALLED,
        to: WaitlistStatus.SEATED,
        actor: WaitlistActor.CUSTOMER,
      }),
    ).toThrow(/不能將候位由/);

    // Not reachable at all -> the permission error naming what IS reachable.
    expect(() =>
      m.transition({
        waitlistEntryId: 't1',
        merchantId: 'm1',
        from: WaitlistStatus.WAITING,
        to: WaitlistStatus.SEATED,
        actor: WaitlistActor.SYSTEM,
      }),
    ).toThrow(/可執行者/);
  });

  it('probes without throwing', () => {
    const probe = machine().tryTransition({
      waitlistEntryId: 't1',
      merchantId: 'm1',
      from: WaitlistStatus.SEATED,
      to: WaitlistStatus.CANCELLED,
      actor: WaitlistActor.MERCHANT,
    });
    expect(probe.ok).toBe(false);
  });
});

describe('ticket numbering', () => {
  it('starts a day at 001 and increments', () => {
    expect(nextTicketNo([])).toBe('A-001');
    expect(nextTicketNo(['A-001'])).toBe('A-002');
    expect(nextTicketNo(['A-001', 'A-002', 'A-003'])).toBe('A-004');
  });

  it('does NOT reuse a gap left by a cancellation', () => {
    // Two different parties briefly holding A-014 is a corridor argument.
    expect(nextTicketNo(['A-013', 'A-014', 'A-016'])).toBe('A-017');
  });

  it('uses the day letter and tolerates junk in the list', () => {
    expect(nextTicketNo(['B-007'], 'B')).toBe('B-008');
    expect(nextTicketNo(['not-a-ticket', '', 'A-005'])).toBe('A-006');
  });

  it('derives a stable letter from the date — not a rotating counter', () => {
    // The same date must yield the same letter after a restart, or a guest's
    // ticket changes meaning overnight.
    expect(dayLetterFor('2026-09-25')).toBe(dayLetterFor('2026-09-25'));
    expect(dayLetterFor('2026-09-25')).toMatch(/^[A-H]$/);
  });
});

describe('queue position', () => {
  const policy = { averageTurnMinutes: 30 };

  it('is 1-based, ordered by join time', () => {
    const tickets = [
      ticket({ id: 'a', joinedAt: new Date('2026-09-25T11:00:00Z') }),
      ticket({ id: 'b', joinedAt: new Date('2026-09-25T11:05:00Z') }),
      ticket({ id: 'c', joinedAt: new Date('2026-09-25T11:10:00Z') }),
    ];
    expect(queuePosition(tickets, 'a', policy).position).toBe(1);
    expect(queuePosition(tickets, 'b', policy).position).toBe(2);
    expect(queuePosition(tickets, 'c', policy).position).toBe(3);
    expect(queuePosition(tickets, 'c', policy).ahead).toBe(2);
  });

  it('is computed on read — a cancellation simply shrinks the queue', () => {
    const before = [
      ticket({ id: 'a', joinedAt: new Date('2026-09-25T11:00:00Z') }),
      ticket({ id: 'b', joinedAt: new Date('2026-09-25T11:05:00Z') }),
    ];
    expect(queuePosition(before, 'b', policy).position).toBe(2);
    // 'a' cancels: no renumbering write happened, the count just dropped.
    // Rebuilt rather than spread so the element type stays `QueueTicket`
    // (`noUncheckedIndexedAccess` makes `before[0]` possibly-undefined).
    const after = [
      ticket({ id: 'a', joinedAt: new Date('2026-09-25T11:00:00Z'), status: WaitlistStatus.CANCELLED }),
      ticket({ id: 'b', joinedAt: new Date('2026-09-25T11:05:00Z') }),
    ];
    expect(queuePosition(after, 'b', policy).position).toBe(1);
  });

  it('counts a CALLED party as still ahead — the kitchen has not cleared them', () => {
    const tickets = [
      ticket({ id: 'a', status: WaitlistStatus.CALLED }),
      ticket({ id: 'b', joinedAt: new Date('2026-09-25T11:30:00Z') }),
    ];
    expect(queuePosition(tickets, 'b', policy).ahead).toBe(1);
  });

  it('returns position 0 for a ticket that is no longer queued, without throwing', () => {
    // The guest's own page polls this and must survive their ticket ending.
    const tickets = [ticket({ id: 'a', status: WaitlistStatus.SEATED })];
    expect(queuePosition(tickets, 'a', policy)).toEqual({
      position: 0,
      ahead: 0,
      estimatedWaitMinutes: null,
    });
    expect(queuePosition(tickets, 'missing', policy).position).toBe(0);
  });

  it('breaks a same-millisecond tie deterministically', () => {
    const same = new Date('2026-09-25T11:00:00Z');
    const tickets = [ticket({ id: 'b', joinedAt: same }), ticket({ id: 'a', joinedAt: same })];
    // Stable across two reads, or two hosts see different orders.
    expect(queuePosition(tickets, 'a', policy).position).toBe(
      queuePosition([...tickets].reverse(), 'a', policy).position,
    );
  });

  it('never quotes less than one turn to anybody with someone ahead', () => {
    // "2 minutes" to the second person in a 45-minute queue is worse than nothing.
    expect(estimateWaitMinutes(1, [], { averageTurnMinutes: 45 })).toBe(45);
    expect(estimateWaitMinutes(2, [], { averageTurnMinutes: 45 })).toBe(90);
    // Head of queue is next: zero, and the copy says "下一位".
    expect(estimateWaitMinutes(0, [], { averageTurnMinutes: 45 })).toBe(0);
  });

  it('discounts a party that is already being walked to a table', () => {
    const tickets = [ticket({ id: 'a', status: WaitlistStatus.CALLED })];
    expect(estimateWaitMinutes(1, tickets, { averageTurnMinutes: 30 })).toBe(15);
  });
});

describe('guest input normalisation', () => {
  it('trims and collapses a name', () => {
    expect(normalizeGuestName('  陳 大文  ')).toBe('陳 大文');
    expect(normalizeGuestName('a'.repeat(200)).length).toBe(80);
  });

  it('strips spacing and dashes from a phone', () => {
    expect(normalizePhone('+852 9000-0001')).toBe('+85290000001');
  });

  it('normalises a table code, because a human types it off a label', () => {
    // `a12`, `A-12` and `A 12` are the same table.
    expect(normalizeTableCode('a12')).toBe('A12');
    expect(normalizeTableCode('A-12')).toBe('A12');
    expect(normalizeTableCode(' A 12 ')).toBe('A12');
  });

  it('rejects a party size outside the shop policy', () => {
    expect(() => assertPartySize(2, DEFAULT_WAITLIST_POLICY)).not.toThrow();
    expect(() => assertPartySize(0, DEFAULT_WAITLIST_POLICY)).toThrow();
    expect(() => assertPartySize(11, DEFAULT_WAITLIST_POLICY)).toThrow();
    expect(() => assertPartySize(Number.NaN, DEFAULT_WAITLIST_POLICY)).toThrow();
  });
});
