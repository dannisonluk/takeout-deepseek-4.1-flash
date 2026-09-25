import { Inject, Injectable, Logger } from '@nestjs/common';
import { IdGenerator, normalizeTableCode } from '@takeout/domain';
import { Actor } from '../../../common/auth/actor';
import { ID_GENERATOR, DINING_REPOSITORY } from '../../../common/tokens';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { DiningRepositoryPort } from '../domain/dining.repository.port';
import { DiningTableIdNotFoundError } from '../domain/dining.errors';
import { CreateDiningTableDto, UpdateDiningTableDto } from '../interface/dto/dining.dto';
import { DiningTableView } from '../interface/dining.views';
import { DiningQueryService } from './dining-query.service';

/**
 * The floor plan: creating, editing and QR rotation.
 *
 * The rules that live here rather than in the DTO:
 *
 *   1. **The code is normalised before it is stored.** `a-12` and `A 12` are the
 *      same table, and `@@unique([merchantId, code])` only enforces that if the
 *      value reaching the database is already normalised — otherwise a shop
 *      ends up with three tables for one physical one.
 *   2. **A rotation gets a fresh random token**, never a derived one. The point
 *      of rotating is that the old code stops working; a token derived from the
 *      table id would keep working.
 *   3. **A new table gets a token at creation**, so a printed label is possible
 *      immediately rather than after a second step.
 */
@Injectable()
export class ManageTablesUseCase {
  private readonly logger = new Logger(ManageTablesUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(DINING_REPOSITORY) private readonly dining: DiningRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly query: DiningQueryService,
  ) {}

  async create(
    merchantId: string,
    dto: CreateDiningTableDto,
    actor: Actor,
  ): Promise<DiningTableView> {
    const code = normalizeTableCode(dto.code);
    const safe = {
      merchantId,
      code,
      label: dto.label ?? null,
      seats: dto.seats ?? 4,
      isActive: dto.isActive ?? true,
      qrToken: this.freshToken(),
    };

    const table = await this.prisma.runInTransaction((tx) => this.dining.createTable(tx, safe));

    await this.audit.record({
      actorId: actor.userId,
      actorRole: actor.role,
      action: 'merchant.dining_table_create',
      targetType: 'DiningTable',
      targetId: table.id,
      before: null,
      after: { code: table.code, seats: table.seats, isActive: table.isActive },
      ip: actor.ip ?? null,
    });

    this.logger.log(`Table ${table.code} created for ${merchantId}`);
    return this.view(table);
  }

  /**
   * Edit a table.
   *
   * `rotateQr` is a boolean rather than a client-supplied token: a shop asks for
   * "a new code", it does not choose one, and accepting one would let a caller
   * set a token another shop already printed.
   */
  async update(
    merchantId: string,
    tableId: string,
    dto: UpdateDiningTableDto,
    actor: Actor,
  ): Promise<DiningTableView> {
    const before = await this.dining.findTable(merchantId, tableId);
    if (!before) throw new DiningTableIdNotFoundError(tableId);

    const updated = await this.dining.updateTable(merchantId, tableId, {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.seats !== undefined ? { seats: dto.seats } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.rotateQr ? { qrToken: this.freshToken() } : {}),
    });
    if (!updated) throw new DiningTableIdNotFoundError(tableId);

    await this.audit.record({
      actorId: actor.userId,
      actorRole: actor.role,
      action: 'merchant.dining_table_update',
      targetType: 'DiningTable',
      targetId: tableId,
      before: {
        label: before.label,
        seats: before.seats,
        isActive: before.isActive,
      },
      after: {
        label: updated.label,
        seats: updated.seats,
        isActive: updated.isActive,
        // The token itself is never audited — writing it into the log would
        // publish the very secret rotation exists to withdraw.
        rotated: Boolean(dto.rotateQr),
      },
      ip: actor.ip ?? null,
    });

    return this.view(updated);
  }

  /**
   * A fresh, opaque QR token.
   *
   * Prefixed so a leaked token is recognisable in a log, and long enough that
   * guessing one is not a threat — it is a bearer credential that opens a table.
   */
  private freshToken(): string {
    const id = this.idGenerator.next().toLowerCase();
    return `dt${id}`;
  }

  /**
   * One table as the floor plan renders it.
   *
   * A freshly created or edited table has no open sitting by construction — a
   * table with a live sitting is one the shop is mid-service on, and neither
   * creation nor an edit opens one. Reporting `null` rather than re-reading is
   * therefore accurate, and saves a query on the one path a shop hits in bulk
   * when it sets up its floor plan. The board re-read is what shows sittings.
   */
  private view(table: {
    id: string;
    code: string;
    label: string | null;
    seats: number;
    isActive: boolean;
    qrToken: string;
  }): DiningTableView {
    return {
      id: table.id,
      code: table.code,
      label: table.label,
      seats: table.seats,
      isActive: table.isActive,
      qrToken: table.qrToken,
      qrUrl: this.query.qrUrl(table.qrToken),
      session: null,
    };
  }
}
