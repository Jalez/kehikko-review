import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GlobalRegistrator } from '@happy-dom/global-registrator'

/* The Review–Factory key is machine-level; no test reaches the real one. */
process.env.KEHIKOT_KEYS_DIR = mkdtempSync(join(tmpdir(), 'kehikko-review-keys-dir-'))

/* A document for the tests that render one; the pure tests do not care. */
GlobalRegistrator.register()

/* The host's `is-project` answer, which every door asks before it works on a folder. */
import './host.ts'
