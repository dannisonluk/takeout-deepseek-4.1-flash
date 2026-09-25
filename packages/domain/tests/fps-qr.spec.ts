import { describe, expect, it } from 'vitest';
import {
  buildFpsQrPayload,
  crc16Ccitt,
  parseFpsQrPayload,
  ValidationError,
} from '../src/index';

const BASE = {
  fpsId: '85291234567',
  merchantName: 'DIM SUM EXPRESS',
  amountMinor: 15_200,
  currency: 'HKD',
  reference: 'ORD-20260924-0007',
};

/**
 * Walk the TLV structure the way a scanner does, without trusting our parser.
 *
 * Byte-faithful on purpose: the declared length is a byte count, so a reader
 * that slices by JavaScript string index desynchronises the moment a field
 * holds a multi-byte character — which is exactly the bug this file exists to
 * catch. `Buffer` is fine here; only `src/` has to stay dependency-free.
 */
function readTlv(payload: string): Array<{ id: string; length: number; value: string }> {
  const out: Array<{ id: string; length: number; value: string }> = [];
  let cursor = 0;

  while (cursor + 4 <= payload.length) {
    const id = payload.slice(cursor, cursor + 2);
    const length = Number.parseInt(payload.slice(cursor + 2, cursor + 4), 10);
    if (!Number.isFinite(length)) break;

    let end = cursor + 4;
    let consumed = 0;
    while (consumed < length && end < payload.length) {
      const codePoint = payload.codePointAt(end) ?? 0;
      const character = String.fromCodePoint(codePoint);
      consumed += Buffer.byteLength(character, 'utf8');
      end += character.length;
    }

    out.push({ id, length, value: payload.slice(cursor + 4, end) });
    cursor = end;
  }

  return out;
}

describe('crc16Ccitt', () => {
  it('matches the published CRC-16/CCITT-FALSE check value', () => {
    // The standard check string for this variant: "123456789" -> 0x29B1.
    expect(crc16Ccitt('123456789')).toBe('29B1');
  });

  it('returns exactly four uppercase hex digits', () => {
    for (const input of ['', 'A', 'hello world', '點心']) {
      expect(crc16Ccitt(input)).toMatch(/^[0-9A-F]{4}$/);
    }
  });

  it('encodes non-ASCII as UTF-8 bytes, not code units', () => {
    // "點" is E9 BB 9E in UTF-8. A code-unit implementation would disagree.
    expect(crc16Ccitt('點')).not.toBe(crc16Ccitt('\u9ede\u9ede'));
    expect(crc16Ccitt('é')).not.toBe(crc16Ccitt('e'));
  });
});

