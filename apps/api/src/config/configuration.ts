import { CurrencyCode } from '@takeout/domain';

/**
 * Typed application configuration.
 *
 * Every value has a safe default so `npm run start:dev` boots on a fresh clone
 * without a populated `.env`. Secrets have no default — they are validated at
 * boot by `validateEnv()`.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  apiPrefix: string;
  corsOrigins: string[];

  database: { url: string };
  redis: { url: string };

  jwt: { secret: string; accessTokenTtl: string; refreshTokenTtl: string };

  /** Cloudflare R2 is S3-compatible; the S3 SDK is used against its endpoint. */
  storage: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    /** CDN base for reading objects, e.g. `https://cdn.example.com`. */
    publicBaseUrl: string;
    presignTtlSeconds: number;
    maxUploadBytes: number;
    /**
     * Where objects live when R2 is not configured.
     *
     * `auto` picks R2 when credentials are present and a filesystem driver
     * otherwise. Without that fallback every media route fails on a fresh clone
     * — and the alternative, hardcoding `local` in development, means the R2
     * path is never exercised until production.
     */
    driver: 'auto' | 'r2' | 'local';
    /** Root directory for the local driver. Relative paths resolve from cwd. */
    localDir: string;
    /**
     * Public base the local driver builds URLs from.
     *
     * Points at this API's own media route, because a filesystem has no CDN —
     * the route streams the bytes back. Empty means "derive from PORT".
     */
    localPublicBaseUrl: string;
  };

  payment: {
    defaultProvider: 'STRIPE' | 'PAYME' | 'OCTOPUS' | 'FPS_QR';
    stripe: { secretKey: string; webhookSecret: string };
    /**
     * PayMe for Business.
     *
     * `merchantId` is the PayMe Business account the request is raised against;
     * `webhookSecret` verifies the settlement callback. Both empty means the
     * rail is registered but unusable, and the registry says so at boot rather
     * than failing at the first checkout.
     */
    payme: { merchantId: string; webhookSecret: string };
    /** Octopus / O! ePay merchant account. */
    octopus: { merchantId: string; webhookSecret: string };
    /**
     * 轉數快 (FPS).
     *
     * `fpsId` and `merchantName` are encoded into the EMVCo QR payload, so they
     * are the merchant's identity as far as the customer's banking app is
     * concerned — a wrong value produces a QR that scans and pays the wrong
     * person.
     */
    fps: { fpsId: string; merchantName: string; webhookSecret: string };
    /**
     * Where the customer completes a non-card payment.
     *
     * Our own page, not the acquirer's. None of the three HK rails has a hosted
     * checkout to redirect to — PayMe and Octopus are app-to-app, and FPS is a
     * QR the customer scans with their bank. So the platform hosts the page that
     * renders the QR or the deep-link button, and this is its base URL.
     */
    checkoutBaseUrl: string;
    /** Fallback PSP cost model, used when the provider does not report its own fee. */
    feeRateBps: number;
    feeFixedMinor: number;
    /**
     * When `false` the PSP is never contacted.
     *
     * Defaults to `true` only in production. In development and test the API
     * records the *intent* (a `PENDING` refund the operator settles by hand)
     * instead of calling Stripe. Two reasons, both concrete: a developer's test
     * key must never be able to move real money, and a local run must not block
     * a request on a 10-second network timeout with two retries behind it.
     */
    liveMode: boolean;
  };

  /**
   * Pricing policy defaults. The `platform_config` DB table overrides these at
   * boot, so changing HK$3.50 does not require a redeploy. Order of resolution:
   *   platform_config row  ->  environment variable  ->  the value here
   */
  pricing: {
    currency: CurrencyCode;
    feePerMainItemMinor: number;
    countAddOnItems: boolean;
    customerServiceFeeMinor: number;
    minimumPayoutMinor: number;
  };

  ordering: {
    /** Fallback when a merchant has no override. */
    acceptTimeoutMinutes: number;
    pickupWindowMinutes: number;
    /** How long an unpaid order holds its daily quota before expiring. */
    paymentTimeoutMinutes: number;
    /**
     * How often `OrderTimeoutSweeperService` runs a pass.
     *
     * A short interval is cheap — each pass is three indexed `SELECT id`s that
     * usually return nothing — so the default favours prompt expiry over
     * database quiet.
     */
    sweepIntervalMs: number;
    /**
     * Master switch for the two background loops (the order timeout sweeper and
     * the refund reactor).
     *
     * Off in `test` automatically. The e2e suite also turns it off explicitly:
     * a test that backdates a deadline and then calls the sweep endpoint must
     * not have a background pass expire the order first, or the assertion
     * depends on where in the 30-second cycle the test happened to run.
     */
    backgroundJobs: boolean;
    /**
     * How many days of `menu_item_daily_stock` to keep.
     *
     * Only the current service day is ever read, so this is pure storage
     * hygiene — but without it the table grows by (items x merchants) rows a
     * day with nothing to stop it.
     */
    quotaRetentionDays: number;
  };

  /**
   * Cancellation refund policy defaults.
   *
   * Mirrors the pricing block: `platform_config` overrides these at boot, so
   * finance can retune a refund percentage without a redeploy. Resolution order
   * is the same three layers — row -> environment -> value here.
   *
   * Ratios are **basis points** (10_000 = 100%), the same unit the payment fee
   * uses, so nobody has to remember which knob is a percentage and which is a
   * fraction.
   */
  cancellation: {
    /** Minutes after acceptance during which a customer may still cancel free. */
    graceMinutes: number;
    refundBps: {
      /** Nothing was prepared. */
      free: number;
      /** The customer walked away after the grace window. */
      late: number;
      /** The food was ready and never collected. */
      nonRefundable: number;
      /** The merchant refused or cancelled. */
      merchantFault: number;
      /** A timer expired the order. */
      platformFault: number;
      /** An operator cancelled and chose the ratio. */
      goodwill: number;
    };
  };

  /**
   * Observability.
   *
   * `token` is empty by default, and an empty token means "only serve the
   * exposition outside production" — see `MetricsService.isAuthorised`. It has
   * no default because there is no safe default: a hardcoded one would be a
   * published secret, and a required one would break `npm run start:dev`.
   */
  metrics: { token: string };

  /**
   * Customer feedback.
   *
   * `windowDays` bounds how long after collection an order can still be rated.
   * A review written three months later is a memory, not feedback about the
   * meal — and an unbounded window means an old order can be rated the moment a
   * merchant's ranking matters most.
   */
  reviews: {
    windowDays: number;
    /** Longest accepted comment, in characters. */
    maxCommentLength: number;
    /** Longest accepted merchant reply, in characters. */
    maxReplyLength: number;
  };

  /**
   * Image pipeline.
   *
   * Every uploaded image is re-encoded into three WebP derivatives plus a
   * BlurHash placeholder. The widths are configuration rather than constants
   * because they are a product decision — the discovery list is read on a phone
   * and the detail view on a tablet, and the right sizes for those change
   * without the pipeline changing.
   */
  media: {
    variantWidths: {
      /** Menu list rows and the cart. */
      thumb: number;
      /** The merchant page and the order summary. */
      card: number;
      /** The item detail view. */
      full: number;
    };
    webpQuality: number;
    /**
     * BlurHash component counts. 4x3 is the library's own recommendation for
     * photographs; more components mean a sharper placeholder and a longer
     * string, and 4x3 lands at roughly 28 characters.
     */
    blurhashComponentsX: number;
    blurhashComponentsY: number;
    /**
     * Refuse an image with more pixels than this, *before* sharp allocates for
     * it. A 5 MB PNG can decode to gigabytes — a decompression bomb is a denial
     * of service that looks like a normal upload. 50 MP is far beyond any phone
     * camera and far below what makes the attack worth mounting.
     */
    maxPixels: number;
  };
}

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
};

