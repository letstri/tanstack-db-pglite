import type { PGlite, Transaction } from '@electric-sql/pglite'
import type { PGliteWorker } from '@electric-sql/pglite/worker'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { CollectionConfig, DeleteMutationFnParams, InsertMutationFnParams, PendingMutation, SyncConfig, UpdateMutationFnParams } from '@tanstack/db'
import type { PgliteUtils } from './utils'
import {
  BasicIndex,

} from '@tanstack/db'

function quoteId(name: string) {
  // eslint-disable-next-line e18e/prefer-static-regex
  return `"${String(name).replace(/"/g, '""')}"`
}

type Output<T extends StandardSchemaV1> = StandardSchemaV1.InferOutput<T>

type SyncParams<ItemType extends Record<string, unknown>> = Parameters<SyncConfig<ItemType, string>['sync']>[0]

/**
 * Creates collection options backed by raw SQL on PGlite.
 *
 * The adapter loads initial data from PGlite before invoking the user-provided `sync` callback.
 * If your sync establishes a real-time subscription, events emitted during the initial PGlite
 * read may be missed. To avoid data loss, subscribe to real-time events first and buffer them
 * until `markReady()` is called.
 */
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
  rowUpdateMode?: 'partial' | 'full'
  schema: Schema
  getKey?: (row: Output<Schema>) => string
  prepare?: () => Promise<unknown> | unknown
  sync?: (params: Pick<SyncParams<Output<Schema>>, 'write' | 'collection' | 'markReady' | 'metadata'>) => Promise<(() => void) | void>
  onInsert?: (params: InsertMutationFnParams<Output<Schema>, string>) => Promise<void>
  onUpdate?: (params: UpdateMutationFnParams<Output<Schema>, string>) => Promise<void>
  onDelete?: (params: DeleteMutationFnParams<Output<Schema>, string>) => Promise<void>
}): CollectionConfig<Output<Schema>, string, Schema, PgliteUtils> & {
  schema: typeof config.schema
} {
  type SyncParamsType = SyncParams<Output<Schema>>
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

  const sync = async (force = false): Promise<(() => void) | void> => {
    const params = await syncParams

    if (force) {
      params.truncate()
    }

    if (!config.sync) {
      params.markReady()
      return
    }

    return config.sync(
      {
        write: async (p) => {
          if (p.type === 'insert') {
            await runInsert(config.db, [p.value])
          }
          else if (p.type === 'update') {
            await runUpdate(
              config.db,
              params.collection.getKeyFromItem(p.value),
              p.value,
            )
          }
          else if (p.type === 'delete') {
            const key = 'key' in p ? p.key : params.collection.getKeyFromItem(p.value)
            await runDelete(config.db, [key])
          }
          params.begin()
          params.write(p)
          params.commit()
        },
        collection: params.collection,
        markReady: params.markReady,
        ...(params.metadata && { metadata: params.metadata }),
      },
    )
  }

  return {
    startSync,
    autoIndex: 'eager',
    defaultIndexType: BasicIndex,
    sync: {
      ...(config.rowUpdateMode && { rowUpdateMode: config.rowUpdateMode }),
      sync: (params) => {
        resolveSyncParams(params as SyncParamsType)

        let cleanup: (() => void) | undefined

        ;(async () => {
          await config.prepare?.()
          const rows = await runSelect(config.db)
          params.begin()
          rows.forEach((row) => {
            params.write({ type: 'insert', value: row })
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
    schema: config.schema,
    getKey,
    onInsert: async (params) => {
      await config.db.transaction(async (tx) => {
        await runInsert(tx, params.transaction.mutations.map(m => m.modified))
        if (config.onInsert) {
          await config.onInsert(params)
        }
      })
      await runMutations(params.transaction.mutations)
    },
    onUpdate: async (params) => {
      await config.db.transaction(async (tx) => {
        await Promise.all(
          params.transaction.mutations.map(m => runUpdate(tx, m.key, m.changes)),
        )
        if (config.onUpdate) {
          await config.onUpdate(params)
        }
      })
      await runMutations(params.transaction.mutations)
    },
    onDelete: async (params) => {
      await config.db.transaction(async (tx) => {
        await runDelete(tx, params.transaction.mutations.map(m => m.key))
        if (config.onDelete) {
          await config.onDelete(params)
        }
      })
      await runMutations(params.transaction.mutations)
    },
    utils: {
      runSync: async () => {
        if (!config.sync) {
          throw new Error('Sync is not defined')
        }

        const params = await syncParams
        await params.collection.stateWhenReady()

        await sync(true)
      },
    },
  }
}
