import { DomainError } from '@takeout/domain';

export class MerchantSlugTakenError extends DomainError {
  constructor(slug: string) {
    super('MERCHANT_SLUG_TAKEN', `網址代稱「${slug}」已被使用`, { slug });
  }
}

export class MerchantNotEditableError extends DomainError {
  constructor(status: string, reason: string) {
    super('MERCHANT_NOT_EDITABLE', `商戶目前狀態為 ${status}，${reason}`, { status });
  }
}

export class OperatingHoursInvalidError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('OPERATING_HOURS_INVALID', message, details);
  }
}

/**
 * A rest day was planned for a date that has already happened.
 *
 * Refused rather than ignored: back-dating a closure would flip a day the shop
 * actually traded into a closed day, which changes what the reporting screen
 * says about that day and cannot un-cancel the bookings it would sweep.
 */
export class ClosureDateInPastError extends DomainError {
  constructor(serviceDate: string, today: string) {
    super('CLOSURE_DATE_IN_PAST', `不能設定過去的日期（${serviceDate}）為休息日`, {
      serviceDate,
      today,
    });
  }
}

export class ClosureNotFoundError extends DomainError {
  constructor(serviceDate: string) {
    super('CLOSURE_NOT_FOUND', `找不到 ${serviceDate} 的休息日設定`, { serviceDate });
  }
}

/**
 * The path's `serviceDate` is not a real `YYYY-MM-DD` date.
 *
 * Its own code rather than reusing a validation-ish one: the date arrives as a
 * path parameter, so a body validator never sees it, and without this the
 * caller's typo reaches Prisma as an `Invalid Date` and surfaces as a 500.
 */
export class InvalidClosureDateError extends DomainError {
  constructor(serviceDate: string, message: string) {
    super('CLOSURE_DATE_INVALID', message, { serviceDate });
  }
}

export class MenuCategoryNotFoundError extends DomainError {
  constructor(categoryId: string) {
    super('CATEGORY_NOT_FOUND', '找不到此菜單分類', { categoryId });
  }
}

export class MenuCategoryInUseError extends DomainError {
  constructor(categoryId: string, itemCount: number) {
    super('CATEGORY_IN_USE', `此分類仍有 ${itemCount} 個菜式，請先移動或刪除`, {
      categoryId,
      itemCount,
    });
  }
}

export class DuplicateCategoryNameError extends DomainError {
  constructor(name: string) {
    super('CATEGORY_NAME_TAKEN', `分類「${name}」已存在`, { name });
  }
}

export class MenuItemNotFoundError extends DomainError {
  constructor(menuItemId: string) {
    super('MENU_ITEM_NOT_FOUND', '找不到此菜式', { menuItemId });
  }
}

/** A `categoryId` was supplied that belongs to a different merchant. */
export class MenuCategoryMismatchError extends DomainError {
  constructor(categoryId: string) {
    super('CATEGORY_MISMATCH', '指定的分類不屬於此商戶', { categoryId });
  }
}

/**
 * The requested lifecycle action is not legal from the current status.
 *
 * Lives in the merchant context, not the admin one: the lifecycle is the
 * merchant's own state machine, and the admin console is merely one caller of
 * it. Putting it here also avoids a `merchants -> admin` import, which would
 * point the dependency the wrong way.
 */
export class MerchantStatusTransitionError extends DomainError {
  constructor(action: string, from: string, allowed: readonly string[]) {
    super(
      'MERCHANT_STATUS_TRANSITION',
      `商戶目前狀態為 ${from}，不可執行 ${action}${
        allowed.length > 0 ? `（可執行：${allowed.join('、')}）` : '（此狀態已為終態）'
      }`,
      { action, from, allowed },
    );
  }
}
