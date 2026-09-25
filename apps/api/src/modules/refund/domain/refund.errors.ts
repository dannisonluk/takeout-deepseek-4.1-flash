import { DomainError } from '@takeout/domain';

/** Codes line up with `DOMAIN_CODE_TO_STATUS` in the API's exception filter. */

/**
 * Another writer changed the ticket between the locking read and the update.
 *
 * Surfaced as 409: the request was well-formed, the ticket moved on underneath
 * it. Named for the resource rather than reusing the order's code, because the
 * log line should say which aggregate raced.
 */
export class ConcurrentRefundModificationError extends DomainError {
  constructor(refundRequestId: string, expectedStatus: string) {
    super('REFUND_REQUEST_NOT_PERMITTED', `此退款申請已由其他請求更新（原狀態 ${expectedStatus}）`, {
      refundRequestId,
      expectedStatus,
    });
  }
}

/**
 * The customer asked to file a ticket on somebody else's order.
 *
 * Answered as **404**, not 403, at the controller — the same choice the order
 * and reservation endpoints make. A 403 on a guessed id confirms the id exists.
 */
export class OrderNotOwnedByCustomerError extends DomainError {
  constructor(orderId: string) {
    super('ORDER_NOT_FOUND', 'Order not found', { orderId });
  }
}
