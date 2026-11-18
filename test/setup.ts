/* The shared test preload (protocol 2.104.0): the running app's environment never reaches a test. */
import 'kehikot-module-protocol/testing/setup'

import { GlobalRegistrator } from '@happy-dom/global-registrator'

/* A document for the tests that render one; the pure tests do not care. */
GlobalRegistrator.register()

/* The host's `is-project` answer, which every door asks before it works on a folder. */
import './host.ts'
