/**
 * Where this module would like to answer. Said once, here, and read by `vite.config.ts`,
 * `register.ts` and `skills.ts`. Modules on this machine sit ten apart from 7820 up, so a drift up
 * from one never lands on a neighbour's number; 7960 is History's and 7970–7990 are taken, so this is
 * the next free ten.
 *
 * A PREFERENCE and not a promise: if something holds it, `serves()` moves to the next free port and
 * rewrites the registration to match.
 */
export const PREFERRED_PORT = 8000
