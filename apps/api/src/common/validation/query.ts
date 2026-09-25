import { Transform } from 'class-transformer';

/**
 * Query-string coercions shared by every list endpoint.
 *
 * Query values always arrive as text. The global `ValidationPipe` runs with
 * `enableImplicitConversion: false` on purpose — implicit conversion would turn
 * `"abc"` into `NaN` and then quietly accept it as a number — so each field
 * declares its own coercion and lets the validator reject what is left.
 */
export const toNumber = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === '' ? undefined : Number(value);

/**
 * `Boolean("false") === true`, so a naive cast makes `?acceptingOnly=false` mean
 * the opposite of what it says. Parse the string explicitly.
 */
export const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};

/** A repeatable query parameter (`?status=A&status=B`) as a string array. */
export const toStringArray = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === '') return undefined;
  return Array.isArray(value) ? value.map(String) : [String(value)];
};

/** Default and maximum page sizes, so every list endpoint agrees. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** The wire shape of a paged query. `limit`/`offset`, never `take`/`skip`. */
export interface PageQuery {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Resolve `limit`/`offset` into the `take`/`skip` Prisma wants.
 *
 * Deliberately a free function rather than a getter on the DTO. A getter named
 * `take` looks tidy, but `class-transformer` assigns every key it finds in the
 * plain query object onto the instance — so a client sending `?take=5` (a very
 * natural guess) hits `Cannot set property take of #<Dto> which has only a
 * getter` and the request dies as a 500. Keeping the DTO to decorated data
 * fields and doing the arithmetic here removes that whole failure mode.
 */
export function paginate(query: PageQuery): { take: number; skip: number } {
  return {
    take: query.limit ?? DEFAULT_PAGE_SIZE,
    skip: query.offset ?? 0,
  };
}
