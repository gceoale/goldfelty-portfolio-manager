import { useEffect, useRef, useState, type ButtonHTMLAttributes, type JSX, type ReactNode } from 'react'
import { IconAlert, IconCheck, IconClose, IconCopy, IconEye, IconEyeOff, IconInfo } from './Icons.js'
import { contrastText, initials } from '../lib/format.js'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  busy?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  busy,
  icon,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    'btn',
    `btn--${variant}`,
    size !== 'md' ? `btn--${size}` : '',
    block ? 'btn--block' : '',
    !children ? 'btn--icon' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={classes} disabled={disabled || busy} {...rest}>
      {busy ? <span className="spinner" /> : icon}
      {children}
    </button>
  )
}

export function Card({
  title,
  description,
  action,
  flush,
  children,
  className = ''
}: {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  flush?: boolean
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={`card ${flush ? 'card--flush' : ''} ${className}`}>
      {(title || action) && (
        <header className="card__head" style={flush ? { padding: '18px 18px 0', marginBottom: 12 } : undefined}>
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {description && <p className="card__desc">{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  id
}: {
  label?: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  id?: string
}): JSX.Element {
  return (
    <div className="field">
      {label && (
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <span className="field__error">
          <IconAlert size={13} /> {error}
        </span>
      ) : hint ? (
        <span className="field__hint">{hint}</span>
      ) : null}
    </div>
  )
}

export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  id,
  onEnter
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  id?: string
  onEnter?: () => void
}): JSX.Element {
  const [shown, setShown] = useState(false)
  return (
    <div className="input-group">
      <input
        id={id}
        className="input"
        type={shown ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter()
        }}
        style={{ paddingRight: 44 }}
      />
      <div className="input-group__suffix">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          aria-label={shown ? 'Hide password' : 'Show password'}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <IconEyeOff size={15} /> : <IconEye size={15} />}
        </Button>
      </div>
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'switch--on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          aria-selected={option.value === value}
          className={`segmented__item ${option.value === value ? 'segmented__item--active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Coin({ symbol, color, size = 'md' }: { symbol: string; color: string; size?: 'sm' | 'md' }): JSX.Element {
  return (
    <span
      className={`coin ${size === 'sm' ? 'coin--sm' : ''}`}
      style={{ background: color, color: contrastText(color) }}
      aria-hidden="true"
    >
      {symbol.slice(0, 4).toUpperCase().slice(0, 3)}
    </span>
  )
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }): JSX.Element {
  return (
    <span className="account-chip__avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {initials(name)}
    </span>
  )
}

export function Banner({
  tone = 'info',
  title,
  children,
  action
}: {
  tone?: 'info' | 'warning' | 'danger' | 'positive'
  title?: string
  children?: ReactNode
  action?: ReactNode
}): JSX.Element {
  const Icon = tone === 'info' ? IconInfo : tone === 'positive' ? IconCheck : IconAlert
  return (
    <div className={`banner banner--${tone}`}>
      <span className="banner__icon">
        <Icon size={16} />
      </span>
      <div className="banner__body">
        {title && <div className="banner__title">{title}</div>}
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  action
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="empty">
      <span className="empty__icon">{icon}</span>
      <span className="empty__title">{title}</span>
      {children && <p className="empty__body">{children}</p>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  )
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide
}: {
  open: boolean
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Move focus into the dialog so keyboard users are not left behind it.
    ref.current?.querySelector<HTMLElement>('input, button, select, textarea')?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </Button>
        </div>
        {description && <p className="modal__desc">{description}</p>}
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  )
}

export function CopyButton({
  value,
  label = 'Copy',
  clearAfterMs,
  variant = 'secondary',
  size = 'sm',
  onCopied
}: {
  value: string
  label?: string
  clearAfterMs?: number
  variant?: Variant
  size?: 'sm' | 'md' | 'lg'
  onCopied?: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <Button
      variant={variant}
      size={size}
      icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      onClick={() => {
        void window.goldfelty.app.copy(value, clearAfterMs).then(() => {
          setCopied(true)
          onCopied?.()
        })
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

export interface Toast {
  id: number
  tone: 'success' | 'error' | 'info'
  title: string
  text?: string
}

export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element {
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} onClick={() => onDismiss(toast.id)}>
          <span className="toast__icon">
            {toast.tone === 'success' ? <IconCheck size={15} /> : toast.tone === 'error' ? <IconAlert size={15} /> : <IconInfo size={15} />}
          </span>
          <div className="toast__body">
            <div className="toast__title">{toast.title}</div>
            {toast.text && <div className="toast__text">{toast.text}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
