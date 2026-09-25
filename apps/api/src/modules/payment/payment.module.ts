import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import { OrderActor, OrderStatus } from '@takeout/domain';
import { Request } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ORDER_REPOSITORY } from '../../common/tokens';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  FpsQrPaymentProvider,
  OctopusPaymentProvider,
  PayMePaymentProvider,
} from '../../infrastructure/payment/hk-payment.providers';
import {
  IPaymentProvider,
  PaymentProviderName,
} from '../../infrastructure/payment/payment-provider.port';
import {
  PaymentProviderRegistry,
  PaymentRailView,
} from '../../infrastructure/payment/payment-provider.registry';
import { StripePaymentProvider } from '../../infrastructure/payment/stripe-payment.provider';
import { TransitionOrderUseCase } from '../ordering/application/transition-order.use-case';
import { OrderNotFoundError } from '../ordering/domain/ordering.errors';
import { OrderRepositoryPort } from '../ordering/domain/order.repository.port';
import { OrderingModule } from '../ordering/ordering.module';
import {
  CreatePaymentIntentUseCase,
  PaymentIntentView,
} from './application/create-payment-intent.use-case';
import { ConfirmOrderUseCase } from './application/confirm-order.use-case';
import { OrderRefundReactorService } from './application/order-refund-reactor.service';
import { RefundService } from './application/refund.service';
import {
  SimulatePaymentUseCase,
  SimulatedPaymentView,
} from './application/simulate-payment.use-case';
import { CreatePaymentIntentDto } from './interface/dto/create-payment-intent.dto';
import { MerchantOrderSettlementController } from './interface/merchant-order-settlement.controller';

export interface WebhookOutcome {
  readonly handled: boolean;
  readonly duplicate?: boolean;
  readonly reason?: string;
}

/**
 * Payment webhook handling.
 *
 * Idempotency is enforced at two levels:
 *  1. `payments.(provider, provider_ref)` is unique, and a payment already
 *     CAPTURED short-circuits — a replayed webhook does not re-transition.
 *  2. The order transition itself is a guarded `UPDATE ... WHERE status = X`,
 *     so even a race loses cleanly instead of double-advancing.
 *
 * The rail is taken from the **path**, not from the deployment default. A
 * PayMe callback carries a `payme_…` reference and an HMAC that only the PayMe
 * secret can verify; checking it against the Stripe provider would reject a
 * perfectly good settlement, and — worse — a Stripe-shaped forgery would be
 * checked against the wrong secret entirely.
 */
@Injectable()
export class HandlePaymentWebhookUseCase {
  private readonly logger = new Logger(HandlePaymentWebhookUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rails: PaymentProviderRegistry,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    private readonly transitionOrder: TransitionOrderUseCase,
  ) {}

  async execute(
    providerName: string,
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<WebhookOutcome> {
    const provider: IPaymentProvider | undefined = this.rails.find(providerName);
    if (!provider) {
      return { handled: false, reason: `unknown payment provider ${providerName}` };
    }

    // Throws on a bad signature — an unverified webhook is an open door to
    // marking any order as paid.
    const event = provider.verifyWebhook(rawBody, headers);

    if (event.type !== 'PAYMENT_CAPTURED') {
      return { handled: false, reason: `ignored event type ${event.type}` };
    }

    const payment = await this.prisma.payment.findFirst({
      where: { provider: provider.name as PaymentProvider, providerRef: event.providerRef },
      select: { id: true, orderId: true, status: true, amountMinor: true },
    });

    if (!payment) {
      return { handled: false, reason: 'unknown payment reference' };
    }

    if (payment.status === 'CAPTURED') {
      return { handled: true, duplicate: true };
    }

    // Amount tampering check: the PSP says what it took, we compare to our record.
    if (event.amountMinor !== payment.amountMinor) {
      this.logger.error(
        `Amount mismatch on payment ${payment.id}: provider=${event.amountMinor} expected=${payment.amountMinor}`,
      );
      return { handled: false, reason: 'amount mismatch' };
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'CAPTURED', capturedAt: new Date() },
    });

    // PENDING_PAYMENT -> PAID. The state machine's side effects (merchant
    // notification, accept deadline timer) are applied by the use case.
    await this.transitionOrder.execute({
      orderId: payment.orderId,
      to: OrderStatus.PAID,
      actor: OrderActor.SYSTEM,
      reason: `payment captured via ${provider.name}`,
    });

    const order = await this.orders.findById(payment.orderId);
    if (!order) throw new OrderNotFoundError(payment.orderId);

    return { handled: true };
  }
}