export function configuration(): AppConfig {
  return {
    nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
    port: int(process.env.PORT, 3000),
    apiPrefix: process.env.API_PREFIX ?? 'v1',
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),

    database: { url: process.env.DATABASE_URL ?? '' },
    redis: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },

    jwt: {
      secret: process.env.JWT_SECRET ?? '',
      accessTokenTtl: process.env.JWT_ACCESS_TTL ?? '15m',
      refreshTokenTtl: process.env.JWT_REFRESH_TTL ?? '30d',
    },

    storage: {
      endpoint:
        process.env.R2_ENDPOINT ??
        `https://${process.env.R2_ACCOUNT_ID ?? 'account'}.r2.cloudflarestorage.com`,
      region: process.env.R2_REGION ?? 'auto',
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
      bucket: process.env.R2_BUCKET ?? 'takeout-media',
      publicBaseUrl: process.env.R2_PUBLIC_BASE_URL ?? '',
      presignTtlSeconds: int(process.env.R2_PRESIGN_TTL_SECONDS, 900),
      maxUploadBytes: int(process.env.R2_MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
      driver: (process.env.STORAGE_DRIVER as AppConfig['storage']['driver']) ?? 'auto',
      localDir: process.env.STORAGE_LOCAL_DIR ?? '.media',
      localPublicBaseUrl: process.env.STORAGE_LOCAL_PUBLIC_BASE_URL ?? '',
    },

    payment: {
      defaultProvider: (process.env.PAYMENT_PROVIDER as AppConfig['payment']['defaultProvider']) ?? 'STRIPE',
      stripe: {
        secretKey: process.env.STRIPE_SECRET_KEY ?? '',
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
      },
      payme: {
        merchantId: process.env.PAYME_MERCHANT_ID ?? '',
        webhookSecret: process.env.PAYME_WEBHOOK_SECRET ?? '',
      },
      octopus: {
        merchantId: process.env.OCTOPUS_MERCHANT_ID ?? '',
        webhookSecret: process.env.OCTOPUS_WEBHOOK_SECRET ?? '',
      },
      fps: {
        fpsId: process.env.FPS_ID ?? '',
        merchantName: process.env.FPS_MERCHANT_NAME ?? '',
        webhookSecret: process.env.FPS_WEBHOOK_SECRET ?? '',
      },
      checkoutBaseUrl: process.env.PAYMENT_CHECKOUT_BASE_URL ?? 'http://localhost:3001/pay',
      feeRateBps: int(process.env.PAYMENT_FEE_RATE_BPS, 340),
      feeFixedMinor: int(process.env.PAYMENT_FEE_FIXED_MINOR, 235),
      liveMode: bool(process.env.PAYMENT_LIVE_MODE, process.env.NODE_ENV === 'production'),
    },

    pricing: {
      currency: (process.env.CURRENCY as CurrencyCode) ?? 'HKD',
      // 350 minor units = HK$3.50
      feePerMainItemMinor: int(process.env.PLATFORM_FEE_PER_MAIN_ITEM_MINOR, 350),
      countAddOnItems: bool(process.env.PLATFORM_FEE_COUNT_ADDONS, false),
      customerServiceFeeMinor: int(process.env.CUSTOMER_SERVICE_FEE_MINOR, 0),
      minimumPayoutMinor: int(process.env.MINIMUM_PAYOUT_MINOR, 0),
    },

    ordering: {
      acceptTimeoutMinutes: int(process.env.ACCEPT_TIMEOUT_MINUTES, 5),
      pickupWindowMinutes: int(process.env.PICKUP_WINDOW_MINUTES, 60),
      paymentTimeoutMinutes: int(process.env.PAYMENT_TIMEOUT_MINUTES, 15),
      sweepIntervalMs: int(process.env.ORDER_SWEEP_INTERVAL_MS, 30_000),
      backgroundJobs: bool(process.env.ORDER_BACKGROUND_JOBS, true),
      quotaRetentionDays: int(process.env.QUOTA_RETENTION_DAYS, 30),
    },

    cancellation: {
      graceMinutes: int(process.env.CANCELLATION_GRACE_MINUTES, 2),
      refundBps: {
        free: int(process.env.CANCELLATION_REFUND_BPS_FREE, 10_000),
        late: int(process.env.CANCELLATION_REFUND_BPS_LATE, 0),
        nonRefundable: int(process.env.CANCELLATION_REFUND_BPS_NON_REFUNDABLE, 0),
        merchantFault: int(process.env.CANCELLATION_REFUND_BPS_MERCHANT_FAULT, 10_000),
        platformFault: int(process.env.CANCELLATION_REFUND_BPS_PLATFORM_FAULT, 10_000),
        goodwill: int(process.env.CANCELLATION_REFUND_BPS_GOODWILL, 10_000),
      },
    },

    metrics: { token: process.env.METRICS_TOKEN ?? '' },

    reviews: {
      windowDays: int(process.env.REVIEW_WINDOW_DAYS, 14),
      maxCommentLength: int(process.env.REVIEW_MAX_COMMENT_LENGTH, 1000),
      maxReplyLength: int(process.env.REVIEW_MAX_REPLY_LENGTH, 600),
    },

    media: {
      variantWidths: {
        thumb: int(process.env.MEDIA_THUMB_WIDTH, 320),
        card: int(process.env.MEDIA_CARD_WIDTH, 640),
        full: int(process.env.MEDIA_FULL_WIDTH, 1280),
      },
      webpQuality: int(process.env.MEDIA_WEBP_QUALITY, 78),
      blurhashComponentsX: int(process.env.MEDIA_BLURHASH_X, 4),
      blurhashComponentsY: int(process.env.MEDIA_BLURHASH_Y, 3),
      maxPixels: int(process.env.MEDIA_MAX_PIXELS, 50_000_000),
    },
  };
}

