import type { UtilsRecord } from '@tanstack/db'

export interface PgliteUtils extends UtilsRecord {
  runSync: () => Promise<void>
  waitForSync: () => Promise<void>
}
