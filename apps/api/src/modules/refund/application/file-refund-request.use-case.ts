import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IdGenerator,
  RefundReasonCode,
  RefundRequestAlreadyOpenError,
  RefundRequestNotAllowedError,
  RefundRequestStatus,
  assertNoteSupplied,
  isOrderRefundRequestable,
  validateRequestedAmount,
} from '@takeout/domain';
import { ID_GENERATOR, REFUND_REPOSITORY } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { OrderNotOwnedByCustomerError } from '../domain/refund.errors';
import {
  PersistedRefundRequest,
  RefundRepositoryPort,
} from '../domain/refund.repository.port';

export interface FileRefundRequestCommand {
  readonly orderId: string;
  readonly customerId: string;
  readonly reasonCode: RefundReasonCode;
  readonly requestedAmountMinor?: number | null;
  readonly note?: string | null;
}

export interface RefundRequestCreatedResult {
  readonly refundRequest: PersistedRefundRequest;
}

/**
 * The customer files a ticket against one of their own orders.
 *
 * Five things are checked, in this order, and the order matters because each
 * answer drives a different UI:
 *
 *   1. the order exists AND is theirs → otherwise **404** (never 403, which
 *      would confirm the id exists);
 *   2. the order has been paid for → else `REFUND_REQUEST_NOT_ALLOWED`;
 *   3. `OTHER` carries a note → else `REFUND_NOTE_REQUIRED` (400), because an
 *      unanswerable ticket is worse than no ticket;
 *   4. the amount is a plausible ask → else `REFUND_AMOUNT_INVALID`;
 *   5. no ticket is already open on this order → else
 *      `REFUND_REQUEST_ALREADY_OPEN` (409).
 *
 * Steps 1–4 refuse before the transaction opens; step 5 is checked *inside* it,
 * because two simultaneous filings would both see "none open" from outside.
 *
 * **This use case cannot move money.** It writes one row and one outbox event.
 * There is no payment client injected and no payment port in scope — that
 * absence is the design, not an oversight (see the port's header).
 */
@Injectable()
export class FileRefundRequestUseCase {
  private readonly logger = new Logger(FileRefundRequestUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REFUND_REPOSITORY) private readonly refunds: RefundRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly outbox: OutboxService,
  ) {}

  async execute(command: FileRefundRequestCommand): Promise<RefundRequestCreatedResult> {
    const order = await this.refunds.findOrder(command.orderId);

    // Not found and not yours collapse into one answer on purpose: otherwise a
    // stranger can probe order ids and learn which ones exist.
    if (!order || order.customerId !== command.customerId) {
      throw new OrderNotOwnedByCustomerError(command.orderId);
    }

    if (!isOrderRefundRequestable(order.status)) {
      throw new RefundRequestNotAllowedError(order.id, order.status);
    }

    assertNoteSupplied(command.reasonCode, command.note);

    const requestedAmountMinor = validateRequestedAmount(
      command.requestedAmountMinor,
      order.totalMinor,
    );

    const now = new Date();

    const created = await this.prisma.runInTransaction(async (tx) => {
      const existing = await this.refunds.findOpenForOrder(tx, order.id);
      if (existing) {
        throw new RefundRequestAlreadyOpenError(order.id, existing.id);
      }

      const row = await this.refunds.insert(tx, {
        orderId: order.id,
        merchantId: order.merchantId,
        customerId: order.customerId,
        reasonCode: command.reasonCode,
        requestedAmountMinor,
        orderTotalMinor: order.totalMinor,
        customerNote: command.note?.trim() || null,
      });

      await this.outbox.enqueue(
        tx,
        this.outbox.buildRefundRequestEvent({
          idGenerator: this.idGenerator,
          refundRequest: row,
          occurredAt: now,
        }),
      );

      return row;
    });

    this.logger.log(
      `Refund request ${created.id} filed on order ${created.orderNo} (${created.reasonCode})`,
    );

    return { refundRequest: created };
  }
}
