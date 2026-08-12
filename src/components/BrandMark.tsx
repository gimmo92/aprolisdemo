import { useId } from 'react'

type BrandMarkProps = {
  href?: string
  size?: 'md' | 'lg'
  showProduct?: boolean
  className?: string
}

function AestimaPictogram({ className }: { className?: string }) {
  const uid = useId().replace(/:/g, '')
  const gradientId = `aestima-grad-${uid}`
  const maskId = `aestima-mask-${uid}`

  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      width={40}
      height={40}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="4" y1="2" x2="36" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#5bb8ff" />
          <stop offset="55%" stopColor="#2f7fff" />
          <stop offset="100%" stopColor="#1558e8" />
        </linearGradient>
        <mask id={maskId}>
          <rect width="40" height="40" rx="11" fill="#fff" />
          <path d="M20 9.5 30.5 20 20 30.5 9.5 20Z" fill="#000" />
        </mask>
      </defs>
      <rect
        width="40"
        height="40"
        rx="11"
        fill={`url(#${gradientId})`}
        mask={`url(#${maskId})`}
      />
    </svg>
  )
}

export function BrandMark({
  href,
  size = 'md',
  showProduct = false,
  className = '',
}: BrandMarkProps) {
  const content = (
    <>
      <AestimaPictogram className="brand-pictogram" />
      <span className="brand-wordmark">aestima</span>
      {showProduct ? <span className="brand-product">Parts Finder</span> : null}
    </>
  )

  const classes = ['brand-mark', `brand-mark--${size}`, className].filter(Boolean).join(' ')

  if (href) {
    return (
      <a className={classes} href={href} aria-label="Aestima Parts Finder">
        {content}
      </a>
    )
  }

  return (
    <div className={classes} role="img" aria-label="aestima">
      {content}
    </div>
  )
}
