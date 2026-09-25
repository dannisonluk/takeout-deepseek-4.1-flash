/** Deterministic id generation port — injected so tests can assert on ids. */
export interface IdGenerator {
  /** Sortable, collision-resistant id (ULID / uuidv7 in production). */
  next(): string;
  /** Human-facing short code, e.g. pickup number `A-137`. */
  nextPickupCode(sequence: number): string;
}

export class UlidGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    const time = Date.now().toString(36).padStart(9, '0');
    const random = Math.floor(Math.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0');
    const seq = (this.counter % 1000).toString(36).padStart(2, '0');
    return `${time}${random}${seq}`.toUpperCase();
  }

  nextPickupCode(sequence: number): string {
    const letter = String.fromCharCode(65 + (Math.floor(sequence / 100) % 26));
    return `${letter}-${String(sequence % 100).padStart(2, '0')}`;
  }
}

/** Sequential generator for unit tests. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `id_${String(this.counter).padStart(6, '0')}`;
  }

  nextPickupCode(sequence: number): string {
    return `A-${String(sequence).padStart(2, '0')}`;
  }
}
