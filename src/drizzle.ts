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
import { eq, inArray } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-zod'

export function drizzleCollectionOptions<
  Table extends PgTable,
  SyncParams extends Parameters<SyncConfig<Table['$inferSelect'], string>['sync']>[0] = Parameters<SyncConfig<Table['$inferSelect'], string>['sync']>[0],
>({
  startSync = true,
  ...config
}: {
  // eslint-disable-next-line ts/no-explicit-any
  db: PgliteDatabase<any>
  table: Table
  primaryColumn: IndexColumn
  onInsert?: (params: InsertMutationFnParams<Table['$inferSelect'], string>) => Promise<void>
  onUpdate?: (params: UpdateMutationFnParams<Table['$inferSelect'], string>) => Promise<void>
  onDelete?: (params: DeleteMutationFnParams<Table['$inferSelect'], string>) => Promise<void>
  startSync?: boolean
  prepare?: () => Promise<unknown> | unknown
  sync?: (params: Pick<SyncParams, 'write' | 'collection'>) => Promise<void>
}): CollectionConfig<Table['$inferSelect'], string> & {
  utils: {
    runSync: () => Promise<void>
  }
} {
  // Sync params can be null while running PGLite migrations
  const { promise: syncParams, resolve: resolveSyncParams } = Promise.withResolvers<SyncParams>()

  // eslint-disable-next-line ts/no-explicit-any
  async function onDrizzleInsert(data: (typeof config.table.$inferInsert)[], tx?: PgTransaction<any, any, any>): Promise<void> {
    // @ts-expect-error drizzle types
    await (tx || config.db).insert(config.table).values(data)
  }

  // eslint-disable-next-line ts/no-explicit-any
  async function onDrizzleUpdate(id: string, changes: Partial<typeof config.table.$inferSelect>, tx?: PgTransaction<any, any, any>): Promise<void> {
    await (tx || config.db).update(config.table).set(changes).where(eq(config.primaryColumn, id))
  }

  // eslint-disable-next-line ts/no-explicit-any
  async function onDrizzleDelete(ids: string[], tx?: PgTransaction<any, any, any>): Promise<void> {
    await (tx || config.db).delete(config.table).where(inArray(config.primaryColumn, ids))
  }

  const getSyncParams = async (): Promise<Pick<SyncParams, 'write' | 'collection'>> => {
    const params = await syncParams

    return {
      write: async (p) => {
        params.begin()
        try {
          if (p.type === 'insert') {
            await onDrizzleInsert([p.value])
          }
          else if (p.type === 'update') {
            await onDrizzleUpdate(
              params.collection.getKeyFromItem(p.value),
              p.value,
            )
          }
          else if (p.type === 'delete') {
            await onDrizzleDelete([params.collection.getKeyFromItem(p.value)])
          }
          params.write(p)
        }
        finally {
          params.commit()
        }
      },
      collection: params.collection,
    }
  }

  // Mutations should run if everything is okay inside "on" handlers
  async function runMutations(mutations: PendingMutation[]): Promise<void> {
    const { begin, write, commit } = await syncParams
    begin()
    mutations.forEach((m) => {
      write({ type: m.type, value: m.modified })
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

  return {
    startSync: true,
    sync: {
      sync: (params) => {
        resolveSyncParams(params as SyncParams)

        ;(async () => {
          try {
            await config.prepare?.()
            params.begin()
            // @ts-expect-error drizzle types
            const dbs = await config.db.select().from(config.table)
            dbs.forEach((db) => {
              params.write({ type: 'insert', value: db })
            })
            params.commit()
            if (config.sync && startSync) {
              await config.sync(await getSyncParams())
            }
          }
          finally {
            params.markReady()
          }
        })()
      },
    },
    gcTime: 0,
    // @ts-expect-error wrong types
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

        const params = await getSyncParams()

        // To wait the first sync
        await params.collection.stateWhenReady()

        await config.sync(params)
      },
    },
  }
}
