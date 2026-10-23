import { createContext, useContext, type ReactNode } from 'react'

import { handLink, handsLink, type OpenAddress } from '@/lib/links'

/**
 * How a link out of Review is opened: handed to the canvas (`address.open`) when
 * the host answers it, else `null` and a new tab. Provided once, by the screen.
 */
export const OpenAddressContext = createContext<OpenAddress | null>(null)

/**
 * A link to a page outside this module — a change on its tracker, a posted
 * comment, a source an agent cited, a picture. An ordinary new-tab link, with
 * `noreferrer` as well as `noopener` (a referrer would tell the tracker which
 * host somebody is reading from); when the canvas can take the address, a
 * press hands it over instead, and a module there that shows pages opens it.
 */
export function OutLink({ href, children, className = 'underline underline-offset-2' }: { href: string; children: ReactNode; className?: string }) {
  const open = useContext(OpenAddressContext)
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!handsLink(href, open) || !open) return
        event.preventDefault()
        void handLink(href, open)
      }}
    >
      {children}
    </a>
  )
}
