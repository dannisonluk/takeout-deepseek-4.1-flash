'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import {
  Banner,
  Button,
  Card,
  CardHead,
  ErrorBlock,
  Field,
  Input,
  Textarea,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { HK_DISTRICTS } from '@/lib/districts';

/**
 * Merchant onboarding.
 *
 * `slug` is asked for explicitly rather than derived from the name: it is the
 * permanent URL, and a merchant who cares about their link should choose it
 * rather than discover it was transliterated for them. The field is validated
 * client-side against the same pattern the API enforces, so a bad slug is a
 * hint under the input instead of a 400 after submitting.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])$/;

export default function MerchantApplyPage() {
  const router = useRouter();
  const { user, loading: authLoading, refreshProfile } = useAuth();
  const toast = useToast();

  const [form, setForm] = useState({
    slug: '',
    name: '',
    nameEn: '',
    description: '',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    district: 'Central',
    latitude: '22.2819',
    longitude: '114.1582',
    prepTimeMinutes: '15',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login?next=/merchant-apply');
  }, [authLoading, user, router]);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const slugError =
    form.slug.length > 0 && !SLUG_PATTERN.test(form.slug)
      ? '只可用小寫英文字母、數字與連字號，長度 3–120，且不可用連字號開頭或結尾'
      : null;

  const ready =
    form.slug.length > 0 &&
    !slugError &&
    form.name.trim().length > 0 &&
    form.addressLine1.trim().length > 0 &&
    Number.isFinite(Number(form.latitude)) &&
    Number.isFinite(Number(form.longitude));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const merchant = await api.merchant.apply({
        slug: form.slug.trim(),
        name: form.name.trim(),
        ...(form.nameEn.trim() ? { nameEn: form.nameEn.trim() } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        addressLine1: form.addressLine1.trim(),
        ...(form.addressLine2.trim() ? { addressLine2: form.addressLine2.trim() } : {}),
        district: form.district,
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        prepTimeMinutes: Number(form.prepTimeMinutes) || 15,
      });

      // `apply` promotes the caller CUSTOMER -> MERCHANT_OWNER server-side. The
      // role lives in the JWT, so the token in memory is now stale — without
      // this the merchant portal would bounce the brand-new owner straight back
      // out. A refresh call re-issues the token with the new role.
      await refreshProfile();

      toast.push(`${merchant.name} 已提交，等待平台審核`, 'ok');
      router.replace('/merchant');
    } catch (caught) {
      setError(caught as Error);
      setBusy(false);
    }
  }

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="stack">
          <div className="stack-sm" style={{ gap: 2 }}>
            <h1>申請成為商戶</h1>
            <p className="muted tiny">
              提交後由平台審核。核准前你的餐廳不會出現在前台，也不會收到訂單。
            </p>
          </div>

          <Banner tone="info" title="平台收費">
            每件主餐收取 HK$3.50 中介費，另加支付手續費（約 3.40% + HK$2.35）。
            中介費為平台可調整參數，實際金額以你上線時的設定為準。
          </Banner>

          <Card>
            <CardHead title="餐廳資料" subtitle="帶 * 的為必填" />
            <div className="stack">
              <Field
                label="網址代稱 *"
                error={slugError}
                hint={slugError ? undefined : `前台網址將為 /m/${form.slug || 'your-slug'}`}
              >
                <Input
                  value={form.slug}
                  onChange={(event) => set('slug')(event.target.value.toLowerCase())}
                  placeholder="dim-sum-express"
                  className={slugError ? 'input-error' : ''}
                />
              </Field>

              <div className="grid-2">
                <Field label="餐廳名稱 *">
                  <Input
                    value={form.name}
                    onChange={(event) => set('name')(event.target.value)}
                    placeholder="點心快線"
                    maxLength={160}
                  />
                </Field>
                <Field label="英文名稱">
                  <Input
                    value={form.nameEn}
                    onChange={(event) => set('nameEn')(event.target.value)}
                    placeholder="Dim Sum Express"
                    maxLength={160}
                  />
                </Field>
              </div>

              <Field label="簡介" hint="會顯示在前台的餐廳卡片上">
                <Textarea
                  value={form.description}
                  onChange={(event) => set('description')(event.target.value)}
                  placeholder="傳統手工點心，即點即蒸。"
                  maxLength={2000}
                />
              </Field>

              <Field label="聯絡電話">
                <Input
                  type="tel"
                  value={form.phone}
                  onChange={(event) => set('phone')(event.target.value)}
                  placeholder="+85221234567"
                />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHead title="地址與位置" subtitle="顧客會用此地址導航到店" />
            <div className="stack">
              <Field label="地址第一行 *">
                <Input
                  value={form.addressLine1}
                  onChange={(event) => set('addressLine1')(event.target.value)}
                  placeholder="中環德輔道中 88 號"
                  maxLength={255}
                />
              </Field>

              <Field label="地址第二行">
                <Input
                  value={form.addressLine2}
                  onChange={(event) => set('addressLine2')(event.target.value)}
                  placeholder="地下 A 舖"
                  maxLength={255}
                />
              </Field>

              <Field label="地區">
                <select
                  className="select"
                  value={form.district}
                  onChange={(event) => set('district')(event.target.value)}
                >
                  {HK_DISTRICTS.map((district) => (
                    <option key={district} value={district}>
                      {district}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid-2">
                <Field label="緯度 *" hint="例如中環 22.2819">
                  <Input
                    value={form.latitude}
                    onChange={(event) => set('latitude')(event.target.value)}
                    inputMode="decimal"
                  />
                </Field>
                <Field label="經度 *" hint="例如中環 114.1582">
                  <Input
                    value={form.longitude}
                    onChange={(event) => set('longitude')(event.target.value)}
                    inputMode="decimal"
                  />
                </Field>
              </div>

              <Field label="預計出餐時間（分鐘）" hint="1–240。顧客會看到這個數字">
                <Input
                  type="number"
                  min={1}
                  max={240}
                  value={form.prepTimeMinutes}
                  onChange={(event) => set('prepTimeMinutes')(event.target.value)}
                />
              </Field>
            </div>
          </Card>

          {error && <ErrorBlock error={error} />}

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => router.back()}>
              取消
            </Button>
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              disabled={!ready}
              onClick={() => void submit()}
            >
              提交申請
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
