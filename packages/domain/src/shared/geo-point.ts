import { ValidationError } from './domain-error';

export interface GeoPointLiteral {
  readonly latitude: number;
  readonly longitude: number;
}

const EARTH_RADIUS_KM = 6371.0088;

/**
 * Validated WGS84 coordinate.
 *
 * Mirrors a PostGIS `geography(Point, 4326)` column. Stored as an immutable
 * literal so the value can cross a serialisation boundary (Redis GEO, WebSocket
 * frame) without losing precision.
 */
export class GeoPoint {
  private constructor(
    readonly latitude: number,
    readonly longitude: number,
  ) {
    Object.freeze(this);
  }

  static of(latitude: number, longitude: number): GeoPoint {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new ValidationError(`Latitude out of range: ${latitude}`, { latitude });
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new ValidationError(`Longitude out of range: ${longitude}`, { longitude });
    }
    return new GeoPoint(latitude, longitude);
  }

  static fromLiteral(literal: GeoPointLiteral): GeoPoint {
    return GeoPoint.of(literal.latitude, literal.longitude);
  }

  toLiteral(): GeoPointLiteral {
    return { latitude: this.latitude, longitude: this.longitude };
  }

  /** Redis `GEOADD key lng lat member` argument order. */
  toRedisArgs(): [longitude: number, latitude: number] {
    return [this.longitude, this.latitude];
  }

  /** Great-circle distance in kilometres (haversine). */
  distanceKmTo(other: GeoPoint): number {
    const dLat = toRadians(other.latitude - this.latitude);
    const dLon = toRadians(other.longitude - this.longitude);
    const lat1 = toRadians(this.latitude);
    const lat2 = toRadians(other.latitude);

    const a =
      Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  equals(other: GeoPoint): boolean {
    return this.latitude === other.latitude && this.longitude === other.longitude;
  }
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
