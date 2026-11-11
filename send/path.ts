/**
 * Where a review run is sent without the person: the `send` route of the `review.drafts` service this
 * module provides (manifest.ts). Its own file so the manifest, the page's doors and the send's
 * middleware (send/door.ts) name one path without importing each other.
 */
export const SEND_PATH = '/api/drafts/send'
