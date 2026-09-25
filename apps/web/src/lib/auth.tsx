'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, clearTokens, loadStoredRefreshToken, setSessionLostHandler, setTokens } from './api';
import type { AuthProfile, Session, UserRole } from './types';

interface AuthState {
  user: AuthProfile | null;
  /** True until the initial session restore has settled. */
  loading: boolean;
  login: (phone: string, code: string) => Promise<Session>;
  logout: () => Promise<void>;
  /** Re-read the profile — used after a role change (e.g. a merchant application). */
  refreshProfile: () => Promise<AuthProfile | null>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Where each role lands after logging in. */
export function homeFor(role: UserRole): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'MERCHANT_OWNER' || role === 'MERCHANT_STAFF') return '/merchant';
  return '/';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  /** Guards against a late response overwriting a newer session. */
  const generation = useRef(0);

  /**
   * Restore on mount.
   *
   * The access token is intentionally absent from storage, so a reload always
   * starts unauthenticated in memory and has to spend one refresh to come back.
   * That is the cost of not persisting the access token, and it is paid once
   * per page load rather than per request.
   */
  useEffect(() => {
    const current = ++generation.current;
    const token = loadStoredRefreshToken();
    if (!token) {
      setLoading(false);
      return;
    }

    (async () => {
      try {
        // `api.auth.me()` returns 401 on a stale access token, and the client's
        // refresh-and-retry path upgrades it before the error ever surfaces.
        const profile = await api.auth.me();
        if (generation.current === current) setUser(profile);
      } catch {
        clearTokens();
      } finally {
        if (generation.current === current) setLoading(false);
      }
    })();
  }, []);

  /**
   * When the client gives up on a refresh, the session is genuinely over.
   * Clearing `user` is what makes every guarded layout redirect.
   */
  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null);
    });
    return () => setSessionLostHandler(null);
  }, []);

  const login = useCallback(async (phone: string, code: string) => {
    const session = await api.auth.verifyOtp(phone, code);
    generation.current += 1;
    setTokens(session);
    setUser(session.user);
    return session;
  }, []);

  const logout = useCallback(async () => {
    const token = loadStoredRefreshToken();
    generation.current += 1;
    // Clear locally first: a failed revoke must not leave the user stuck
    // looking at a signed-in shell they can no longer use.
    clearTokens();
    setUser(null);
    if (token) {
      try {
        await api.auth.logout(token);
      } catch {
        /* the local session is already gone; nothing useful to report */
      }
    }
    router.push('/login');
  }, [router]);

  const refreshProfile = useCallback(async () => {
    try {
      const profile = await api.auth.me();
      setUser(profile);
      return profile;
    } catch {
      return null;
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout, refreshProfile }),
    [user, loading, login, logout, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/**
 * Guard for a page subtree.
 *
 * Deliberately client-side. The API is the real authorisation boundary — every
 * endpoint re-checks the token and the role — so this exists to avoid rendering
 * a shell the user cannot use, not to protect data. A route that relied on this
 * for security would be a route that leaks.
 */
export function useRequireRole(allowed: UserRole[]): {
  user: AuthProfile | null;
  loading: boolean;
  denied: boolean;
} {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!allowed.includes(user.role)) {
      // Send them where they CAN work rather than to a dead end.
      router.replace(homeFor(user.role));
    }
  }, [loading, user, allowed, router]);

  return {
    user,
    loading,
    denied: !loading && !!user && !allowed.includes(user.role),
  };
}
