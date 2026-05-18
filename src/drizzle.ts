import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  CollectionConfig,
  DeleteMutationFnParams,
  InsertMutationFnParams,
  PendingMutation,
  SyncConfig,
  UpdateMutationFnParams,
} from '@tanstack/db'
import type { IndexColumn, PgTable, PgTransaction } from 'drizzle-orm/pg-core'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import type { PgliteUtils } from './utils'
import { BasicIndex } from '@tanstack/db'
import { eq, inArray } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-zod'

type Schema<Table extends PgTable> = StandardSchemaV1<Table['$inferSelect'], Table['$inferSelect']>
type SyncParams<Table extends PgTable> = Parameters<SyncConfig<Table['$inferSelect'], string>['sync']>[0]

/**
 * Creates collection options backed by Drizzle ORM on PGlite.
 *
 * The adapter loads initial data from PGlite before invoking the user-provided `sync` callback.
 * If your sync establishes a real-time subscription, events emitted during the initial PGlite
 * read may be missed. To avoid data loss, subscribe to real-time events first and buffer them
 * until `markReady()` is called.
 */
export function drizzleCollectionOptions<
  Table extends PgTable,
>({
  startSync = true,
  ...config
}: {
  // eslint-disable-next-line ts/no-explicit-any
  db: PgliteDatabase<any>
  startSync?: boolean
  table: Table
  primaryColumn: IndexColumn
  rowUpdateMode?: 'partial' | 'full'
  sync?: (params: Pick<SyncParams<Table>, 'write' | 'collection' | 'markReady' | 'metadata'>) => Promise<(() => void) | void>
  prepare?: () => Promise<unknown> | unknown
  onInsert?: (params: InsertMutationFnParams<Table['$inferSelect'], string>) => Promise<void>
  onUpdate?: (params: UpdateMutationFnParams<Table['$inferSelect'], string>) => Promise<void>
  onDelete?: (params: DeleteMutationFnParams<Table['$inferSelect'], string>) => Promise<void>
}): CollectionConfig<Table['$inferSelect'], string, Schema<Table>, PgliteUtils> & {
  schema: Schema<Table>
} {
  type SyncParamsType = SyncParams<Table>
  // Sync params can be null while running PGLite migrations
  const { promise: syncParams, resolve: resolveSyncParams } = Promise.withResolvers<SyncParamsType>()

  // eslint-disable-next-line ts/no-explicit-any
  async function onDrizzleInsert(data: (typeof config.table.$inferInsert)[], tx?: PgTransaction<any, any, any>): Promise<void> {
    // @ts-expect-error drizzle types
    await (tx || config.db).insert(config.table).values(data).catch((e) => {
      if (e instanceof Error && e.cause) {
        throw e.cause
      }

      throw e
    })
  }

  // eslint-disable-next-line ts/no-explicit-any
  async function onDrizzleUpdate(id: string, changes: Partial<typeof config.table.$inferSelect>, tx?: PgTransaction<any, any, any>): Promise<void> {
    await (tx || config.db).update(config.table).set(changes).where(eq(config.primaryColumn, id)).catch((e) => {
      if (e instanceof Error && e.cause) {
        throw e.cause
      }

      throw e
    })
  }

  // eslint-disable-next-line ts/no-explicit-any
  async function onDrizzleDelete(ids: string[], tx?: PgTransaction<any, any, any>): Promise<void> {
    await (tx || config.db).delete(config.table).where(inArray(config.primaryColumn, ids)).catch((e) => {
      if (e instanceof Error && e.cause) {
        throw e.cause
      }

      throw e
    })
  }

  // Mutations should run if everything is okay inside "on" handlers
  async function runMutations(mutations: PendingMutation[]): Promise<void> {
    const { begin, write, commit } = await syncParams
    begin()
    mutations.forEach((m) => {
      if (m.type === 'delete') {
        write({ type: 'delete', key: m.key })
      }
      else {
        write({ type: m.type, value: m.modified })
      }
    })
    commit()
  }

  /**
   * https://github.com/drizzle-team/drizzle-orm/issues/1723
   *
   * Each query in the db using transaction will not be committed
   * So I added this trick to select all changed data from the db
   * Because after select, the transaction will be committed
   *
   * Yeah, it's stupid, but it works
   */
  async function finishTransaction(mutations: PendingMutation[]): Promise<void> {
    await Promise.all(mutations.map(m => config.db
      .select({ id: config.primaryColumn })
      // @ts-expect-error drizzle types
      .from(config.table)
      .where(eq(config.primaryColumn, m.key))))
  }

  const sync = async (): Promise<(() => void) | void> => {
    const params = await syncParams

    if (!config.sync) {
      params.markReady()
      return
    }

    return config.sync({
      write: async (message) => {
        if (message.type === 'insert') {
          await onDrizzleInsert([message.value])
        }
        else if (message.type === 'update') {
          await onDrizzleUpdate(
            params.collection.getKeyFromItem(message.value),
            message.value,
          )
        }
        else if (message.type === 'delete') {
          const key = 'key' in message ? message.key : params.collection.getKeyFromItem(message.value)
          await onDrizzleDelete([key])
        }
        params.begin()
        params.write(message)
        params.commit()
      },
      collection: params.collection,
      markReady: params.markReady,
      ...(params.metadata && { metadata: params.metadata }),
    })
  }

  return {
    startSync: true,
    autoIndex: 'eager',
    defaultIndexType: BasicIndex,
    sync: {
      ...(config.rowUpdateMode && { rowUpdateMode: config.rowUpdateMode }),
      sync: (params) => {
        resolveSyncParams(params as SyncParamsType)

        let cleanup: (() => void) | undefined

        ;(async () => {
          await config.prepare?.()
          // @ts-expect-error drizzle types
          const dbs = await config.db.select().from(config.table)

          params.begin()
          dbs.forEach((db) => {
            params.write({ type: 'insert', value: db })
          })
          params.commit()
          if (startSync) {
            const result = await sync()
            if (typeof result === 'function') {
              cleanup = result
            }
          }
          else {
            params.markReady()
          }
        })()

        return () => {
          cleanup?.()
        }
      },
    },
    schema: createSelectSchema(config.table),
    getKey: t => t[config.primaryColumn.name] as string,
    onInsert: async (params) => {
      await config.db.transaction(async (tx) => {
        await onDrizzleInsert(params.transaction.mutations.map(m => m.modified), tx)
        if (config.onInsert) {
          await config.onInsert(params)
        }
      })
      await finishTransaction(params.transaction.mutations)
      await runMutations(params.transaction.mutations)
    },
    onUpdate: async (params) => {
      await config.db.transaction(async (tx) => {
        await Promise.all(params.transaction.mutations.map(m => onDrizzleUpdate(m.key, m.changes, tx)))
        if (config.onUpdate) {
          await config.onUpdate(params)
        }
      })
      await finishTransaction(params.transaction.mutations)
      await runMutations(params.transaction.mutations)
    },
    onDelete: async (params) => {
      await config.db.transaction(async (tx) => {
        await onDrizzleDelete(params.transaction.mutations.map(m => m.key), tx)
        if (config.onDelete) {
          await config.onDelete(params)
        }
      })
      await finishTransaction(params.transaction.mutations)
      await runMutations(params.transaction.mutations)
    },
    utils: {
      runSync: async () => {
        if (!config.sync) {
          throw new Error('Sync is not defined')
        }

        const params = await syncParams
        await params.collection.stateWhenReady()

        await sync()
      },
    },
  }
}
