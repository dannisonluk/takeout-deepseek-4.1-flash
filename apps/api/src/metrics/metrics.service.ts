import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/**
 * Prometheus exposition.
 *
 * Hand-rolled rather than pulling in `prom-client`. The exposition format is
 * four lines of syntax, this service needs eight metrics, and the project's
 * dependency list is deliberately short — a client library would be the largest
 * thing in `apps/api` by install size and would buy nothing here.
 *
 * **Two kinds of metric, and the difference matters operationally:**
 *
 *  - *Gauges read from the database* (`takeout_orders`, `takeout_outbox_events`,
 *    …) are correct across every API instance. The database is the shared state,
 *    so two pods scraping produce the same number.
 *  - *Counters held in process* are per-instance. With N replicas a scrape
 *    sees 1/N of the traffic. They are still useful — rate and shape are
 *    per-instance anyway — but a dashboard that sums them across instances
 *    without knowing that will under-report. Documented on `increment`.
 *
 * Anything that can be derived from the database is derived from the database.
 */
@Injectable()
export class MetricsService {
  private readonly startedAt = Date.now();
  /**
   * In-process counters, keyed by `name` plus a canonicalised label string.
   *
   * Per-instance by construction: a counter lives in one process's heap. Use it
   * for "how often does this code path run", not for "how many orders exist" —
   * that belongs in a database gauge.
   */
  private readonly counters = new Map<string, number>();
  private readonly counterHelp = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Increment an in-process counter. `help` is recorded once, on first use, so
   * a metric cannot appear in the exposition without a description.
   */
  increment(name: string, labels: Record<string, string> = {}, help = ''): void {
    if (help && !this.counterHelp.has(name)) this.counterHelp.set(name, help);
    const key = `${name}${labelString(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /**
   * Whether this caller may read the exposition.
   *
   * The numbers here include revenue and refund backlog, so an open `/metrics`
   * is an information leak. When `METRICS_TOKEN` is set the caller must present
   * it as a bearer token; when it is not set the endpoint is only served
   * outside production, so a laptop works and a deployment does not silently
   * expose itself.
   */
  isAuthorised(header: string | undefined): boolean {
    if (this.config.metrics.token) {
      const presented = header?.replace(/^Bearer\s+/i, '');
      return presented === this.config.metrics.token;
    }
    return this.config.nodeEnv !== 'production';
  }

  /** Render the current state in Prometheus text exposition format (v0.0.4). */
  async render(): Promise<string> {
    const lines: string[] = [];

    const [orders, outbox, merchants, payments, refunds, stock] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.merchant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.payment.aggregate({
        where: { status: 'CAPTURED' },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.prisma.refund.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.menuItemDailyStock.count(),
    ]);

    gauge(
      lines,
      'takeout_orders',
      'Orders by status. Sampled from the database, so it is correct across replicas.',
      orders.map((row) => ({ labels: { status: row.status }, value: row._count._all })),
    );

    gauge(
      lines,
      'takeout_outbox_events',
      'Outbox events by status. A rising PENDING count means the relay is not draining.',
      outbox.map((row) => ({ labels: { status: row.status }, value: row._count._all })),
    );

    gauge(
      lines,
      'takeout_merchants',
      'Merchants by lifecycle status.',
      merchants.map((row) => ({ labels: { status: row.status }, value: row._count._all })),
    );

    gauge(
      lines,
      'takeout_refunds',
      'Refunds by status. PENDING includes every refund deferred by PAYMENT_LIVE_MODE=false.',
      refunds.map((row) => ({ labels: { status: row.status }, value: row._count._all })),
    );

    gauge(lines, 'takeout_payments_captured_count', 'Captured payments.', [
      { labels: {}, value: payments._count._all },
    ]);
    gauge(
      lines,
      'takeout_payments_captured_minor',
      'Gross captured amount in minor units. Never a float — see the Money rules.',
      [{ labels: {}, value: payments._sum.amountMinor ?? 0 }],
    );
    gauge(
      lines,
      'takeout_daily_stock_rows',
      'Rows in menu_item_daily_stock. Grows by items x merchants per day; pruned by the sweeper.',
      [{ labels: {}, value: stock }],
    );

    // ---- process -------------------------------------------------------------
    gauge(lines, 'takeout_process_uptime_seconds', 'Process uptime.', [
      { labels: {}, value: Math.round((Date.now() - this.startedAt) / 1000) },
    ]);
    gauge(lines, 'takeout_process_resident_memory_bytes', 'Resident set size.', [
      { labels: {}, value: process.memoryUsage().rss },
    ]);
    gauge(lines, 'takeout_process_heap_used_bytes', 'V8 heap in use.', [
      { labels: {}, value: process.memoryUsage().heapUsed },
    ]);

    // ---- in-process counters -------------------------------------------------
    const byName = new Map<string, { labels: string; value: number }[]>();
    for (const [key, value] of this.counters) {
      const name = key.slice(0, key.indexOf('{') === -1 ? key.length : key.indexOf('{'));
      const labels = key.slice(name.length);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push({ labels, value });
    }
    for (const [name, samples] of byName) {
      lines.push(`# HELP ${name} ${this.counterHelp.get(name) || 'in-process counter (per replica)'}`);
      lines.push(`# TYPE ${name} counter`);
      for (const sample of samples) {
        lines.push(`${name}${sample.labels} ${sample.value}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }
}

interface Sample {
  readonly labels: Record<string, string>;
  readonly value: number;
}

function gauge(
  lines: string[],
  name: string,
  help: string,
  samples: readonly Sample[],
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  for (const sample of samples) {
    lines.push(`${name}${labelString(sample.labels)} ${sample.value}`);
  }
}

function labelString(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  const body = entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',');
  return `{${body}}`;
}

/**
 * Prometheus label values are quoted strings, so `\`, `"` and a literal newline
 * have to be escaped. A status string with a quote in it would otherwise
 * produce an exposition that a scraper rejects — taking every metric down, not
 * just the malformed line.
 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
