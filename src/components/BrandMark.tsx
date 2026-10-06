import logo from '../assets/aftercore-lockup.png'

type BrandMarkProps = {
  href?: string
  size?: 'md' | 'lg'
  className?: string
}

export function BrandMark({ href, size = 'md', className = '' }: BrandMarkProps) {
  const classes = ['brand-mark', `brand-mark--${size}`, className].filter(Boolean).join(' ')
  const image = <img src={logo} alt="" />

  if (href) {
    return (
      <a className={classes} href={href} aria-label="Aftercore">
        {image}
      </a>
    )
  }

  return (
    <div className={classes} role="img" aria-label="Aftercore">
      {image}
    </div>
  )
}
