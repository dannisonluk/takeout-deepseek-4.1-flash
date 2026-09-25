import { OrderStatus, PaymentMode } from '@takeout/domain';

/**
 * The one sentence a customer needs to read next to their order.
 *
 * Built on the server rather than in each client for the reason every other
 * shared rule in this codebase is: the message is derived from facts the
 * client would have to re-derive (the merchant's pickup window applied to the
 * *promised* time, the payment mode, the payment deadline) and two
 * implementations of "when must I collect this" is exactly how the web app and
 * a future mobile app end up telling the same customer different things.
 *
 * Pure: no clock read, no I/O. `now` is passed in so the wording is
 * deterministic under test.
 */

export type NoticeTone = 'info' | 'ok' | 'warn' | 'danger';

export interface PickupNotice {
  readonly tone: NoticeTone;
  readonly title: string;
  /** Safe to render verbatim. */
  readonly message: string;
}

export interface PickupNoticeInput {
  readonly status: OrderStatus;
  readonly paymentMode: PaymentMode;
  readonly scheduledPickupAt: Date | null;
  /** The merchant's promise. `null` until they confirm. */
  readonly estimatedReadyAt: Date | null;
  readonly readyAt: Date | null;
  readonly acceptDeadlineAt: Date | null;
  readonly pickupWindowMinutes: number;
  readonly pickupCode: string | null;
  readonly totalMinor: number;
  readonly currency: string;
  readonly timeZone: string;
  readonly now: Date;
}

const MINUTE_MS = 60_000;

export function buildPickupNotice(input: PickupNoticeInput): PickupNotice | null {
  const { status, paymentMode } = input;

  if (status === OrderStatus.PENDING_PAYMENT) {
    if (paymentMode === PaymentMode.PAY_AT_STORE) {
      const confirmBy = input.acceptDeadlineAt
        ? `店家會於 ${formatTime(input.acceptDeadlineAt, input.timeZone)} 前確認並提供預計取餐時間，`
        : '店家確認後會提供預計取餐時間，';
      return {
        tone: 'info',
        title: '已送出，等待店家確認收款',
        // The deadline here is the *shop's* confirmation window, not something
        // the customer has to act on — telling them to "complete before 18:42"
        // when they are paying at the counter would send them chasing a
        // payment step that does not exist.
        message:
          `訂單已送到店家，取餐時以現金／轉數快付款 ${formatMoney(input)}。` +
          confirmBy +
          '逾時未確認的訂單會自動取消，屆時你可以重新下單。',
      };
    }
    return {
      tone: 'warn',
      title: '尚未付款',
      message:
        `請完成付款 ${formatMoney(input)}。` +
        deadlineSentence(input.acceptDeadlineAt, input.timeZone) +
        '逾時未付款的訂單會自動取消並釋放名額。',
    };
  }

  if (status === OrderStatus.PAID) {
    return {
      tone: 'info',
      title: paymentMode === PaymentMode.PAY_AT_STORE ? '店家正在確認收款' : '店家正在確認訂單',
      message: '店家確認後會提供預計取餐時間，請留意此頁面更新。',
    };
  }

  if (status === OrderStatus.ACCEPTED || status === OrderStatus.PREPARING) {
    const promised = input.estimatedReadyAt;
    if (!promised) {
      return {
        tone: 'info',
        title: '店家已接單',
        message: '餐點正在準備中，店家稍後會提供預計取餐時間。',
      };
    }

    const holdUntil = new Date(promised.getTime() + input.pickupWindowMinutes * MINUTE_MS);
    const requested = input.scheduledPickupAt;
    // When the kitchen promises a time *later* than the one the customer asked
    // for, saying so plainly is the whole point of the feature. Hiding it
    // behind a single "預計取餐時間" makes the customer arrive to cold food and
    // blame the platform.
    const laterThanRequested =
      requested !== null && promised.getTime() - requested.getTime() > 5 * MINUTE_MS;

    return {
      tone: 'ok',
      title: `預計取餐時間 ${formatTime(promised, input.timeZone)}`,
      message:
        (laterThanRequested
          ? `你原本預約 ${formatTime(requested, input.timeZone)}，店家因現場情況調整為 ${formatTime(promised, input.timeZone)}。`
          : '餐點會在這個時間準備好。') +
        `請於 ${formatTime(holdUntil, input.timeZone)} 前到店取餐，逾時餐點可能不再保留。`,
    };
  }

  if (status === OrderStatus.READY_FOR_PICKUP) {
    const readyAt = input.readyAt ?? input.now;
    const holdUntil = new Date(readyAt.getTime() + input.pickupWindowMinutes * MINUTE_MS);
    return {
      tone: 'ok',
      title: '餐點已完成，可以取餐',
      message:
        (input.pickupCode ? `取餐碼 ${input.pickupCode}。` : '') +
        (input.paymentMode === PaymentMode.PAY_AT_STORE
          ? `請到店出示取餐碼並付款 ${formatMoney(input)}。`
          : '請到店出示取餐碼。') +
        `店家會保留至 ${formatTime(holdUntil, input.timeZone)}。`,
    };
  }

  if (status === OrderStatus.COMPLETED) {
    return {
      tone: 'info',
      title: '已完成取餐',
      message: '感謝使用。你的評價會幫助其他顧客選擇。',
    };
  }

  if (status === OrderStatus.REJECTED) {
    return {
      tone: 'danger',
      title: '店家無法接單',
      message:
        paymentMode === PaymentMode.PAY_AT_STORE
          ? '很抱歉，店家未能接單。你無需付款，可以選擇其他餐廳。'
          : '很抱歉，店家未能接單。款項會全額退回你的付款方式。',
    };
  }

  if (status === OrderStatus.EXPIRED) {
    return {
      tone: 'warn',
      title: '訂單已逾時',
      message:
        paymentMode === PaymentMode.PAY_AT_STORE
          ? '店家未能在時限內確認訂單，訂單已自動取消。'
          : '訂單未在時限內完成，已自動取消。如有扣款會全額退回。',
    };
  }

  if (status === OrderStatus.CANCELLED) {
    return { tone: 'neutral' as NoticeTone, title: '訂單已取消', message: '此訂單已經取消。' };
  }

  if (status === OrderStatus.REFUNDED) {
    return {
      tone: 'info',
      title: '已退款',
      message: '款項已退回你的付款方式，實際入帳時間視乎發卡機構而定。',
    };
  }

  return null;
}

/** "請於 18:42 前完成付款，" — or nothing when there is no deadline. */
function deadlineSentence(deadline: Date | null, timeZone: string): string {
  if (!deadline) return '';
  return `請於 ${formatTime(deadline, timeZone)} 前完成。`;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatTime(at: Date, timeZone: string): string {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter.format(at);
}

/** `HK$58.00` — the same shape the web client renders, so the two never differ. */
function formatMoney(input: Pick<PickupNoticeInput, 'totalMinor' | 'currency'>): string {
  const symbol = input.currency === 'HKD' ? 'HK$' : `${input.currency} `;
  return `${symbol}${(input.totalMinor / 100).toFixed(2)}`;
}
