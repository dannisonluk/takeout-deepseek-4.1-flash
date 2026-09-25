import { Controller, Get, Headers, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * The Prometheus exposition content type, spelled exactly.
 *
 * It cannot be set with `@Header()`: Nest serialises a `string` return value
 * through `res.send()`, and Express rewrites any content type it sends to put
 * `charset` first — turning this into `text/plain; charset=utf-8; version=0.0.4`.
 * Scrapers tolerate the reordering, but the version parameter is part of the
 * format's contract, so the response is written directly instead.
 */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * `GET /metrics` — Prometheus scrape target.
 *
 * Excluded from the `/v1` global prefix in `main.ts`, like `/health`: scrapers
 * and orchestrators address these paths directly and a versioned metrics URL is
 * a versioned contract nobody wants.
 *
 * Guarded rather than open. The exposition includes gross captured revenue and
 * the refund backlog; an unauthenticated `/metrics` on a public host is a
 * business-information leak. See `MetricsService.isAuthorised` for the rule.
 *
 * `@Res()` is used without `passthrough` on purpose — see
 * `PROMETHEUS_CONTENT_TYPE`. The handler writes the response itself, so the
 * authorisation check must throw *before* anything is written; an
 * `UnauthorizedException` raised first is still mapped by the global filter.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.metrics.isAuthorised(authorization)) {
      // Deliberately vague: the caller learns nothing about whether a token is
      // configured, only that theirs was not accepted.
      throw new UnauthorizedException('Metrics are not available to this caller');
    }
    const body = await this.metrics.render();
    response.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE);
    response.setHeader('Cache-Control', 'no-store');
    response.end(body);
  }
}
