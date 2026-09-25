/**
 * Base class for every business-rule violation raised by the domain layer.
 *
 * Infrastructure layers (HTTP, GraphQL, message consumers) map `code` onto a
 * transport-level error. The domain never imports an HTTP library.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = Object.freeze({ ...details });
    // V8-only. Guarded so the domain package stays portable (no @types/node dep).
    const capture = (
      Error as unknown as {
        captureStackTrace?: (target: object, constructorOpt?: unknown) => void;
      }
    ).captureStackTrace;
    capture?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Input failed validation before any business rule was evaluated. */
export class ValidationError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VALIDATION_ERROR', message, details);
  }
}

/** A business invariant was violated (correct input, illegal state). */
export class InvariantViolation extends DomainError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}
