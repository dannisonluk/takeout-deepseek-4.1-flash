/**
 * Excel 匯出 — the raw-data export, built here so it is testable without HTTP.
 *
 * **CSV, not XLSX, and that is deliberate.** Excel opens a UTF-8 CSV natively;
 * producing a real XLSX would add a binary writer to `packages/domain`, which
 * is documented as having zero runtime dependencies. A CSV is also what a shop
 * actually wants: it imports into whatever accounting tool they already use.
 *
 * Three details are load-bearing for a spreadsheet that a Chinese-language shop
 * can actually open:
 *
 *   1. **A UTF-8 BOM.** Without it Excel on Windows reads the file in the
 *      system codepage and every Chinese item name becomes mojibake. This is
 *      the single most common complaint about exported CSVs and it is one byte.
 *   2. **CRLF line endings.** Excel's own parser expects them; a bare `\n` in a
 *      quoted field containing commas is handled correctly by some versions and
 *      not others.
 *   3. **Money as a decimal string, not minor units.** `350` is wrong by a
 *      factor of 100 to anyone reading it, and a shop will not read the header.
 *      The minor-units convention is internal.
 */

/** One row of the raw export — already flattened, one line per order. */
export interface ExportRow {
  readonly orderNo: string;
  readonly serviceDate: string;
  readonly createdAt: string;
  readonly status: string;
  readonly fulfilmentMode: string;
  readonly paymentMode: string;
  readonly itemCount: number;
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly merchantPayoutMinor: number;
  readonly customerNote: string | null;
}

export interface ExportColumn {
  readonly key: keyof ExportRow;
  readonly header: string;
  readonly money?: boolean;
  readonly text?: boolean;
}

/**
 * The column set, in the order a shopkeeper reads it: what it was, when, what
 * happened, then the money.
 */
export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: 'orderNo', header: '訂單編號', text: true },
  { key: 'serviceDate', header: '交易日期', text: true },
  { key: 'createdAt', header: '下單時間', text: true },
  { key: 'status', header: '狀態', text: true },
  { key: 'fulfilmentMode', header: '取餐方式', text: true },
  { key: 'paymentMode', header: '付款方式', text: true },
  { key: 'itemCount', header: '件數' },
  { key: 'subtotalMinor', header: '營業額', money: true },
  { key: 'platformFeeMinor', header: '平台費', money: true },
  { key: 'merchantPayoutMinor', header: '商戶入帳', money: true },
  { key: 'customerNote', header: '顧客備註', text: true },
];

/** Minor units → a plain decimal string. `350` → `"3.50"`, `5` → `"0.05"`. */
export function moneyToDecimalString(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${whole}.${String(cents).padStart(2, '0')}`;
}

/**
 * Escape one field for CSV.
 *
 * Leading `=`, `+`, `-` and `@` are prefixed with a single quote. This is the
 * CSV injection defence: a customer note of `=1+1` becomes a formula in Excel,
 * and `=cmd|...` in a spreadsheet someone opens can be far worse than a wrong
 * number. The apostrophe is Excel's own "treat as literal text" marker.
 */
export function escapeCsvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function cellFor(row: ExportRow, column: ExportColumn): string {
  const raw = row[column.key];
  if (raw === null || raw === undefined) return '';
  if (column.money) return moneyToDecimalString(raw as number);
  return String(raw);
}

/**
 * Build the CSV body, with BOM and CRLF.
 *
 * The BOM is prepended here rather than at the controller so the exact bytes
 * the customer receives are what the test asserts on.
 */
export function buildOrdersCsv(rows: readonly ExportRow[], withBom = true): string {
  const header = EXPORT_COLUMNS.map((column) => escapeCsvField(column.header)).join(',');
  const body = rows.map((row) =>
    EXPORT_COLUMNS.map((column) => escapeCsvField(cellFor(row, column))).join(','),
  );
  const text = [header, ...body].join('\r\n');
  // Trailing CRLF: Excel's importer is happier, and a file ending mid-line is
  // the kind of thing that becomes a phantom empty row.
  return `${withBom ? '\uFEFF' : ''}${text}\r\n`;
}

/**
 * A filename that survives every OS and every browser.
 *
 * No spaces (some clients percent-encode them inconsistently), no colons from
 * the time part, and ASCII-only so an old browser's download naming does not
 * mangle it. The merchant's own name is deliberately not included — it can
 * contain `/`, and the shop knows whose file it is.
 */
export function exportFilename(merchantSlug: string, from: string, to: string): string {
  const safeSlug = merchantSlug.replace(/[^a-zA-Z0-9-]/g, '-');
  const range = from === to ? from : `${from}_${to}`;
  return `${safeSlug}-orders-${range}.csv`;
}
