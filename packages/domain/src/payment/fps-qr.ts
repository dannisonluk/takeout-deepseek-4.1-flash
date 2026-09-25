import { ValidationError } from '../shared/domain-error';

/**
 * EMVCo merchant-presented QR payloads — the format Hong Kong's 轉數快 (FPS)
 * uses for a static or dynamic payment QR.
 *
 * This is a *spec-shaped* builder, not a certified one. It emits the TLV
 * structure, the merchant account template FPS expects under tag 26, and a
 * correct CRC-16/CCITT-FALSE trailer, which is what makes the string scannable
 * by a banking app rather than a decorative square. What it does not do is
 * carry the FPS-specific optional tags a real acquirer may require — those are
 * bank-specific, and the honest place for them is a merchant configuration, not
 * a guess here.
 *
 * Kept in the domain because it is pure, it has one correct answer, and the
 * checksum is exactly the kind of thing that must be unit-tested rather than
 * eyeballed in a browser.
 */

/** Tag values used below, named so the builder reads as a document. */
const TAG_PAYLOAD_FORMAT = '00';
const TAG_POINT_OF_INITIATION = '01';
const TAG_MERCHANT_ACCOUNT_FPS = '26';
const TAG_MERCHANT_CATEGORY_CODE = '52';
const TAG_TRANSACTION_CURRENCY = '53';
const TAG_TRANSACTION_AMOUNT = '54';
const TAG_COUNTRY_CODE = '58';
const TAG_MERCHANT_NAME = '59';
const TAG_MERCHANT_CITY = '60';
const TAG_ADDITIONAL_DATA = '62';
const TAG_CRC = '63';

/** 2 = "dynamic", i.e. this QR carries an amount and a one-off reference. */
const POINT_OF_INITIATION_DYNAMIC = '12';

/** Hong Kong. ISO 3166-1 alpha-2, which is what the tag wants. */
const COUNTRY_HK = 'HK';

/** 5411 = grocery supermarkets; 5812 = eating places. Used for a food platform. */
const DEFAULT_MCC = '5812';

export interface FpsQrInput {
  /** The merchant's FPS identifier — a phone number, email, or FPS ID. */
  readonly fpsId: string;
  readonly merchantName: string;
  /** Optional. Defaults to Hong Kong. */
  readonly city?: string;
  /** Minor units. HK$58.00 => 5800. */
  readonly amountMinor: number;
  readonly currency: string;
  /** Our order reference, carried so a reconciliation can match the transfer. */
  readonly reference: string;
  /** 4-digit ISO 18245 category. Defaults to 5812 (eating places). */
  readonly merchantCategoryCode?: string;
}

/**
 * UTF-8 encode without `Buffer` or `TextEncoder`.
 *
 * This package has `"lib": ["ES2022"]` and `"types": []`, so neither is
 * declared — and adding a Node type dependency to the pure domain layer to
 * checksum a QR string would be a bad trade. The encoder is 20 lines and it is
 * the difference between a correct payload for a Chinese merchant name and a
 * CRC computed over the wrong bytes.
 *
 * Surrogate pairs are handled explicitly: iterating by code unit would encode
 * an emoji as two broken three-byte sequences.
 */
function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    let codePoint = input.charCodeAt(index);

    // High surrogate followed by a low surrogate — combine, then skip ahead.
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < input.length) {
      const low = input.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        index += 1;
      }
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  return bytes;
}

/**
 * Encode one TLV field: `id + 2-digit length + value`.
 *
 * The length is the byte count of the *value*, not the whole field, and it is
 * always exactly two digits — a value longer than 99 bytes would produce a
 * payload no scanner can parse, so it is refused rather than truncated.
 */
