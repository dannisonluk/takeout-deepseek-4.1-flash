'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, Card, Field, Input } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

/**
 * Phone + one-time-code login.
 *
 * Two steps in one page rather than two routes: the phone number is the only
 * state that has to survive between them, and keeping it in memory means a
 * user who mistypes the code does not lose the number they just entered.
 *
 * In development the API echoes the code back (`devCode`) because there is no
 * SMS contract yet. It is displayed rather than auto-filled — an auto-fill
 * would make the login flow untestable, since nobody would ever see the input.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading: sessionLoading, login } = useAuth();

  const [phone, setPhone] = useState('+852');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Where to go after a successful login: back where they were headed, else their home. */
  const next = params.get('next');

  useEffect(() => {
    if (!sessionLoading && user) {
      router.replace(next ?? homeFor(user.role));
    }
  }, [sessionLoading, user, next, router]);

  useEffect(() => {
    if (retryIn <= 0) return;
    const id = window.setInterval(() => setRetryIn((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(id);
  }, [retryIn]);

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.auth.requestOtp(phone.trim());
      setDevCode(result.devCode ?? null);
      setRetryIn(result.retryAfterSeconds);
      setStage('code');
    } catch (caught) {
      setError(readError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const session = await login(phone.trim(), code.trim());
      router.replace(next ?? homeFor(session.user.role));
    } catch (caught) {
      setError(readError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--space-5)',
      }}
    >
      <div className="stack" style={{ width: '100%', maxWidth: 400 }}>
        <div className="stack-sm" style={{ alignItems: 'center', textAlign: 'center' }}>
          <span className="nav-brand-mark" style={{ width: 44, height: 44, fontSize: 22, borderRadius: 12 }}>
            取
          </span>
          <h1>自取平台</h1>
          <p className="muted tiny">線上點餐，指定時間到店取餐</p>
        </div>

        <Card>
          {stage === 'phone' ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void requestCode();
              }}
            >
              <Field label="手機號碼" hint="香港號碼，可用 +852 或直接輸入 8 位數字">
                <Input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  autoFocus
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="+85290000001"
                />
              </Field>

              {error && (
                <span className="hint" style={{ color: 'var(--danger)' }}>
                  {error}
                </span>
              )}

              <Button type="submit" variant="primary" size="lg" block loading={busy}>
                取得驗證碼
              </Button>
            </form>
          ) : (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <Field label="驗證碼" hint={`已發送至 ${phone}`}>
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  placeholder="6 位數字"
                  style={{ letterSpacing: '0.35em', fontSize: 18, textAlign: 'center' }}
                />
              </Field>

              {devCode && (
                <div className="banner banner-info">
                  <div>
                    <strong>開發模式</strong>
                    <div className="tiny">
                      未接駁 SMS，驗證碼為 <span className="mono">{devCode}</span>
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <span className="hint" style={{ color: 'var(--danger)' }}>
                  {error}
                </span>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                loading={busy}
                disabled={code.length !== 6}
              >
                登入
              </Button>

              <div className="row-between">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStage('phone');
                    setCode('');
                    setError(null);
                  }}
                >
                  更改號碼
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={retryIn > 0 || busy}
                  onClick={() => void requestCode()}
                >
                  {retryIn > 0 ? `${retryIn} 秒後可重發` : '重新發送'}
                </Button>
              </div>
            </form>
          )}
        </Card>

        <div className="card card-tight stack-sm">
          <span className="tiny dim strong">示範帳號（開發環境）</span>
          <span className="tiny muted mono">+85290000001 顧客</span>
          <span className="tiny muted mono">+85290000002 商戶擁有人</span>
          <span className="tiny muted mono">+85290000003 平台管理員</span>
        </div>

        <p className="tiny dim center">
          <Link href="/">← 返回前台</Link>
        </p>
      </div>
    </div>
  );
}

/** Turn any thrown value into one sentence a person can act on. */
function readError(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.code === 'INVALID_OTP') return '驗證碼不正確，請再試一次';
    if (caught.code === 'OTP_RATE_LIMITED') return '發送太頻繁，請稍後再試';
    if (caught.code === 'ACCOUNT_DISABLED') return '此帳號已被停用，請聯絡平台管理員';
    return caught.validationMessage ?? caught.message;
  }
  return caught instanceof Error ? caught.message : '發生未知錯誤';
}

export default function LoginPage() {
  // `useSearchParams` needs a Suspense boundary, or the whole route opts out of
  // static rendering and `next build` fails on it.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