describe('buildFpsQrPayload', () => {
  it('emits the mandatory fields in spec order', () => {
    const payload = buildFpsQrPayload(BASE);
    const fields = readTlv(payload);
    expect(fields.map((field) => field.id)).toEqual([
      '00', // payload format indicator
      '01', // point of initiation
      '26', // merchant account information
      '52', // merchant category code
      '53', // transaction currency
      '54', // transaction amount
      '58', // country code
      '59', // merchant name
      '60', // merchant city
      '62', // additional data
      '63', // CRC
    ]);
  });

  it('marks itself dynamic, because it carries an amount', () => {
    const fields = readTlv(buildFpsQrPayload(BASE));
    expect(fields.find((f) => f.id === '00')?.value).toBe('01');
    expect(fields.find((f) => f.id === '01')?.value).toBe('12');
  });

  it('carries the payee identifier in the nested template', () => {
    const fields = readTlv(buildFpsQrPayload(BASE));
    const template = fields.find((field) => field.id === '26')?.value ?? '';
    const nested = readTlv(template);
    expect(nested.find((f) => f.id === '00')?.value).toBe('hk.com.hkicl');
    expect(nested.find((f) => f.id === '01')?.value).toBe(BASE.fpsId);
  });

  it('writes the amount in major units with a dot, because the spec says so', () => {
    // The one place in this codebase where money is not minor units.
    const fields = readTlv(buildFpsQrPayload(BASE));
    expect(fields.find((f) => f.id === '54')?.value).toBe('152.00');
    expect(readTlv(buildFpsQrPayload({ ...BASE, amountMinor: 5 }))[5]?.value).toBe('0.05');
    expect(readTlv(buildFpsQrPayload({ ...BASE, amountMinor: 100 }))[5]?.value).toBe('1.00');
  });

  it('defaults to Hong Kong and the eating-places category', () => {
    const fields = readTlv(buildFpsQrPayload(BASE));
    expect(fields.find((f) => f.id === '58')?.value).toBe('HK');
    expect(fields.find((f) => f.id === '52')?.value).toBe('5812');
    expect(fields.find((f) => f.id === '60')?.value).toBe('HONG KONG');
  });

  it('carries our order reference so a transfer can be reconciled', () => {
    const fields = readTlv(buildFpsQrPayload(BASE));
    const additional = readTlv(fields.find((f) => f.id === '62')?.value ?? '');
    expect(additional.find((f) => f.id === '05')?.value).toBe(BASE.reference);
  });

  it('terminates with a CRC computed over everything before it', () => {
    const payload = buildFpsQrPayload(BASE);
    const body = payload.slice(0, -4);
    expect(payload.slice(-4)).toBe(crc16Ccitt(body));
    expect(body.endsWith('6304')).toBe(true);
  });

  it('changes the CRC when the amount changes — it is not a constant', () => {
    const a = buildFpsQrPayload(BASE);
    const b = buildFpsQrPayload({ ...BASE, amountMinor: BASE.amountMinor + 1 });
    expect(a.slice(-4)).not.toBe(b.slice(-4));
  });

  it('measures field lengths in UTF-8 bytes, so a Chinese name still scans', () => {
    const payload = buildFpsQrPayload({ ...BASE, merchantName: '點心快線' });
    const fields = readTlv(payload);
    const name = fields.find((field) => field.id === '59');
    // Four Chinese characters are 12 bytes, so the declared length must be 12 —
    // a `String.length` implementation would declare 4 and desynchronise the
    // whole payload.
    expect(name?.length).toBe(12);
    expect(name?.value).toBe('點心快線');
  });

  it('refuses a field longer than the format allows instead of truncating it', () => {
    // The name and city are truncated to the spec's own limits, so the guard
    // that has to bite is the 99-byte ceiling on the payee identifier — a value
    // that long would produce a payload no scanner can walk.
    expect(() => buildFpsQrPayload({ ...BASE, fpsId: '9'.repeat(120) })).toThrow(ValidationError);
  });

  it('truncates the free-text fields to their spec limits rather than refusing', () => {
    const long = buildFpsQrPayload({ ...BASE, merchantName: 'A'.repeat(60) });
    const name = readTlv(long).find((field) => field.id === '59');
    expect(name?.value).toHaveLength(25);
    expect(name?.length).toBe(25);
  });

  it('refuses a missing payee or a non-positive amount', () => {
    expect(() => buildFpsQrPayload({ ...BASE, fpsId: '   ' })).toThrow(ValidationError);
    expect(() => buildFpsQrPayload({ ...BASE, amountMinor: 0 })).toThrow(ValidationError);
    expect(() => buildFpsQrPayload({ ...BASE, amountMinor: -100 })).toThrow(ValidationError);
    expect(() => buildFpsQrPayload({ ...BASE, amountMinor: 12.5 })).toThrow(ValidationError);
  });

  it('round-trips through the parser', () => {
    const fields = parseFpsQrPayload(buildFpsQrPayload(BASE));
    expect(fields['53']).toBe('HKD');
    expect(fields['54']).toBe('152.00');
    expect(fields['63']).toMatch(/^[0-9A-F]{4}$/);
  });

  it('round-trips a multi-byte merchant name, and does not lose the fields after it', () => {
    // The regression this guards: a parser that slices by string index reads the
    // byte length as a code-unit count, so tag 59 comes back as
    // `點心快線6009HONG` and every field after it is gone. A Hong Kong merchant
    // name is not ASCII, so this is the common case, not the exotic one.
    const fields = parseFpsQrPayload(
      buildFpsQrPayload({ ...BASE, merchantName: '點心快線', city: '香港' }),
    );

    expect(fields['59']).toBe('點心快線');
    expect(fields['60']).toBe('香港');
    expect(fields['53']).toBe('HKD');
    expect(fields['54']).toBe('152.00');
    expect(fields['58']).toBe('HK');
    expect(parseFpsQrPayload(fields['62'] ?? '')['05']).toBe(BASE.reference);
    expect(fields['63']).toMatch(/^[0-9A-F]{4}$/);
  });

  it('stops at a truncated payload instead of returning a field past the end', () => {
    const payload = buildFpsQrPayload(BASE);
    const fields = parseFpsQrPayload(payload.slice(0, payload.length - 10));
    expect(fields['63']).toBeUndefined();
    // Everything before the truncation still reads correctly.
    expect(fields['53']).toBe('HKD');
  });
});