function tlv(id: string, value: string): string {
  const length = utf8Bytes(value).length;
  if (length > 99) {
    throw new ValidationError(
      `EMV field ${id} is ${length} bytes; the format allows at most 99`,
      { id, length },
    );
  }
  return `${id}${String(length).padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE — polynomial 0x1021, initial value 0xFFFF, no reflection,
 * no final XOR.
 *
 * This is the checksum EMVCo specifies for tag 63, and the reason a QR with an
 * incorrect one is silently rejected by every banking app.
 */
export function crc16Ccitt(payload: string): string {
  const bytes = utf8Bytes(payload);
  let crc = 0xffff;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Build the payload string.
 *
 * Field order is fixed by the spec and the CRC is computed over everything that
 * precedes it, including the `6304` header of its own field — a detail that is
 * easy to get wrong and produces a payload that looks fine and never scans.
 */
export function buildFpsQrPayload(input: FpsQrInput): string {
  if (!input.fpsId.trim()) {
    throw new ValidationError('A FPS QR needs a payee identifier');
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ValidationError(
      `FPS QR amount must be a positive integer number of minor units, received ${input.amountMinor}`,
      { amountMinor: input.amountMinor },
    );
  }

  // The nested merchant-account template: 00 = globally unique id, 01 = the id.
  const accountTemplate = `${tlv('00', 'hk.com.hkicl')}${tlv('01', input.fpsId.trim())}`;

  const body = [
    tlv(TAG_PAYLOAD_FORMAT, '01'),
    tlv(TAG_POINT_OF_INITIATION, POINT_OF_INITIATION_DYNAMIC),
    tlv(TAG_MERCHANT_ACCOUNT_FPS, accountTemplate),
    tlv(TAG_MERCHANT_CATEGORY_CODE, input.merchantCategoryCode ?? DEFAULT_MCC),
    tlv(TAG_TRANSACTION_CURRENCY, input.currency.toUpperCase()),
    // Tag 54 is a decimal string in MAJOR units, with a dot — the one place in
    // this codebase where money is not minor units, because the spec says so.
    tlv(TAG_TRANSACTION_AMOUNT, formatMajorUnits(input.amountMinor)),
    tlv(TAG_COUNTRY_CODE, COUNTRY_HK),
    tlv(TAG_MERCHANT_NAME, truncate(input.merchantName, 25)),
    tlv(TAG_MERCHANT_CITY, truncate(input.city ?? 'HONG KONG', 15)),
    tlv(TAG_ADDITIONAL_DATA, tlv('05', truncate(input.reference, 25))),
  ].join('');

  // CRC is computed over the body plus the literal `6304` header.
  const withHeader = `${body}${TAG_CRC}04`;
  return `${withHeader}${crc16Ccitt(withHeader)}`;
}

function formatMajorUnits(minor: number): string {
  const units = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, '0');
  return `${units}.${cents}`;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** UTF-8 byte width of one code point, as a string. */
function byteWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Read back the fields a scanner would, so a caller can assert the payload is
 * self-consistent without a phone.
 *
 * Walks **code points** and consumes the declared number of **bytes**. An
 * earlier version sliced by JavaScript string index, which happens to work for
 * an ASCII payload and silently desynchronises on the first multi-byte
 * character: for the merchant name `點心快線` it returned `點心快線6009HONG` as
 * tag 59 and then lost every field after it. Since the whole point of this
 * function is to check a payload before it reaches a customer, it has to be
 * right about the payloads we actually generate — and a Hong Kong merchant name
 * is not ASCII.
 */
export function parseFpsQrPayload(payload: string): Record<string, string> {
  const points = [...payload];
  const fields: Record<string, string> = {};
  let cursor = 0;

  while (cursor + 4 <= points.length) {
    const id = `${points[cursor] ?? ''}${points[cursor + 1] ?? ''}`;
    const length = Number.parseInt(`${points[cursor + 2] ?? ''}${points[cursor + 3] ?? ''}`, 10);
    if (!Number.isFinite(length) || length < 0) break;

    let bytes = 0;
    let end = cursor + 4;
    while (end < points.length && bytes < length) {
      bytes += byteWidth(points[end] ?? '');
      end += 1;
    }
    // A truncated payload stops rather than returning a field that runs past
    // the end of the string.
    if (bytes !== length) break;

    fields[id] = points.slice(cursor + 4, end).join('');
    cursor = end;
  }

  return fields;
}
