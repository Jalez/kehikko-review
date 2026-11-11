import { GlobalRegistrator } from '@happy-dom/global-registrator'

/* A document for the tests that render one; the pure tests do not care. */
GlobalRegistrator.register()

/* The host's `is-project` answer, which every door asks before it works on a folder. */
import './host.ts'
