import { useEffect, useId, useRef, type JSX, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'
import { monogram } from '@shared/walletRegistry.ts'
import type { Toast } from '../state/app.tsx'
import { CloseIcon } from './Icons.tsx'

/* ---- buttons --------------------------------------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'plain' | 'danger'
  small?: boolean
  busy?: boolean
}

export function Button({ variant = 'default', small, busy, className = '', children, disabled, ...rest }: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`btn btn-${variant}${small ? ' btn-small' : ''} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  )
}

export function Spinner(): JSX.Element {
  return <span className="spinner" aria-hidden="true" />
}

/* ---- form controls ---------------------------------------------------------- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  htmlFor?: string
}): JSX.Element {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field-control">
        {children}
        {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
      </div>
    </div>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }): JSX.Element {
  const { mono, className = '', ...rest } = props
  return <input className={`input${mono ? ' mono' : ''} ${className}`} spellCheck={false} autoComplete="off" {...rest} />
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
}): JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

/* ---- grouped lists (System Settings style) --------------------------------- */

export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="group">
      {title ? <h3 className="group-title">{title}</h3> : null}
      <div className="group-body">{children}</div>
      {footer ? <div className="group-footer">{footer}</div> : null}
    </section>
  )
}

export function Row({ label, detail, children }: { label: ReactNode; detail?: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-label">{label}</div>
        {detail ? <div className="row-detail">{detail}</div> : null}
      </div>
      {children ? <div className="row-accessory">{children}</div> : null}
    </div>
  )
}

/* ---- sheets ------------------------------------------------------------------ */

export function Sheet({
  title,
  onClose,
  children,
  footer,
  wide
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}): JSX.Element {
  const id = useId()
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet${wide ? ' sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <header className="sheet-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <footer className="sheet-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

/* ---- identity ------------------------------------------------------------------ */

/** A wallet app's mark: its own icon if it gave us one, else a monogram in its colour. */
export function WalletGlyph({ name, color, icon, size = 20 }: { name: string; color: string; icon?: string | null; size?: number }): JSX.Element {
  if (icon && /^data:image\/(png|svg\+xml|webp|jpeg|gif);/.test(icon)) {
    return <img className="glyph" src={icon} alt="" width={size} height={size} />
  }
  return (
    <span className="glyph glyph-mono" style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.5) }} aria-hidden="true">
      {monogram(name)}
    </span>
  )
}

export function AssetGlyph({ symbol, color, size = 22 }: { symbol: string; color: string; size?: number }): JSX.Element {
  return (
    <span className="glyph glyph-asset" style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.34) }} aria-hidden="true">
      {symbol.slice(0, 3)}
    </span>
  )
}

export function StatusDot({ on, label }: { on: boolean; label: string }): JSX.Element {
  return <span className={`dot ${on ? 'dot-on' : 'dot-off'}`} role="img" aria-label={label} title={label} />
}

/* ---- notifications --------------------------------------------------------------- */

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <div>
            <div className="toast-title">{t.title}</div>
            {t.body ? <div className="toast-body">{t.body}</div> : null}
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }): JSX.Element {
  return <div className={`notice notice-${tone}`}>{children}</div>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  )
}

/** A page's top bar: title on the left, controls on the right. Drags the window on macOS. */
export function Toolbar({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <header className="toolbar">
      <div className="toolbar-title">
        <h1>{title}</h1>
        {subtitle ? <span className="toolbar-subtitle">{subtitle}</span> : null}
      </div>
      <div className="toolbar-actions">{children}</div>
    </header>
  )
}
