import { isWebAddress, type AddressOpenResult } from 'kehikot-module-protocol'

/**
 * A link out of this module, handed to the canvas instead of a new tab
 * (protocol 2.16.0, `address.open`).
 *
 * When the host answers `address.open`, a press on a link sends its address to
 * the canvas: a module there that shows pages (the Browser) opens it, and with
 * none the host asks the person whether to open it in their browser or add one.
 * Either way this page does nothing more. With an older host, or an address the
 * protocol would not take, the link does what it always did: a new tab.
 */

export type OpenAddress = (url: string) => Promise<AddressOpenResult | null>

/** Whether a press on a link to `url` is handed to the canvas rather than followed. */
export function handsLink(url: string | null | undefined, open: OpenAddress | null | undefined): url is string {
  return Boolean(open) && isWebAddress(url)
}

/** Whether the page still follows the link itself after handing it over: no answer, or declined. */
export function stillFollow(answer: AddressOpenResult | null): boolean {
  return answer === null || answer.outcome === 'declined'
}

/** Hand the address over, and open a new tab only when the canvas did not take it. */
export function handLink(
  url: string,
  open: OpenAddress,
  fallback: (url: string) => void = (to) => void window.open(to, '_blank', 'noopener,noreferrer'),
): Promise<void> {
  return open(url).then((answer) => {
    if (stillFollow(answer)) fallback(url)
  })
}
