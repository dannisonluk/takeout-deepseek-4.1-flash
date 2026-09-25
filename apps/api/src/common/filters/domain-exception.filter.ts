import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainError } from '@takeout/domain';
import { InvalidAnalyticsWindowError } from '../../modules/merchants/application/analytics.service';
import { Request, Response } from 'express';

/**
 * Translates a domain `DomainError.code` into an HTTP response.
 *
 * The domain layer never imports an HTTP library — this filter is the single
 * place where business codes become status codes. Keeping the mapping in one
 * table means a new domain error cannot silently become a 500.
 */
const DOMAIN_CODE_TO_STATUS: Readonly<Record<string, HttpStatus>> = {
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  EMPTY_ORDER: HttpStatus.BAD_REQUEST,
  INVALID_QUANTITY: HttpStatus.BAD_REQUEST,
  INVALID_UNIT_PRICE: HttpStatus.BAD_REQUEST,
  MONEY_NOT_FINITE: HttpStatus.BAD_REQUEST,
  MONEY_NON_INTEGER_MINOR: HttpStatus.BAD_REQUEST,
  MONEY_CURRENCY_MISMATCH: HttpStatus.BAD_REQUEST,

  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  INVALID_OTP: HttpStatus.UNAUTHORIZED,
  SESSION_EXPIRED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  ACTOR_NOT_PERMITTED: HttpStatus.FORBIDDEN,
  ACCOUNT_DISABLED: HttpStatus.FORBIDDEN,
  OTP_RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,

  ORDER_NOT_FOUND: HttpStatus.NOT_FOUND,
  MERCHANT_NOT_FOUND: HttpStatus.NOT_FOUND,
  MENU_ITEM_NOT_FOUND: HttpStatus.NOT_FOUND,
  CATEGORY_NOT_FOUND: HttpStatus.NOT_FOUND,
  REVIEW_NOT_FOUND: HttpStatus.NOT_FOUND,
  ADMIN_TARGET_NOT_FOUND: HttpStatus.NOT_FOUND,
  IMAGE_ASSET_NOT_FOUND: HttpStatus.NOT_FOUND,
  RESERVATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  CLOSURE_NOT_FOUND: HttpStatus.NOT_FOUND,
  REFUND_REQUEST_NOT_FOUND: HttpStatus.NOT_FOUND,

  ILLEGAL_ORDER_TRANSITION: HttpStatus.CONFLICT,
  ORDER_ALREADY_TERMINAL: HttpStatus.CONFLICT,
  // The order moved on — well-formed request, wrong state. Not a 400.
  PAYMENT_NOT_REQUIRED: HttpStatus.CONFLICT,
  MERCHANT_NOT_ACCEPTING_ORDERS: HttpStatus.CONFLICT,
  // A merchant trying to mark an ONLINE order as settled at the counter. The
  // same class of refusal as ILLEGAL_ORDER_TRANSITION — the request is
  // well-formed and the state is what says no — so it maps the same way rather
  // than leaning on the table's 422 default.
  MANUAL_SETTLEMENT_NOT_ALLOWED: HttpStatus.CONFLICT,
  DAILY_QUOTA_EXHAUSTED: HttpStatus.CONFLICT,
  DUPLICATE_IDEMPOTENCY_KEY: HttpStatus.CONFLICT,
  // Uniqueness clashes the caller must resolve by choosing another value.
  MERCHANT_SLUG_TAKEN: HttpStatus.CONFLICT,
  CATEGORY_NAME_TAKEN: HttpStatus.CONFLICT,
  CATEGORY_IN_USE: HttpStatus.CONFLICT,
  MERCHANT_NOT_EDITABLE: HttpStatus.CONFLICT,
  MERCHANT_STATUS_TRANSITION: HttpStatus.CONFLICT,
  LAST_ADMIN: HttpStatus.CONFLICT,
  OUTBOX_NOT_RETRYABLE: HttpStatus.CONFLICT,
  PAYOUT_NOT_SETTLEABLE: HttpStatus.CONFLICT,
  // The same order cannot be rated twice. A conflict, not a validation error:
  // the payload was fine, the state is what refuses it.
  REVIEW_ALREADY_EXISTS: HttpStatus.CONFLICT,
  // Not collected, cancelled, or past the review window. Well-formed request,
  // business rule says no — the same 422 family as PICKUP_TIME_NOT_FEASIBLE.
  ORDER_NOT_REVIEWABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  // The asset exists but the pipeline has not finished with it. A conflict, not
  // a 404: the resource is there, its state is what refuses the read.
  IMAGE_ASSET_NOT_READY: HttpStatus.CONFLICT,

  // ---- 預約訂位 ----------------------------------------------------------
  // The reservation moved on, or the book's state is what refuses the request.
  // Same family as ILLEGAL_ORDER_TRANSITION: the payload was fine, so 409 —
  // a 422 would tell the client to fix a field that was never wrong.
  RESERVATION_NOT_PERMITTED: HttpStatus.CONFLICT,
  RESERVATION_ALREADY_TERMINAL: HttpStatus.CONFLICT,
  // The ticket moved on, or the actor may not make this move. Same family as
  // the two above: the payload was fine, so 409 — a 422 would tell the client to
  // fix a field that was never wrong.
  REFUND_REQUEST_NOT_PERMITTED: HttpStatus.CONFLICT,
  REFUND_REQUEST_ALREADY_TERMINAL: HttpStatus.CONFLICT,
  // Someone is already working this order's ticket. 409 rather than 422: a
  // second identical request is a legitimate retry, and the answer is "wait for
  // the open one", not "your payload is wrong".
  REFUND_REQUEST_ALREADY_OPEN: HttpStatus.CONFLICT,
  // The book is on but the shop stopped taking new bookings. Retrying later is
  // the instruction, which is what a 409 says.
  RESERVATIONS_PAUSED: HttpStatus.CONFLICT,
  // A no-show declared before the party is late. Well-formed request, the clock
  // is what refuses it.
  RESERVATION_OUTSIDE_TURN_WINDOW: HttpStatus.CONFLICT,

  SELF_MODIFICATION: HttpStatus.FORBIDDEN,
  PLATFORM_CONFIG_READONLY: HttpStatus.FORBIDDEN,
  REVIEW_NOT_OWNED: HttpStatus.FORBIDDEN,
  REVIEW_REPLY_NOT_ALLOWED: HttpStatus.FORBIDDEN,

  NEGATIVE_MERCHANT_PAYOUT: HttpStatus.UNPROCESSABLE_ENTITY,
  REFUND_WITHOUT_PAYMENT: HttpStatus.UNPROCESSABLE_ENTITY,
  REFUND_NOT_AVAILABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  REFUND_EXCEEDS_CAPTURE: HttpStatus.UNPROCESSABLE_ENTITY,
  UNSUPPORTED_FULFILMENT_MODE: HttpStatus.UNPROCESSABLE_ENTITY,
  PLATFORM_CONFIG_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  OPERATING_HOURS_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  CATEGORY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  // Back-dating a rest day would flip a day the shop actually traded into a
  // closed day and sweep nothing useful. 422 rather than 400: the payload is
  // well-formed, the date is simply not one the shop may close.
  CLOSURE_DATE_IN_PAST: HttpStatus.UNPROCESSABLE_ENTITY,
  // `serviceDate` arrives as a path parameter, so no `@Body()` validator sees
  // it. Without this the caller's typo reaches Prisma as an `Invalid Date` and
  // surfaces as a 500 — the caller's mistake looking like a server fault.
  CLOSURE_DATE_INVALID: HttpStatus.BAD_REQUEST,
  // A rest day is a business rule the request cannot satisfy, not a malformed
  // payload — and it is a DIFFERENT answer from RESERVATION_SLOT_UNAVAILABLE,
  // which a closed day would otherwise also produce.
  MERCHANT_CLOSED: HttpStatus.UNPROCESSABLE_ENTITY,
  // Well-formed requests that the business rules cannot satisfy. 422 rather
  // than 400 so a client can tell "your payload was malformed" apart from
  // "your payload was fine, but this cannot be done".
  PICKUP_TIME_NOT_FEASIBLE: HttpStatus.UNPROCESSABLE_ENTITY,
  MENU_ITEM_UNAVAILABLE: HttpStatus.UNPROCESSABLE_ENTITY,

  // ---- 預約訂位 request refusals -----------------------------------------
  // The shop has not switched reservations on at all. Distinct from
  // RESERVATIONS_PAUSED (409): here there is no book to come back to, so no edit
  // to the request or the clock can make it succeed.
  RESERVATIONS_DISABLED: HttpStatus.UNPROCESSABLE_ENTITY,
  // The request itself names a party size / time the book cannot take. Every one
  // of these is fixable by choosing a different value, which is the 422 test.
  PARTY_SIZE_NOT_ALLOWED: HttpStatus.UNPROCESSABLE_ENTITY,
  RESERVATION_TOO_SOON: HttpStatus.UNPROCESSABLE_ENTITY,
  RESERVATION_TOO_FAR_AHEAD: HttpStatus.UNPROCESSABLE_ENTITY,
  RESERVATION_SLOT_MISALIGNED: HttpStatus.UNPROCESSABLE_ENTITY,
  // Every table at that time is taken. Carries `alternatives`, so the client can
  // offer a fix — and it is a 422 because a different time in the same payload
  // would have worked.
  RESERVATION_SLOT_UNAVAILABLE: HttpStatus.UNPROCESSABLE_ENTITY,

  // ---- 退款申請工單 refusals ---------------------------------------------
  // A note is required for `OTHER` because an unanswerable ticket is worse than
  // no ticket. 400, not 422: the fix is to fill in a field on the same form.
  REFUND_NOTE_REQUIRED: HttpStatus.BAD_REQUEST,
  // Not a whole positive number of minor units, or more than the order total.
  // 400 for the same reason — same form, one field.
  REFUND_AMOUNT_INVALID: HttpStatus.BAD_REQUEST,
  // The order was never paid for, so there is nothing to ask for. Distinct from
  // the admin money-path `REFUND_NOT_AVAILABLE`, which this feature does not
  // touch; a shared code would make the two indistinguishable in a log.
  REFUND_REQUEST_NOT_ALLOWED: HttpStatus.UNPROCESSABLE_ENTITY,
  // `RESOLVED_OFFLINE` with no amount and no reference would close a queue item
  // while recording nothing. 422: the payload is well-formed, the move is not.
  REFUND_SETTLEMENT_DETAILS_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,

  // ---- 現場候位 refusals --------------------------------------------------
  // The party size is outside the shop's range. 400, not 422 — same form, one
  // field, and the response names the range so the guest can just fix it.
  WAITLIST_PARTY_SIZE: HttpStatus.BAD_REQUEST,
  // The shop has not switched the queue on at all. Distinct from
  // WAITLIST_CLOSED: here there is no queue to come back to.
  WAITLIST_DISABLED: HttpStatus.UNPROCESSABLE_ENTITY,
  // The shop is shut. 422, and a *different* code from WAITLIST_DISABLED on
  // purpose: the guest's next action is "come back at 11", not "this shop does
  // not do queues", and one code covering both would make the page guess.
  WAITLIST_CLOSED: HttpStatus.UNPROCESSABLE_ENTITY,
  WAITLIST_ENTRY_NOT_FOUND: HttpStatus.NOT_FOUND,
  // One guest, one live ticket. 409: the request was fine, the guest already
  // has something.
  WAITLIST_ALREADY_QUEUED: HttpStatus.CONFLICT,
  WAITLIST_ALREADY_TERMINAL: HttpStatus.CONFLICT,
  // The move does not exist from here, or this actor may not make it. Two codes
  // so the board can say "that is not a move" versus "the host does that".
  WAITLIST_NOT_PERMITTED: HttpStatus.CONFLICT,
  WAITLIST_ACTOR_NOT_PERMITTED: HttpStatus.CONFLICT,

  // ---- 店內點餐 refusals --------------------------------------------------
  // A stale or switched-off QR. 404 rather than 403: a 403 on a guessed code
  // confirms the table exists.
  DINING_TABLE_NOT_FOUND: HttpStatus.NOT_FOUND,
  DINING_TABLE_INACTIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  // A shop typing a table code it already uses. 409: the request was fine, the
  // floor plan already has that table — and without this the unique-constraint
  // violation escaped as a 500, telling the shop the server broke over their
  // own typo.
  DINING_TABLE_CODE_TAKEN: HttpStatus.CONFLICT,
  // Two open sittings on one table is silent data corruption, so it is refused
  // loudly. 409: the request is well-formed, the table is just busy.
  DINING_SESSION_CONFLICT: HttpStatus.CONFLICT,
  DINING_SESSION_NOT_FOUND: HttpStatus.NOT_FOUND,
  // The bill is settled; a new order would be a tab nobody is going to pay.
  DINING_SESSION_CLOSED: HttpStatus.UNPROCESSABLE_ENTITY,

  // The bytes arrived and the content type was one we accept — the *content* is
  // what cannot be used. 422 rather than 400, and the message carries sharp's
  // own diagnosis so "upload failed" becomes "the file is truncated".
  IMAGE_PROCESSING_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  // The rail name was valid and the payload was fine — this deployment simply
  // holds no credentials for that rail. Not a 400, because no edit to the body
  // can fix it, and not a 503, because the service is healthy.
  PAYMENT_RAIL_UNAVAILABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  // A rail that is not in the registry at all. The DTO's `@IsIn` rejects this
  // over HTTP, so this mapping only covers internal callers — but a code with
  // no mapping silently becomes a 500, and that is the bug this table exists
  // to prevent.
  UNKNOWN_PAYMENT_PROVIDER: HttpStatus.BAD_REQUEST,

  NO_RIDER_AVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  // The deployment is healthy and the request is fine — the object store is the
  // missing dependency. Retrying after an operator fixes it is the instruction.
  STORAGE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  // An acquirer callback that cannot be verified. 401 rather than 500: a bare
  // `Error` here used to become INTERNAL_ERROR, which tells a webhook sender
  // "our fault, retry" — so a forged payload was retried on a backoff forever
  // and the operator got an alert about a server bug instead of a rejection.
  INVALID_WEBHOOK_SIGNATURE: HttpStatus.UNAUTHORIZED,
  // Genuine payload, no secret to check it with. Retrying is the right
  // instruction — the same delivery verifies once the secret is restored.
  WEBHOOK_NOT_CONFIGURED: HttpStatus.SERVICE_UNAVAILABLE,
  // An upstream dependency refused. 502 tells the client to retry or switch
  // rail — it is explicitly not something the caller can fix by editing a field.
  PAYMENT_INTENT_FAILED: HttpStatus.BAD_GATEWAY,
  FULFILMENT_MODE_NOT_IMPLEMENTED: HttpStatus.NOT_IMPLEMENTED,
};

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string | undefined) ?? undefined;

    const { status, body } = this.toResponse(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${body.error.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(body);
  }

  private toResponse(exception: unknown, requestId?: string): { status: number; body: ErrorBody } {
    if (exception instanceof DomainError) {
      return {
        status: DOMAIN_CODE_TO_STATUS[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details,
            requestId,
          },
        },
      };
    }

    // A rejected report window is a client mistake, and the error carries the
    // reason the page must show ("查詢範圍不可超過 366 日"). It is not a
    // `DomainError` — it lives beside the analytics service rather than in the
    // shared hierarchy — so it needs its own branch. Without one the operator
    // gets a 500 and "An unexpected error occurred" for a date they typed.
    if (exception instanceof InvalidAnalyticsWindowError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: {
            code: 'ANALYTICS_INVALID_WINDOW',
            message: exception.message,
            details: { from: exception.from, to: exception.to },
            requestId,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        body: {
          error: {
            code: this.httpStatusToCode(status),
            message: Array.isArray(message) ? message.join('; ') : message,
            details: typeof payload === 'object' ? { validation: payload } : undefined,
            requestId,
          },
        },
      };
    }

    // A rejected report window is a client mistake, and the error carries the
    // reason the page must show ("查詢範圍不可超過 366 日"). It is not a
    // `DomainError` — it lives beside the analytics service rather than in the
    // shared hierarchy — so it needs its own branch. Without one the operator
    // gets a 500 and "An unexpected error occurred" for a date they typed.
    if (exception instanceof InvalidAnalyticsWindowError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: {
            code: 'ANALYTICS_INVALID_WINDOW',
            message: exception.message,
            details: { from: exception.from, to: exception.to },
            requestId,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          // Never leak an internal message to the client.
          message: 'An unexpected error occurred',
          requestId,
        },
      },
    };
  }

  private httpStatusToCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_ERROR';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHENTICATED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
