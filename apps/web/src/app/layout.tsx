import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/ui';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '自取平台 — 外賣自取，準時取餐',
    template: '%s · 自取平台',
  },
  description: '香港外賣自取平台：線上點餐、指定時間取餐，免等位免運費。',
};

export const viewport: Viewport = {
  themeColor: '#0b0f14',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Root layout.
 *
 * `AuthProvider` wraps everything because all three portals share one session —
 * an admin who is also a merchant owner should not have to log in twice, and a
 * single provider is what makes that true.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-HK">
      <body>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
