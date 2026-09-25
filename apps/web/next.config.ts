import type { NextConfig } from 'next';

/**
 * The web app talks to `apps/api` over HTTP — there is no shared build step and
 * no server-side module reuse, deliberately. The API is the only contract
 * between the two, so the frontend can be deployed, scaled and even rewritten
 * without touching the domain layer.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  // The API returns snake-free camelCase JSON, so no response transformation is
  // needed. Kept here as the single place a proxy would be configured if the
  // two ever need to share an origin (which cookie-based auth would require).
  async rewrites() {
    return [];
  },
};

export default nextConfig;
