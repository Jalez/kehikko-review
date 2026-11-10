/* Writes `kehikot.rows.json` from the real footer (`src/view/rows.ts`), for `kehikot-check-rows`. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { rowsStates } from '../src/rows.ts'

writeFileSync(join(import.meta.dir, '..', 'kehikot.rows.json'), `${JSON.stringify(rowsStates(), null, 2)}\n`)
