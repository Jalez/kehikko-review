/**
 * The page at `/app`, built per process rather than read from an `index.html`.
 *
 * The write ticket is minted when the server starts and has to reach the page
 * without a door of its own, so it is printed into the document. `vite.config.ts`
 * runs this through Vite's `transformIndexHtml`, so the dev client is injected as
 * for a file on disk.
 */
const PAGE_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review</title>
</head>
<body>
<div id="root"></div>
<script id="ticket" type="application/json">__TICKET__</script>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>
`

/** The ticket goes in as JSON, so nothing in it can close the script element. */
export function page(ticket: string): string {
  return PAGE_SHELL.replace('__TICKET__', () => JSON.stringify(ticket))
}
