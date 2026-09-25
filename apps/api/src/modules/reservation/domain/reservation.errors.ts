import { DomainError } from '@takeout/domain';

/** Codes line up with `DOMAIN_CODE_TO_STATUS` in the API's exception filter. */

/**
 * Another writer changed the reservation between the locking read and the
 * update.
 *
 * Mapped to `ILLEGAL_ORDER_TRANSITION`'s sibling code so it surfaces as 409:
 * the request was well-formed, the book moved on underneath it. Named for the
 * resource rather than reusing the order's code, because the log line should
 * say which aggregate raced.
 */
export class ConcurrentReservationModificationError extends DomainError {
  constructor(reservationId: string, expectedStatus: string) {
    super('RESERVATION_NOT_PERMITTED', `此訂位已由其他請求更新（原狀態 ${expectedStatus}）`, {
      reservationId,
      expectedStatus,
    });
  }
}
