'use client';

import type { ReactNode } from 'react';
import { Loading } from '@/components/ui';
import { useRequireRole } from '@/lib/auth';

/**
 * Guards the `/admin` subtree.
 *
 * Client-side only, and knowingly so: every `/v1/admin/*` route is behind
 * `JwtAuthGuard` + `RolesGuard`, and the API is the boundary. This guard exists
 * so a merchant who bookmarks the console sees a redirect instead of a page
 * full of 403 banners.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const { user, loading, denied } = useRequireRole(['ADMIN']);

  if (loading || denied || !user) {
    return (
      <div className="page" style={{ maxWidth: 480 }}>
        <Loading rows={4} />
      </div>
    );
  }

  return <>{children}</>;
}
