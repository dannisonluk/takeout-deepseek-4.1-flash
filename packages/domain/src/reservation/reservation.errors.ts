import { DomainError } from '../shared/index';

/** Codes line up with `DOMAIN_CODE_TO_STATUS` in the API's exception filter. */

export class ReservationNotFoundError extends DomainError {
  constructor(reservationId: string) {
    super('RESERVATION_NOT_FOUND', 'Reservation not found', { reservationId });
  }
}

/** The merchant has not switched the reservation book on. */
export class ReservationsDisabledError extends DomainError {
  constructor(merchantId: string) {
    super('RESERVATIONS_DISABLED', '此店家尚未開放訂位', { merchantId });
  }
}

export class PartySizeNotAllowedError extends DomainError {
  constructor(
    readonly partySize: number,
    readonly min: number,
    readonly max: number,
  ) {
    super(
      'PARTY_SIZE_NOT_ALLOWED',
      `訂位人數需介乎 ${min} 至 ${max} 人，你選了 ${partySize} 人`,
      { partySize, min, max },
    );
  }
}

/**
 * Too soon.
 *
 * A distinct code from `RESERVATION_TIME_UNAVAILABLE` because the customer's
 * fix is different: this one means "pick a later time", the other means "that
 * particular time is full".
 */
export class ReservationTooSoonError extends DomainError {
  constructor(readonly leadTimeMinutes: number, readonly earliestAt: Date) {
    super(
      'RESERVATION_TOO_SOON',
      `訂位需於 ${leadTimeMinutes} 分鐘前提出，最早可訂 ${earliestAt.toISOString()}`,
      { leadTimeMinutes, earliestAt: earliestAt.toISOString() },
    );
  }
}

export class ReservationTooFarAheadError extends DomainError {
  constructor(readonly advanceDays: number, readonly latestAt: Date) {
    super('RESERVATION_TOO_FAR_AHEAD', `最多只可預訂 ${advanceDays} 天內的座位`, {
      advanceDays,
      latestAt: latestAt.toISOString(),
    });
  }
}

/** The start time is not on the bookable grid — 19:07 when slots are every 30 minutes. */
export class ReservationSlotMisalignedError extends DomainError {
  constructor(readonly slotMinutes: number, readonly requested: Date) {
    super('RESERVATION_SLOT_MISALIGNED', `訂位時間需為 ${slotMinutes} 分鐘的整點間隔`, {
      slotMinutes,
      requested: requested.toISOString(),
    });
  }
}

/**
 * Every table at that time is taken.
 *
 * Carries the neighbouring times that ARE free, so the UI can offer a fix
 * instead of leaving the customer to guess.
 */
export class ReservationSlotUnavailableError extends DomainError {
  constructor(
    readonly startsAt: Date,
    readonly alternatives: readonly Date[],
  ) {
    super('RESERVATION_SLOT_UNAVAILABLE', '該時段已滿，請選擇其他時間', {
      startsAt: startsAt.toISOString(),
      alternatives: alternatives.map((slot) => slot.toISOString()),
    });
  }
}

export class ReservationNotPermittedError extends DomainError {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly actor: string,
    readonly allowed: readonly string[],
  ) {
    super(
      'RESERVATION_NOT_PERMITTED',
      `${actor} 不能把訂位由 ${from} 改成 ${to}`,
      { from, to, actor, allowed: [...allowed] },
    );
  }
}

export class ReservationAlreadyTerminalError extends DomainError {
  constructor(readonly from: string) {
    super('RESERVATION_ALREADY_TERMINAL', `訂位已是 ${from}，不能再變更`, { from });
  }
}

/**
 * The book is paused.
 *
 * Separate from `RESERVATIONS_DISABLED` because the fix is different: the shop
 * has the feature on but has stopped taking new bookings, so "come back later"
 * rather than "this shop does not do reservations".
 */
export class ReservationsPausedError extends DomainError {
  constructor(merchantId: string) {
    super('RESERVATIONS_PAUSED', '此店家暫停接受新訂位', { merchantId });
  }
}

/**
 * A no-show declared before the party is late.
 *
 * Without this a shop could clear tonight's book at lunchtime and hand the
 * seats to somebody else while the original party is still planning to turn up.
 */
export class ReservationOutsideTurnWindowError extends DomainError {
  constructor(reservationId: string) {
    super('RESERVATION_OUTSIDE_TURN_WINDOW', '未到訂位時間，無法標記為未到', {
      reservationId,
    });
  }
}
