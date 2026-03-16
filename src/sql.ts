import type { PGlite, Transaction } from '@electric-sql/pglite'
import type { PGliteWorker } from '@electric-sql/pglite/worker'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  CollectionConfig,
  DeleteMutationFnParams,
  InsertMutationFnParams,
  PendingMutation,
  SyncConfig,
  UpdateMutationFnParams,
} from '@tanstack/db'
import type { PgliteUtils } from './utils'

function quoteId(name: string) {
  // eslint-disable-next-line e18e/prefer-static-regex
  return `"${String(name).replace(/"/g, '""')}"`
}

type Output<T extends StandardSchemaV1> = StandardSchemaV1.InferOutput<T>

type SyncParams<ItemType extends Record<string, unknown>> = Parameters<SyncConfig<ItemType, string>['sync']>[0]

export function sqlCollectionOptions<
  Schema extends StandardSchemaV1<Record<string, unknown>>,
>({
  startSync = true,
  ...config
}: {
  db: PGlite | PGliteWorker
  startSync?: boolean
  tableName: string
  primaryKeyColumn: Extract<keyof Output<Schema>, string>
  schema: Schema
  getKey?: (row: Output<Schema>) => string
  prepare?: () => Promise<unknown> | unknown
  sync?: (params: Pick<SyncParams<Output<Schema>>, 'write' | 'collection'>) => Promise<void>
  onInsert?: (params: InsertMutationFnParams<Output<Schema>, string>) => Promise<void>
  onUpdate?: (params: UpdateMutationFnParams<Output<Schema>, string>) => Promise<void>
  onDelete?: (params: DeleteMutationFnParams<Output<Schema>, string>) => Promise<void>
}): CollectionConfig<Output<Schema>, string, Schema, PgliteUtils> & {
  schema: typeof config.schema
} {
  type SyncParamsType = SyncParams<Output<Schema>>
  let resolvers = Promise.withResolvers()
  const table = quoteId(config.tableName)
  const primaryKey = quoteId(config.primaryKeyColumn)
  const getKey = config.getKey ?? ((row: Output<Schema>) => String(row[config.primaryKeyColumn]))

  const { promise: syncParams, resolve: resolveSyncParams } = Promise.withResolvers<SyncParamsType>()

  async function runSelect(client: PGlite | PGliteWorker | Transaction): Promise<Output<Schema>[]> {
    const result = await client.query(`SELECT * FROM ${table}`)
    return (result.rows ?? []) as Output<Schema>[]
  }

  async function runInsert(client: PGlite | PGliteWorker | Transaction, rows: Output<Schema>[]): Promise<void> {
    for (const row of rows) {
      const cols = Object.keys(row).filter(k => row[k] !== undefined)
      if (cols.length === 0)
        continue
      const columns = cols.map(quoteId).join(', ')
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
      const values = cols.map(c => row[c])
      await client.query(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`, values)
    }
  }

  async function runUpdate(client: PGlite | PGliteWorker | Transaction, id: string, changes: Partial<Output<Schema>>): Promise<void> {
    const entries = Object.entries(changes).filter(([, v]) => v !== undefined) as [string, unknown][]
    if (entries.length === 0)
      return

    const setClause = entries.map(([k], i) => `${quoteId(k)} = $${i + 1}`).join(', ')
    const params = [...entries.map(([, v]) => v), id]

    await client.query(`UPDATE ${table} SET ${setClause} WHERE ${primaryKey} = $${params.length}`, params)
  }

  async function runDelete(client: PGlite | PGliteWorker | Transaction, ids: string[]): Promise<void> {
    if (ids.length === 0)
      return

    await client.query(`DELETE FROM ${table} WHERE ${primaryKey} = ANY($1)`, [ids])
  }

  const getSyncParams = async (): Promise<Pick<SyncParamsType, 'write' | 'collection'>> => {
    const params = await syncParams

    return {
      write: async (p) => {
        params.begin()
        try {
          if (p.type === 'insert') {
            await runInsert(config.db, [p.value as Output<Schema>])
          }
          else if (p.type === 'update') {
            await runUpdate(
              config.db,
              params.collection.getKeyFromItem(p.value),
              p.value as Partial<Output<Schema>>,
            )
          }
          else if (p.type === 'delete') {
            const key = 'key' in p ? p.key : params.collection.getKeyFromItem(p.value)
            await runDelete(config.db, [key])
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

  async function runMutations(mutations: PendingMutation[]): Promise<void> {
    const { begin, write, commit } = await syncParams
    begin()
    mutations.forEach((m) => {
      if (m.type === 'delete') {
        write({ type: 'delete', key: m.key })
      }
      else {
        write({ type: m.type, value: m.modified as Output<Schema> })
      }
    })
    commit()
  }

  return {
    startSync,
    sync: {
      sync: (params) => {
        resolveSyncParams(params as SyncParamsType)

        resolvers = Promise.withResolvers()

        ;(async () => {
          try {
            await config.prepare?.()
            params.begin()
            const rows = await runSelect(config.db)
            rows.forEach((row) => {
              params.write({ type: 'insert', value: row })
            })
            params.commit()
            if (config.sync && startSync) {
              await config.sync(await getSyncParams())
              resolvers.resolve(undefined)
            }
          }
          finally {
            params.markReady()
          }
        })()
      },
    },
    gcTime: 0,
    schema: config.schema,
    getKey,
    onInsert: async (params) => {
      await config.db.transaction(async (tx) => {
        await runInsert(tx, params.transaction.mutations.map(m => m.modified as Output<Schema>))
        if (config.onInsert) {
          await config.onInsert(params)
        }
      })
      await runMutations(params.transaction.mutations as PendingMutation[])
    },
    onUpdate: async (params) => {
      await config.db.transaction(async (tx) => {
        await Promise.all(
          params.transaction.mutations.map(m =>
            runUpdate(tx, m.key, m.changes as Partial<Output<Schema>>),
          ),
        )
        if (config.onUpdate) {
          await config.onUpdate(params)
        }
      })
      await runMutations(params.transaction.mutations as PendingMutation[])
    },
    onDelete: async (params) => {
      await config.db.transaction(async (tx) => {
        await runDelete(tx, params.transaction.mutations.map(m => m.key))
        if (config.onDelete) {
          await config.onDelete(params)
        }
      })
      await runMutations(params.transaction.mutations as PendingMutation[])
    },
    utils: {
      runSync: async () => {
        if (!config.sync) {
          throw new Error('Sync is not defined')
        }

        const params = await getSyncParams()

        await params.collection.stateWhenReady()

        await config.sync(params)
      },
      waitForSync: async () => {
        await resolvers.promise
      },
    },
  }
}
