const CURRENCY_LOCALE: Record<string, string> = {
  USD: 'en-US',
  EUR: 'de-DE',
  GBP: 'en-GB',
  JPY: 'ja-JP',
  AUD: 'en-AU',
  CAD: 'en-CA'
}

export function money(value: number, currency = 'USD', options: Intl.NumberFormatOptions = {}): string {
  const locale = CURRENCY_LOCALE[currency] ?? 'en-US'
  const abs = Math.abs(value)
  // Sub-cent amounts round to "$0.00", which reads as nothing; show more digits
  // instead so dust is still legible.
  const digits = abs > 0 && abs < 0.01 ? 4 : 2
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    ...options
  }).format(value)
}

export function compactMoney(value: number, currency = 'USD'): string {
  if (Math.abs(value) < 10_000) return money(value, currency)
  const locale = CURRENCY_LOCALE[currency] ?? 'en-US'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value)
}

/** Token amounts need more precision than fiat, but not eighteen decimals of it. */
export function tokenAmount(amount: number, symbol?: string): string {
  const abs = Math.abs(amount)
  let digits: number
  if (abs === 0) digits = 0
  else if (abs < 0.0001) digits = 8
  else if (abs < 1) digits = 6
  else if (abs < 1000) digits = 4
  else digits = 2
  const text = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  }).format(amount)
  return symbol ? `${text} ${symbol}` : text
}

export function percent(value: number, withSign = true): string {
  const sign = withSign && value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function signedMoney(value: number, currency = 'USD'): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${money(Math.abs(value), currency)}`
}

export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (!address || address.length <= lead + tail + 2) return address
  return `${address.slice(0, lead)}…${address.slice(-tail)}`
}

export function initials(text: string): string {
  const cleaned = text.trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/[\s_-]+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export function dateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Deterministic readable text colour for a coloured circle. */
export function contrastText(hex: string): string {
  const value = hex.replace('#', '')
  if (value.length < 6) return '#fff'
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? '#14161c' : '#ffffff'
}