/** Fail fast at boot rather than at the first request that needs a secret. */
export function validateEnv(config: AppConfig): void {
  const problems: string[] = [];

  if (!config.database.url) problems.push('DATABASE_URL is required');
  if (!config.jwt.secret || config.jwt.secret.length < 32) {
    problems.push('JWT_SECRET is required and must be at least 32 characters');
  }
  if (config.pricing.feePerMainItemMinor < 0) {
    problems.push('PLATFORM_FEE_PER_MAIN_ITEM_MINOR must be >= 0');
  }

  // `PAYMENT_PROVIDER` used to be cast rather than checked, so `PAYMENT_PROVIDER=payme`
  // (lowercase) or a typo silently became a default rail that does not exist.
  // `PaymentProviderRegistry.resolve()` throws for an unknown name, which would
  // have turned every checkout into a 400 instead of a boot error naming the
  // variable — this is the check that keeps it a boot error.
  const railNames: Array<AppConfig['payment']['defaultProvider']> = [
    'STRIPE',
    'PAYME',
    'OCTOPUS',
    'FPS_QR',
  ];
  if (!railNames.includes(config.payment.defaultProvider)) {
    problems.push(
      `PAYMENT_PROVIDER must be one of ${railNames.join(', ')}, received ${config.payment.defaultProvider}`,
    );
  }

  // Checked here rather than left to the policy engine so the boot error names
  // the environment variable the operator actually set. A refund ratio above
  // 100% would return money that was never captured.
  const ratioVars: Array<[string, number]> = [
    ['CANCELLATION_REFUND_BPS_FREE', config.cancellation.refundBps.free],
    ['CANCELLATION_REFUND_BPS_LATE', config.cancellation.refundBps.late],
    ['CANCELLATION_REFUND_BPS_NON_REFUNDABLE', config.cancellation.refundBps.nonRefundable],
    ['CANCELLATION_REFUND_BPS_MERCHANT_FAULT', config.cancellation.refundBps.merchantFault],
    ['CANCELLATION_REFUND_BPS_PLATFORM_FAULT', config.cancellation.refundBps.platformFault],
    ['CANCELLATION_REFUND_BPS_GOODWILL', config.cancellation.refundBps.goodwill],
  ];
  for (const [name, bps] of ratioVars) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      problems.push(`${name} must be an integer between 0 and 10000 (basis points), received ${bps}`);
    }
  }
  if (config.cancellation.graceMinutes < 0) {
    problems.push('CANCELLATION_GRACE_MINUTES must be >= 0');
  }
  if (config.reviews.windowDays < 1) {
    problems.push('REVIEW_WINDOW_DAYS must be >= 1');
  }

  if (config.nodeEnv === 'production') {
    if (!config.storage.accessKeyId) problems.push('R2_ACCESS_KEY_ID is required in production');
    if (!config.storage.secretAccessKey) problems.push('R2_SECRET_ACCESS_KEY is required in production');
    if (!config.payment.stripe.secretKey) problems.push('STRIPE_SECRET_KEY is required in production');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
