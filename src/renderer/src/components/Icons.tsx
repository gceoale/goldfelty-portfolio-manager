import type { JSX, SVGProps } from 'react'

/** A small set of line icons, 16px on a 16px grid, drawn for this app. */
type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const OverviewIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M2 13.5h12" />
    <path d="M3 10.5l3-3.5 2.5 2 4.5-5.5" />
  </Svg>
)

export const SendIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M4.5 11.5l7-7" />
    <path d="M6 4.5h5.5V10" />
  </Svg>
)

export const ReceiveIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M11.5 4.5l-7 7" />
    <path d="M10 11.5H4.5V6" />
  </Svg>
)

export const ActivityIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
  </Svg>
)

export const SettingsIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" />
  </Svg>
)

export const PlusIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)

export const RefreshIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.5v3h-3" />
  </Svg>
)

export const CopyIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5V3a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.5" />
  </Svg>
)

export const CheckIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
)

export const ChevronIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Svg>
)

export const LockIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Svg>
)

export const ExternalIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5l-6 6" />
    <path d="M12 9.5V13a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 3 13V5a.5.5 0 0 1 .5-.5H7" />
  </Svg>
)

export const SearchIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </Svg>
)

export const WarningIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M8 2l6.5 11.5h-13z" />
    <path d="M8 6.5v3M8 11.6v.2" />
  </Svg>
)

export const CloseIcon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)
