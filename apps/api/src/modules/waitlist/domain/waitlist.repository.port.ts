import { Prisma } from '@prisma/client';
import { WaitlistPolicy, WaitlistStatus } from '@takeout/domain';

/**
 * Persistence port for the walk-in queue.
 *
 * Same contract as the reservation port: every mutating method takes the
 * caller's `Prisma.TransactionClient`, so the use case owns the transactional
 * boundary and the repository cannot open one of its own.
 *
 * The shape is deliberately NARROWER than the reservation port, and where it is
 * narrower is the point:
 *
 *   - **No `holdSlots` / `releaseSlots`.** A queue ticket never held capacity.
 *     A reservation books a table for a turn; a walk-in takes a number and
 *     waits for one to be free. There is no counter to move, so there is no
 *     method — and the absence is what stops somebody later "fixing" the
 *     queue by giving it a seat counter it never needed.
 *   - **No `findOccupancy`.** The queue does not need to know the floor plan.
 *     The estimate comes from how many parties are ahead, not from tables.
 */

/** The merchant, as the queue needs to see it. */
export interface QueueMerchant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  /** `MerchantStatus` — only `ACTIVE` merchants may hand out tickets. */
  readonly status: string;
}

/** A merchant's queue settings, resolved through settings -> defaults. */
export interface ResolvedWaitlistSettings {
  readonly policy: WaitlistPolicy;
  /**
   * Whether the shop is open right now, in its own timezone.
   *
   * Carried in the resolved settings rather than recomputed by the caller,
   * because the one place that already knows how to evaluate operating hours —
   * including the 特別休息日 override — is the reservation context's
   * availability machinery, and a second implementation here would disagree
   * with the booking page the first time the shop closed a day.
   */
  readonly openNow: boolean;
}

/** A queue ticket as it is persisted. */
export interface PersistedWaitlistEntry {
  readonly id: string;
  readonly merchantId: string;
  readonly ticketNo: string;
  readonly serviceDate: Date;
  readonly status: WaitlistStatus;
  readonly partySize: number;
  readonly guestName: string;
  readonly contactPhone: string;
  readonly note: string | null;
  readonly joinedAt: Date;
  readonly quotedMinutes: number | null;
  readonly calledAt: Date | null;
  readonly seatedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly statusReason: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateWaitlistEntryData {
  readonly merchantId: string;
  readonly ticketNo: string;
  readonly serviceDate: Date;
  readonly partySize: number;
  readonly guestName: string;
  readonly contactPhone: string;
  readonly note: string | null;
  /** The estimate shown to the guest at join time, snapshotted. */
  readonly quotedMinutes: number | null;
}

/** Fields a transition writes alongside the new status. */
export interface WaitlistStatusPatch {
  readonly calledAt?: Date;
  readonly seatedAt?: Date;
  readonly completedAt?: Date;
  readonly cancelledAt?: Date;
  readonly statusReason?: string | null;
}

export interface WaitlistRepositoryPort {
  /** `null` unless the merchant exists AND is ACTIVE. */
  findQueueMerchant(merchantId: string): Promise<QueueMerchant | null>;
  findQueueMerchantBySlug(slug: string): Promise<QueueMerchant | null>;

  /**
   * The shop's queue settings, with defaults filled in.
   *
   * Never returns `null`: a merchant who has never opened the settings screen
   * still gets a working — but disabled — queue, rather than a `null` every
   * caller has to invent a policy for.
   *
   * `now` is injectable so the "is the shop open" half can be tested at a
   * chosen instant, which is the only way to assert the closed-shop refusal
   * without the test depending on when it runs.
   */
  findSettings(merchantId: string, now?: Date): Promise<ResolvedWaitlistSettings>;

  /** Every ticket issued this trading day, newest last. Drives the board. */
  listForDay(
    merchantId: string,
    serviceDate: Date,
    statuses?: readonly WaitlistStatus[],
  ): Promise<readonly PersistedWaitlistEntry[]>;

  /** The live queue only — what a guest's position is computed against. */
  listActive(merchantId: string, serviceDate: Date): Promise<readonly PersistedWaitlistEntry[]>;

  findById(entryId: string): Promise<PersistedWaitlistEntry | null>;

  /** Locking read for the transition path. */
  findByIdForUpdate(
    tx: Prisma.TransactionClient,
    entryId: string,
  ): Promise<PersistedWaitlistEntry | null>;

  /** A guest's own live ticket, if they already hold one. */
  findActiveForPhone(
    merchantId: string,
    phone: string,
    serviceDate: Date,
  ): Promise<PersistedWaitlistEntry | null>;

  /** Every ticket number issued today, for `nextTicketNo`. */
  ticketNumbersForDay(merchantId: string, serviceDate: Date): Promise<readonly string[]>;

  /**
   * A guest may hold only one live ticket per shop per day.
   *
   * Keyed on the PHONE, not on an account: the take-a-number page is used by
   * people who have just walked in off the street, and requiring a login before
   * they can queue would be absurd. The phone is the one identifier they
   * actually give, and it is what the host would use to call them anyway.
   */
  insertEntry(
    tx: Prisma.TransactionClient,
    data: CreateWaitlistEntryData,
  ): Promise<PersistedWaitlistEntry>;

  /**
   * Optimistic status change: `WHERE id = ? AND status = ?`.
   * Returns `false` when another writer got there first.
   *
   * Also bumps `version`, which is the outbox event version — the same
   * discipline as the reservation repository, and for the same reason: the
   * outbox row and the status change must be one write or the customer's
   * tracker and the board disagree.
   */
  updateStatus(
    tx: Prisma.TransactionClient,
    entryId: string,
    expectedStatus: WaitlistStatus,
    nextStatus: WaitlistStatus,
    patch: WaitlistStatusPatch,
  ): Promise<boolean>;

  /** Upsert the shop's queue settings. Returns the stored policy. */
  saveSettings(
    merchantId: string,
    settings: Partial<PersistedWaitlistSettingsInput> & { updatedById?: string },
  ): Promise<ResolvedWaitlistSettings>;

  /**
   * Tickets that were called and never appeared, past their deadline.
   *
   * The one bulk read that is not scoped to a day: a sweep that runs at 09:00
   * must find a table called at 23:40 the previous night, which a
   * `serviceDate = today` filter would miss.
   */
  findTimedOutCalls(
    merchantId: string,
    now: Date,
    timeoutMinutes: number,
    limit: number,
  ): Promise<readonly PersistedWaitlistEntry[]>;
}

export interface PersistedWaitlistSettingsInput {
  enabled: boolean;
  acceptWhenClosed: boolean;
  minPartySize: number;
  maxPartySize: number;
  averageTurnMinutes: number;
  callTimeoutMinutes: number;
  customerNotice: string | null;
}