@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly handleWebhook: HandlePaymentWebhookUseCase) {}

  /**
   * Must receive the RAW body — signature verification fails on a re-serialised
   * JSON object. `NestFactory.create(AppModule, { rawBody: true })` makes
   * `req.rawBody` available.
   */
  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<Request>,
    @Body() _body: unknown,
  ): Promise<WebhookOutcome> {
    if (!request.rawBody) {
      throw new BadRequestException('Raw body is required for signature verification');
    }

    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key] = Array.isArray(value) ? value[0] : value;
    }

    return this.handleWebhook.execute(provider, request.rawBody, headers);
  }
}

/**
 * Which payment methods the checkout page may offer.
 *
 * Unauthenticated on purpose: the picker is rendered before the customer signs
 * in, and the answer — which rails this deployment supports — is exactly what
 * any checkout page shows. No secret is exposed: `configured` is a boolean, and
 * the credentials themselves never leave the server.
 */
@Controller('payments')
export class PaymentRailsController {
  constructor(private readonly rails: PaymentProviderRegistry) {}

  @Get('rails')
  list(): { defaultRail: PaymentProviderName; rails: PaymentRailView[] } {
    return { defaultRail: this.rails.defaultName, rails: this.rails.list() };
  }
}

/**
 * Opens the payment session for an order.
 *
 * It lives here rather than on `CustomerOrderController` because the dependency
 * only runs one way: `PaymentModule` imports `OrderingModule`, so putting this
 * controller in `OrderingModule` would close a cycle. The path stays under
 * `/orders` because that is the resource the customer is paying for.
 */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderPaymentController {
  constructor(
    private readonly createIntent: CreatePaymentIntentUseCase,
    private readonly simulate: SimulatePaymentUseCase,
  ) {}

  /**
   * `POST /orders/:orderId/simulate-payment` — development only.
   *
   * 404 rather than 403 when live mode is on: a 403 would confirm the route
   * exists, and there is no reason for a production deployment to advertise a
   * settle-without-paying endpoint at all.
   */
  @Post(':orderId/simulate-payment')
  @HttpCode(HttpStatus.OK)
  async simulatePayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<SimulatedPaymentView> {
    if (!this.simulate.enabled) throw new NotFoundException('Not found');

    const result = await this.simulate.execute({ orderId, customerId: user.userId });
    if (!result) throw new NotFoundException('Order not found');
    return result;
  }

  /**
   * `POST /orders/:orderId/payment-intent`
   *
   * Safe to call repeatedly: the same intent comes back until it is captured or
   * the order leaves PENDING_PAYMENT. 404 covers both "no such order" and "not
   * your order" on purpose — telling a caller which of the two it is would leak
   * the existence of other people's orders.
   *
   * `provider` picks the rail. Omit it for the deployment default; name one this
   * deployment has no credentials for and the answer is a 422 that says which
   * environment variables are missing, rather than a charge that can never be
   * settled.
   */
  @Post(':orderId/payment-intent')
  @HttpCode(HttpStatus.OK)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: CreatePaymentIntentDto,
  ): Promise<PaymentIntentView> {
    const intent = await this.createIntent.execute({
      orderId,
      customerId: user.userId,
      returnUrl: dto.returnUrl,
      provider: dto.provider,
    });
    if (!intent) throw new NotFoundException('Order not found');
    return intent;
  }
}

@Module({
  // `ORDER_REPOSITORY` and `TransitionOrderUseCase` both live in OrderingModule,
  // and this module injects both. Without this import Nest fails at boot with
  // "Nest can't resolve dependencies of the HandlePaymentWebhookUseCase" —
  // a runtime-only failure that `nest build` cannot see.
  imports: [OrderingModule],
  providers: [
    // Every rail is registered, configured or not. `PaymentProviderRegistry`
    // decides which are usable and reports the rest at boot — a deployment that
    // only has a Stripe key still lists PayMe in the picker as unavailable,
    // rather than omitting it and leaving the operator to wonder.
    StripePaymentProvider,
    PayMePaymentProvider,
    OctopusPaymentProvider,
    FpsQrPaymentProvider,
    PaymentProviderRegistry,
    HandlePaymentWebhookUseCase,
    CreatePaymentIntentUseCase,
    SimulatePaymentUseCase,
    // 確認訂單 — settles a counter payment and accepts the order in one call.
    // It is here, not in `OrderingModule`, because it writes a `payments` row
    // and the module dependency only runs one way.
    ConfirmOrderUseCase,
    // `RefundService` is the single place money is given back. It is exported
    // because `AdminOrdersService` (a manual refund) and
    // `OrderRefundReactorService` (the state machine's ISSUE_REFUND side
    // effect) must not each grow their own copy of the sequence.
    RefundService,
    OrderRefundReactorService,
  ],
  controllers: [
    PaymentWebhookController,
    PaymentRailsController,
    OrderPaymentController,
    MerchantOrderSettlementController,
  ],
  exports: [PaymentProviderRegistry, RefundService, OrderRefundReactorService],
})
export class PaymentModule {}
