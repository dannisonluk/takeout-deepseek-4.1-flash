'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { Tone } from '@/lib/format';

/* ==========================================================================
   Primitives
   ==========================================================================
   Deliberately small and unopinionated about layout — they set the visual
   language (radius, border, tone) and nothing else. Every screen composes them
   with the utility classes in globals.css, so there is exactly one place to
   change what a button or a badge looks like.
   ========================================================================== */

const TONE_VARS: Record<Tone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: 'var(--neutral-soft)', fg: 'var(--text-muted)', border: 'var(--border-strong)' },
  info: { bg: 'var(--info-soft)', fg: 'var(--info)', border: 'var(--info)' },
  warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)', border: 'var(--warn)' },
  ok: { bg: 'var(--ok-soft)', fg: 'var(--ok)', border: 'var(--ok)' },
  danger: { bg: 'var(--danger-soft)', fg: 'var(--danger)', border: 'var(--danger)' },
  accent: { bg: 'var(--accent-soft)', fg: 'var(--accent)', border: 'var(--accent)' },
};

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  title?: string;
}) {
  const vars = TONE_VARS[tone];
  return (
    <span
      className="badge"
      title={title}
      style={{ background: vars.bg, color: vars.fg, borderColor: vars.border }}
    >
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

export function Button({
  variant = 'default',
  size,
  block,
  loading,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'lg';
  block?: boolean;
  loading?: boolean;
}) {
  const classes = [
    'btn',
    variant === 'primary' && 'btn-primary',
    variant === 'danger' && 'btn-danger',
    variant === 'ghost' && 'btn-ghost',
    size === 'sm' && 'btn-sm',
    size === 'lg' && 'btn-lg',
    block && 'btn-block',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} disabled={rest.disabled || loading} {...rest}>
      {loading ? '處理中…' : children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label?: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      {label && (
        <label className="label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <span className="hint" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : (
        hint && <span className="hint">{hint}</span>
      )}
    </div>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...rest} />;
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`select ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="checkbox" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** A labelled on/off control, for things like 接單中. */
export function Toggle({
  checked,
  onChange,
  disabled,
  onLabel = '開啟',
  offLabel = '關閉',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`btn ${checked ? 'btn-primary' : ''}`}
      aria-pressed={checked}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: checked ? '#12161d' : 'var(--text-dim)',
        }}
      />
      {checked ? onLabel : offLabel}
    </button>
  );
}

export function Card({
  children,
  className = '',
  flush,
  tight,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
  tight?: boolean;
}) {
  return (
    <div className={`card ${flush ? 'card-flush' : ''} ${tight ? 'card-tight' : ''} ${className}`}>
      {children}
    </div>
  );
}

export function CardHead({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card-head">
      <div className="stack-sm" style={{ gap: 2 }}>
        <h3>{title}</h3>
        {subtitle && <span className="tiny muted">{subtitle}</span>}
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={tone ? { color: TONE_VARS[tone].fg } : undefined}>
        {value}
      </span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`}>
      <div className="grow stack-sm" style={{ gap: 2 }}>
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Empty({
  icon = '○',
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <strong>{title}</strong>
      {children && <span className="tiny">{children}</span>}
      {action}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 'var(--space-4)' }}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ width: `${90 - index * 12}%` }} />
      ))}
    </div>
  );
}

/** Renders a loader, an error with retry, or the children. */
export function AsyncBlock({
  loading,
  error,
  onRetry,
  children,
  rows = 3,
}: {
  loading: boolean;
  error: Error | null;
  onRetry?: () => void;
  children: ReactNode;
  rows?: number;
}) {
  if (loading) return <Loading rows={rows} />;
  if (error) return <ErrorBlock error={error} onRetry={onRetry} />;
  return <>{children}</>;
}

/**
 * The one place an API error becomes a sentence.
 *
 * `ApiError.validationMessage` carries the field-level detail the API's
 * ValidationPipe produced, which is far more useful than "Bad Request".
 */
export function ErrorBlock({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const detail =
    'validationMessage' in error && typeof error.validationMessage === 'string'
      ? error.validationMessage
      : null;

  return (
    <Banner
      tone="danger"
      title="載入失敗"
      action={onRetry ? <Button size="sm" onClick={onRetry}>重試</Button> : undefined}
    >
      {detail ?? error.message}
    </Banner>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          className="tab"
          data-active={tab.value === value}
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="dim" style={{ marginLeft: 6 }}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-active={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A modal.
 *
 * Escape closes it and the backdrop click does too, because a console modal
 * that traps you is worse than the mistake it was guarding. The scroll lock is
 * restored on unmount rather than assumed.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        style={wide ? { maxWidth: 720 } : undefined}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="row-between" style={{ marginBottom: 'var(--space-4)' }}>
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="關閉">
            ✕
          </Button>
        </div>
        <div className="stack">{children}</div>
        {footer && (
          <>
            <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              {footer}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ==========================================================================
   Toasts
   ========================================================================== */

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'ok' | 'warn' | 'danger';
}

const ToastContext = createContext<{
  push: (message: string, tone?: Toast['tone']) => void;
} | null>(null);

const TOAST_TTL_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_TTL_MS);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="toast"
            style={{ borderLeftColor: TONE_VARS[toast.tone].border }}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
