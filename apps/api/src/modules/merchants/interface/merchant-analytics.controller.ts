import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { AnalyticsService } from '../application/analytics.service';
import { MerchantService } from '../application/merchant.service';
import { AnalyticsWindowDto } from './dto/merchant.dto';
import { MerchantAnalyticsView } from './merchant.views';

/**
 * 商戶營業報表 — the merchant's own numbers.
 *
 * WHY THE EXPORT IS NOT TIER-GATED
 * --------------------------------
 * `GET .../analytics` renders the computed BI panels and depends on the tier.
 * `GET .../orders/export.csv` does **not** read the tier at all — every shop,
 * including one on `NONE`, can pull its own rows out.
 *
 * That split is the commercial model the owner chose and it is worth restating
 * so nobody "tidies" it away later: the platform charges for *computation*
 * (trends, item rankings, comparisons), never for access to data the shop
 * generated. If the export is ever gated, the product becomes one that holds a
 * shop's own records hostage, and the shop has no reason to stay once they
 * realise.
 *
 * `MerchantScopeGuard` at class level is what makes `:merchantId` safe; an
 * owner who guesses another shop's id gets 403, an admin passes through.
 */
@Controller('merchant')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantAnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly merchants: MerchantService,
  ) {}

  /**
   * The report for a window.
   *
   * `from`/`to` default to the last 30 SHOP-LOCAL days, and the window is
   * resolved server-side so the "today" the page shows is the shop's today —
   * a +08 merchant opening the page at 17:30 UTC must not see yesterday's
   * revenue missing from a period ending "today".
   */
  @Get(':merchantId/analytics')
  async report(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query() query: AnalyticsWindowDto,
  ): Promise<MerchantAnalyticsView> {
    const context = await this.requireContext(merchantId);
    return this.analytics.report({
      merchantId,
      timezone: context.timezone,
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    });
  }

  /**
   * 匯出 Excel — the raw order rows, as a UTF-8 CSV.
   *
   * Written through `@Res()` rather than returning a string, because the two
   * headers that matter are not expressible in a plain JSON response:
   *
   *   - `Content-Type` with `charset=utf-8`, so the browser does not decode the
   *     BOM-prefixed body as Latin-1 and turn every Chinese item name into
   *     mojibake.
   *   - `Content-Disposition: attachment`, so clicking the button downloads
   *     rather than navigating to a wall of comma-separated text.
   *
   * The filename is built in the domain (`exportFilename`) and echoed into the
   * header, so the name in the download and the name in the audit log are the
   * same string.
   */
  @Get(':merchantId/orders/export.csv')
  @Header('Cache-Control', 'no-store')
  async export(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query() query: AnalyticsWindowDto,
    @Res() response: Response,
  ): Promise<void> {
    const context = await this.requireContext(merchantId);
    const result = await this.analytics.export({
      merchantId,
      merchantSlug: context.slug,
      timezone: context.timezone,
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    });

    response
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
      .setHeader('X-Row-Count', String(result.rowCount))
      .send(result.body);
  }

  /**
   * The two facts the report needs about the shop: its zone and its slug.
   *
   * A narrow read rather than `MerchantService.getOwned`, which projects forty
   * fields and a viewer-relative `isOwner` flag to answer a two-column
   * question.
   */
  private async requireContext(
    merchantId: string,
  ): Promise<{ timezone: string; slug: string }> {
    const context = await this.merchants.contextForAnalytics(merchantId);
    if (!context) throw new NotFoundException('Merchant not found');
    return context;
  }
}
