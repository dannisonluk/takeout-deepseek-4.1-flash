import { Inject, Injectable } from '@nestjs/common';
import {
  RefundRequestActor,
  RefundRequestNotFoundError,
  RefundRequestStateMachine,
  RefundRequestStatus,
} from '@takeout/domain';
import { REFUND_REPOSITORY, REFUND_STATE_MACHINE } from '../../../common/tokens';
import {
  PersistedRefundRequest,
  RefundPage,
  RefundRepositoryPort,
} from '../domain/refund.repository.port';

/** A ticket plus the moves the asking actor may make — what every view renders. */
export interface RefundRequestProjection {
  readonly refundRequest: PersistedRefundRequest;
  readonly allowedNextTransitions: readonly RefundRequestStatus[];
}

/**
 * Read side of the refund queue.
 *
 * Deliberately small: the queue is a list of rows and a count per tab. Nothing
 * here aggregates money, because the platform has no money role in this flow and
 * a "total refunded" figure would imply it does.
 */
@Injectable()
export class RefundQueryService {
  constructor(
    @Inject(REFUND_REPOSITORY) private readonly refunds: RefundRepositoryPort,
    @Inject(REFUND_STATE_MACHINE) private readonly stateMachine: RefundRequestStateMachine,
  ) {}

  /** The shop's queue, projected for a merchant actor. */
  async listForMerchant(
    merchantId: string,
    params: {
      status?: RefundRequestStatus | 'ACTIVE' | 'ALL';
      limit: number;
      offset: number;
    },
  ): Promise<{
    page: RefundPage<RefundRequestProjection>;
    counts: Readonly<Record<RefundRequestStatus, number>>;
  }> {
    const [page, counts] = await Promise.all([
      this.refunds.listForMerchant({ merchantId, ...params }),
      this.refunds.countByStatusForMerchant(merchantId),
    ]);

    return {
      page: {
        data: page.data.map((row) => this.project(row, RefundRequestActor.MERCHANT)),
        total: page.total,
      },
      counts,
    };
  }

  /** The customer's own tickets, projected for a customer actor. */
  async listForCustomer(
    customerId: string,
    params: { limit: number; offset: number },
  ): Promise<RefundPage<RefundRequestProjection>> {
    const page = await this.refunds.listForCustomer({ customerId, ...params });
    return {
      data: page.data.map((row) => this.project(row, RefundRequestActor.CUSTOMER)),
      total: page.total,
    };
  }

  /** Platform-wide, read-only. Admins get the same actions a shop does. */
  async listAll(params: {
    status?: RefundRequestStatus | 'ACTIVE' | 'ALL';
    merchantId?: string;
    limit: number;
    offset: number;
  }): Promise<RefundPage<RefundRequestProjection>> {
    const page = await this.refunds.listAll(params);
    return {
      data: page.data.map((row) => this.project(row, RefundRequestActor.ADMIN)),
      total: page.total,
    };
  }

  /**
   * One ticket, as seen by a specific actor.
   *
   * The caller decides which actor to project for and is responsible for having
   * established that the actor may see the row at all — ownership is checked at
   * the controller, where the request's identity lives. Doing it here would mean
   * this service has to know about every caller's idea of "mine".
   */
  async findOneFor(
    refundRequestId: string,
    actor: RefundRequestActor,
  ): Promise<RefundRequestProjection> {
    const row = await this.refunds.findById(refundRequestId);
    if (!row) throw new RefundRequestNotFoundError(refundRequestId);
    return this.project(row, actor);
  }

  /** Every ticket on one order, newest first. Used by the order detail view. */
  async listForOrder(orderId: string): Promise<readonly PersistedRefundRequest[]> {
    return this.refunds.listForOrder(orderId);
  }

  /**
   * The moves a given actor may make on a given status.
   *
   * Exposed so a caller that has just *created* a row (and therefore has no
   * projection yet) can still get its button list from the machine rather than
   * hardcoding one. There is exactly one state machine and it is the authority;
   * a hardcoded `[CANCELLED]` in a controller is a second opinion that will
   * eventually disagree.
   */
  allowedFor(
    status: RefundRequestStatus,
    actor: RefundRequestActor,
  ): readonly RefundRequestStatus[] {
    return this.stateMachine.allowedTransitions(status, actor);
  }

  private project(
    refundRequest: PersistedRefundRequest,
    actor: RefundRequestActor,
  ): RefundRequestProjection {
    return {
      refundRequest,
      allowedNextTransitions: this.stateMachine.allowedTransitions(refundRequest.status, actor),
    };
  }
}
