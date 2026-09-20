import type { JSX, SVGProps } from 'react'

/**
 * Hand-rolled icon set. Inline SVG keeps the bundle free of an icon dependency
 * and lets every glyph share one stroke weight, which is what makes an icon set
 * read as a set.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconHome = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20h13V9.5" />
    <path d="M9.5 20v-5.5h5V20" />
  </Svg>
)

export const IconSend = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 19V5" />
    <path d="m5.5 11.5 6.5-6.5 6.5 6.5" />
  </Svg>
)

export const IconReceive = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="m18.5 12.5-6.5 6.5-6.5-6.5" />
  </Svg>
)

export const IconSettings = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 18.3a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.88 1.7 1.7 0 0 0-1.56-1.03H2a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 3.7 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.88.34H8.1a1.7 1.7 0 0 0 1.03-1.56V2a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88v.07a1.7 1.7 0 0 0 1.56 1.03H22a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z" />
  </Svg>
)

export const IconWallet = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z" />
    <path d="M3 8.5h15" />
    <circle cx="16.5" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconLock = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Svg>
)

export const IconShield = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.4-7.5 9.5-4.4-1.1-7.5-4.9-7.5-9.5V6Z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
)

export const IconCopy = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M15 6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15" />
  </Svg>
)

export const IconCheck = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
)

export const IconPlus = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconRefresh = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-.7 4.3" />
    <path d="M20 5v6h-6" />
  </Svg>
)

export const IconEye = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)

export const IconEyeOff = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M10.6 6.2A8.9 8.9 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.6" />
    <path d="M6.4 7.4A16.7 16.7 0 0 0 2.5 12S6 18 12 18a9.3 9.3 0 0 0 3.8-.8" />
    <path d="m4 4 16 16" />
  </Svg>
)

export const IconAlert = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M10.3 4.3 2.6 17.5A1.9 1.9 0 0 0 4.3 20.4h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Svg>
)

export const IconInfo = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4.5M12 8h.01" />
  </Svg>
)

export const IconClose = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const IconChevronRight = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
)

export const IconArrowLeft = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
)

export const IconTrash = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7" />
  </Svg>
)

export const IconLink = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.4 1.4" />
    <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.4-1.4" />
  </Svg>
)

export const IconExternal = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18.5 14v4.5A2.5 2.5 0 0 1 16 21H5.5A2.5 2.5 0 0 1 3 18.5V8A2.5 2.5 0 0 1 5.5 5.5H10" />
  </Svg>
)

export const IconSearch = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </Svg>
)

export const IconPencil = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    <path d="m14.5 6.5 3 3" />
  </Svg>
)

export const IconLayers = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </Svg>
)

export const IconDownload = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="m7.5 11 4.5 4.5 4.5-4.5" />
    <path d="M4.5 19.5h15" />
  </Svg>
)
