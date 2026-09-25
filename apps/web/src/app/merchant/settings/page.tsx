'use client';

import { useEffect, useState } from 'react';
import { MerchantShell, MerchantStatusNotice } from '@/components/merchant-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
  Toggle,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import { HK_DISTRICT_GROUPS, HK_DISTRICTS } from '@/lib/districts';
import { MERCHANT_STATUS_LABEL, MERCHANT_STATUS_TONE, minuteOfDay, weekday } from '@/lib/format';
import type { OperatingHour } from '@/lib/types';

/** `"09:30"` -> `570`. Returns `null` for a malformed or empty input. */
function parseMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** The fallback for a weekday with no row — a plausible trading day, closed. */
function defaultHour(dayOfWeek: number): OperatingHour {
  return { dayOfWeek, opensAtMinute: 9 * 60, closesAtMinute: 22 * 60, isClosed: true };
}

/** Always seven rows, in Sunday-first order, whatever the API returned. */
function toWeek(hours: readonly OperatingHour[]): OperatingHour[] {
  return Array.from({ length: 7 }, (_, day) => {
    const existing = hours.find((hour) => hour.dayOfWeek === day);
    return existing ? { ...existing } : defaultHour(day);
  });
}

export default function MerchantSettingsPage() {
  const { merchant, merchantId, patchLocal } = useMerchant();
  const toast = useToast();

  const [profile, setProfile] = useState({
    name: '',
    nameEn: '',
    description: '',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    district: '',
    latitude: '',
    longitude: '',
    prepTimeMinutes: '',
    pickupWindowMinutes: '',
    acceptTimeoutMinutes: '',
    autoAcceptOrders: false,
  });
  const [week, setWeek] = useState<OperatingHour[]>(() => toWeek([]));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Seed the form from the merchant row.
   *
   * Keyed on `merchant.id` rather than the whole object: `patchLocal` replaces
   * the row after every save, and re-seeding from it would stomp on whatever
   * the user has typed into a different section since.
   */
  useEffect(() => {
    if (!merchant) return;
    setProfile({
      name: merchant.name,
      nameEn: merchant.nameEn ?? '',
      description: merchant.description ?? '',
      phone: merchant.phone ?? '',
      addressLine1: merchant.addressLine1,
      addressLine2: merchant.addressLine2 ?? '',
      district: merchant.district ?? '',
      latitude: String(merchant.latitude),
      longitude: String(merchant.longitude),
      prepTimeMinutes: String(merchant.prepTimeMinutes),
      pickupWindowMinutes: String(merchant.pickupWindowMinutes),
      acceptTimeoutMinutes: String(merchant.acceptTimeoutMinutes),
      autoAcceptOrders: merchant.autoAcceptOrders,
    });
    setWeek(toWeek(merchant.hours));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant?.id]);

  if (!merchant || !merchantId) return null;

  const save = async (section: string, run: () => Promise<unknown>, message: string) => {
    setBusy(section);
    setError(null);
    try {
      await run();
      toast.push(message, 'ok');
    } catch (caught) {
      const text = (caught as Error).message;
      setError(text);
      toast.push(text, 'danger');
    } finally {
      setBusy(null);
    }
  };

  const saveBasics = () =>
    save(
      'basics',
      async () => {
        const updated = await api.merchant.update(merchantId, {
          name: profile.name.trim(),
          ...(profile.nameEn.trim() ? { nameEn: profile.nameEn.trim() } : {}),
          ...(profile.description.trim() ? { description: profile.description.trim() } : {}),
          ...(profile.phone.trim() ? { phone: profile.phone.trim() } : {}),
        });
        patchLocal(updated);
      },
      '基本資料已儲存',
    );

  const saveLocation = () =>
    save(
      'location',
      async () => {
        const latitude = Number(profile.latitude);
        const longitude = Number(profile.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          throw new Error('緯度與經度必須是數字');
        }
        const updated = await api.merchant.update(merchantId, {
          addressLine1: profile.addressLine1.trim(),
          ...(profile.addressLine2.trim() ? { addressLine2: profile.addressLine2.trim() } : {}),
          ...(profile.district ? { district: profile.district } : {}),
          latitude,
          longitude,
          prepTimeMinutes: Number(profile.prepTimeMinutes) || merchant.prepTimeMinutes,
          pickupWindowMinutes:
            Number(profile.pickupWindowMinutes) || merchant.pickupWindowMinutes,
        });
        patchLocal(updated);
      },
      '地址與出餐設定已儲存',
    );

  const saveOperations = () =>
    save(
      'operations',
      async () => {
        const updated = await api.merchant.update(merchantId, {
          acceptTimeoutMinutes: Number(profile.acceptTimeoutMinutes) || merchant.acceptTimeoutMinutes,
          autoAcceptOrders: profile.autoAcceptOrders,
        });
        patchLocal(updated);
      },
      '營運設定已儲存',
    );

  const saveHours = () =>
    save(
      'hours',
      async () => {
        const updated = await api.merchant.replaceHours(merchantId, week);
        patchLocal(updated);
      },
      '營業時間已儲存',
    );

  const toggleIntake = (next: boolean) =>
    save(
      'intake',
      async () => {
        const updated = await api.merchant.setIntake(merchantId, next);
        patchLocal(updated);
      },
      next ? '已開始接單' : '已暫停接單',
    );

  // The stored district is free text; if it is not one of the suggestions it
  // still has to be selectable, or saving would silently rewrite it.
  const districtIsKnown = profile.district === '' || HK_DISTRICTS.includes(profile.district);

  return (
    <MerchantShell
      title="商戶設定"
      subtitle={`${merchant.slug} · 時區 ${merchant.timezone}`}
    >
      <div className="stack">
        <MerchantStatusNotice merchant={merchant} />

        {error && <Banner tone="danger">{error}</Banner>}

        <Card>
          <CardHead
            title="接單狀態"
            subtitle="暫停後顧客仍看得到你的餐廳，但無法下單"
            action={
              <Toggle
                checked={merchant.acceptsOrders}
                onChange={(next) => void toggleIntake(next)}
                disabled={busy !== null || merchant.status !== 'ACTIVE'}
                onLabel="接單中"
                offLabel="已暫停"
              />
            }
          />
          <div className="row-wrap">
            <Badge tone={MERCHANT_STATUS_TONE[merchant.status]}>
              {MERCHANT_STATUS_LABEL[merchant.status]}
            </Badge>
            <span className="tiny dim">
              商戶狀態由平台管理。如需恢復營業或結業，請聯絡平台。
            </span>
          </div>
        </Card>

        <Card>
          <CardHead title="基本資料" subtitle="會顯示在顧客前台的餐廳頁" />
          <div className="stack">
            <div className="grid-2">
              <Field label="餐廳名稱 *">
                <Input
                  value={profile.name}
                  onChange={(event) => setProfile({ ...profile, name: event.target.value })}
                  maxLength={160}
                />
              </Field>
              <Field label="英文名稱">
                <Input
                  value={profile.nameEn}
                  onChange={(event) => setProfile({ ...profile, nameEn: event.target.value })}
                  maxLength={160}
                />
              </Field>
            </div>
            <Field label="簡介">
              <Textarea
                value={profile.description}
                onChange={(event) => setProfile({ ...profile, description: event.target.value })}
                maxLength={2000}
              />
            </Field>
            <Field label="聯絡電話" hint="格式如 +85221234567">
              <Input
                value={profile.phone}
                onChange={(event) => setProfile({ ...profile, phone: event.target.value })}
                placeholder="+85221234567"
              />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button
                variant="primary"
                loading={busy === 'basics'}
                disabled={profile.name.trim().length === 0}
                onClick={() => void saveBasics()}
              >
                儲存基本資料
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="地址與取餐" subtitle="顧客會用此地址導航到店" />
          <div className="stack">
            <Field label="地址第一行 *">
              <Input
                value={profile.addressLine1}
                onChange={(event) => setProfile({ ...profile, addressLine1: event.target.value })}
                maxLength={255}
              />
            </Field>
            <Field label="地址第二行">
              <Input
                value={profile.addressLine2}
                onChange={(event) => setProfile({ ...profile, addressLine2: event.target.value })}
                maxLength={255}
              />
            </Field>
            <Field label="地區" hint="用於前台的地區篩選，建議從清單選擇">
              <Select
                value={profile.district}
                onChange={(event) => setProfile({ ...profile, district: event.target.value })}
              >
                <option value="">未設定</option>
                {!districtIsKnown && (
                  <option value={profile.district}>{profile.district}（目前設定）</option>
                )}
                {HK_DISTRICT_GROUPS.map((group) => (
                  <optgroup key={group.region} label={group.region}>
                    {group.districts.map((district) => (
                      <option key={district} value={district}>
                        {district}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>

            <div className="grid-2">
              <Field label="緯度 *">
                <Input
                  value={profile.latitude}
                  onChange={(event) => setProfile({ ...profile, latitude: event.target.value })}
                  inputMode="decimal"
                />
              </Field>
              <Field label="經度 *">
                <Input
                  value={profile.longitude}
                  onChange={(event) => setProfile({ ...profile, longitude: event.target.value })}
                  inputMode="decimal"
                />
              </Field>
            </div>

            <div className="grid-2">
              <Field label="出餐時間（分鐘）" hint="1–240。顧客看到的下單到可取餐時間">
                <Input
                  value={profile.prepTimeMinutes}
                  onChange={(event) =>
                    setProfile({ ...profile, prepTimeMinutes: event.target.value })
                  }
                  inputMode="numeric"
                />
              </Field>
              <Field label="取餐時段長度（分鐘）" hint="5–480。顧客選取餐時間的間隔">
                <Input
                  value={profile.pickupWindowMinutes}
                  onChange={(event) =>
                    setProfile({ ...profile, pickupWindowMinutes: event.target.value })
                  }
                  inputMode="numeric"
                />
              </Field>
            </div>

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button
                variant="primary"
                loading={busy === 'location'}
                disabled={profile.addressLine1.trim().length === 0}
                onClick={() => void saveLocation()}
              >
                儲存地址設定
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="營運設定" />
          <div className="stack">
            <Field
              label="接單時限（分鐘）"
              hint="1–60。逾時未接單的訂單會由系統自動處理"
            >
              <Input
                value={profile.acceptTimeoutMinutes}
                onChange={(event) =>
                  setProfile({ ...profile, acceptTimeoutMinutes: event.target.value })
                }
                inputMode="numeric"
                style={{ maxWidth: 140 }}
              />
            </Field>
            <Checkbox
              checked={profile.autoAcceptOrders}
              onChange={(next) => setProfile({ ...profile, autoAcceptOrders: next })}
              label={
                <span>
                  自動接單
                  <span className="tiny dim">
                    {' '}
                    — 訂單付款後直接進入製作，不等待人手確認。繁忙時段建議開啟。
                  </span>
                </span>
              }
            />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button
                variant="primary"
                loading={busy === 'operations'}
                onClick={() => void saveOperations()}
              >
                儲存營運設定
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHead
            title="營業時間"
            subtitle="顧客只能選擇營業時間內的取餐時段"
            action={
              <Button
                size="sm"
                variant="primary"
                loading={busy === 'hours'}
                onClick={() => void saveHours()}
              >
                儲存營業時間
              </Button>
            }
          />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>星期</th>
                  <th>休息</th>
                  <th>開始</th>
                  <th>結束</th>
                </tr>
              </thead>
              <tbody>
                {week.map((hour, index) => (
                  <tr key={hour.dayOfWeek}>
                    <td className="strong">{weekday(hour.dayOfWeek)}</td>
                    <td>
                      <Checkbox
                        checked={hour.isClosed}
                        onChange={(next) =>
                          setWeek((current) =>
                            current.map((row, rowIndex) =>
                              rowIndex === index ? { ...row, isClosed: next } : row,
                            ),
                          )
                        }
                        label=""
                      />
                    </td>
                    <td>
                      <Input
                        type="time"
                        value={minuteOfDay(hour.opensAtMinute)}
                        disabled={hour.isClosed}
                        style={{ maxWidth: 130 }}
                        onChange={(event) => {
                          const minutes = parseMinute(event.target.value);
                          if (minutes === null) return;
                          setWeek((current) =>
                            current.map((row, rowIndex) =>
                              rowIndex === index ? { ...row, opensAtMinute: minutes } : row,
                            ),
                          );
                        }}
                      />
                    </td>
                    <td>
                      <Input
                        type="time"
                        value={minuteOfDay(hour.closesAtMinute)}
                        disabled={hour.isClosed}
                        style={{ maxWidth: 130 }}
                        onChange={(event) => {
                          const minutes = parseMinute(event.target.value);
                          if (minutes === null) return;
                          setWeek((current) =>
                            current.map((row, rowIndex) =>
                              rowIndex === index ? { ...row, closesAtMinute: minutes } : row,
                            ),
                          );
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
            跨夜營業（例如 18:00–02:00）目前不支援，結束時間必須晚於開始時間。
          </p>
        </Card>
      </div>
    </MerchantShell>
  );
}
