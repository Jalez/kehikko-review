import './index.css'

/* For its side effect: installs the mailbox before React mounts, so a host's
   greeting that arrives early is held rather than lost. */
import 'kehikot-module-protocol/client'
import { mountPage } from 'kehikot-module-protocol/client/mount'

import { App } from './app.tsx'

/* The protocol's entry (2.70.0): StrictMode, and ReportErrors around the page, so a render that
   throws is said to the host; a missing root is said too, not left blank. */
mountPage('root', <App />)
