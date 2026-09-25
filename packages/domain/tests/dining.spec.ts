import { describe, expect, it } from 'vitest';
import { FixedClock } from '../src/shared/index';
import {
  DiningSessionMachine,
  DiningSessionStatus,
  assertNoOpenSession,
  isTerminalDiningSessionStatus,
} from '../src/waitlist/index';

const NOW = new Date('2026-09-25T12:00:00.000Z');

describe('dining session lifecycle', () => {
  it('only an OPEN sitting accepts orders', () => {
    const machine = new DiningSessionMachine(new FixedClock(NOW));
    expect(machine.canOrder(DiningSessionStatus.OPEN)).toBe(true);
    expect(machine.canOrder(DiningSessionStatus.CLOSED)).toBe(false);
    expect(machine.canOrder(DiningSessionStatus.ABANDONED)).toBe(false);
  });

  it('closes to CLOSED and stamps the time', () => {
    const machine = new DiningSessionMachine(new FixedClock(NOW));
    const result = machine.close({
      diningSessionId: 's1',
      status: DiningSessionStatus.OPEN,
    });
    expect(result).toMatchObject({
      from: DiningSessionStatus.OPEN,
      to: DiningSessionStatus.CLOSED,
    });
    expect(result.closedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('may also be abandoned — the party left without settling', () => {
    const machine = new DiningSessionMachine(new FixedClock(NOW));
    const result = machine.close(
      { diningSessionId: 's1', status: DiningSessionStatus.OPEN },
      DiningSessionStatus.ABANDONED,
    );
    expect(result.to).toBe(DiningSessionStatus.ABANDONED);
  });

  it('refuses to close something already closed', () => {
    const machine = new DiningSessionMachine(new FixedClock(NOW));
    expect(() =>
      machine.close({ diningSessionId: 's1', status: DiningSessionStatus.CLOSED }),
    ).toThrow(/已結束/);
  });

  it('refuses to "close" to a non-terminal state', () => {
    // A typo in the target would otherwise leave the table OPEN while the
    // response says it is shut.
    const machine = new DiningSessionMachine(new FixedClock(NOW));
    expect(() =>
      machine.close({ diningSessionId: 's1', status: DiningSessionStatus.OPEN }, DiningSessionStatus.OPEN),
    ).toThrow();
  });

  it('classifies the two endings as terminal and the live one as not', () => {
    expect(isTerminalDiningSessionStatus(DiningSessionStatus.OPEN)).toBe(false);
    expect(isTerminalDiningSessionStatus(DiningSessionStatus.CLOSED)).toBe(true);
    expect(isTerminalDiningSessionStatus(DiningSessionStatus.ABANDONED)).toBe(true);
  });

  it('refuses a second open sitting on one table', () => {
    // Two open sittings on a table is silent data corruption, not a race the
    // service layer should be trusted to prevent.
    expect(() =>
      assertNoOpenSession('table-1', { id: 's1', status: DiningSessionStatus.OPEN }),
    ).toThrow(/已有進行中的用餐時段/);
  });

  it('allows a new sitting once the previous one ended', () => {
    expect(() =>
      assertNoOpenSession('table-1', { id: 's1', status: DiningSessionStatus.CLOSED }),
    ).not.toThrow();
    expect(() => assertNoOpenSession('table-1', null)).not.toThrow();
  });
});
