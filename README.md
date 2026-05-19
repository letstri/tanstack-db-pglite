# tanstack-db-pglite

A seamless integration between [TanStack DB](https://tanstack.com/db) and [PGLite](https://github.com/electric-sql/pglite) with optional [Drizzle ORM](https://orm.drizzle.team/) support for browser-based database management.

## Installation

```bash
npm install tanstack-db-pglite @tanstack/db @electric-sql/pglite
```

> **Note:** `@tanstack/db` and `@electric-sql/pglite` are peer dependencies. `drizzle-orm` is an optional peer dependency required only when using `drizzleCollectionOptions`.

## APIs

This package exports two collection option creators:

- `drizzleCollectionOptions` — uses Drizzle ORM on top of PGlite
- `sqlCollectionOptions` — uses raw SQL queries directly on PGlite

Both follow the TanStack DB [collection options creator](https://tanstack.com/db/latest/docs/guides/collection-options-creator) pattern.

## Quick Start (Drizzle)

```typescript
import { PGlite } from '@electric-sql/pglite'
import { createCollection } from '@tanstack/react-db'
import { drizzle } from 'drizzle-orm/pglite'
import { drizzleCollectionOptions } from 'tanstack-db-pglite'
import { chats } from '~/drizzle'

const pglite = new PGlite()
const db = drizzle(pglite)

export const chatsCollection = createCollection(drizzleCollectionOptions({
  db,
  table: chats,
  primaryColumn: chats.id,
  prepare: async () => {
    await waitForMigrations()
  },
  sync: async ({ write, markReady }) => {
    const eventSource = new EventSource('/api/chats/sync')

    eventSource.onmessage = (event) => {
      const item = JSON.parse(event.data)
      write(item)
    }

    eventSource.addEventListener('ready', () => markReady())

    return () => {
      eventSource.close()
    }
  },
  onInsert: async (params) => {
    await saveInCloud(params)
  },
  onUpdate: async (params) => {
    await updateInCloud(params)
  },
  onDelete: async (params) => {
    await deleteInCloud(params)
  },
}))
```

## Quick Start (Raw SQL)

```typescript
import { PGlite } from '@electric-sql/pglite'
import { createCollection } from '@tanstack/react-db'
import { sqlCollectionOptions } from 'tanstack-db-pglite'
import { z } from 'zod'

const pglite = new PGlite()

const chatSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
})

export const chatsCollection = createCollection(sqlCollectionOptions({
  db: pglite,
  tableName: 'chats',
  primaryKeyColumn: 'id',
  schema: chatSchema,
  prepare: async () => {
    await pglite.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      )
    `)
  },
  sync: async ({ write, markReady }) => {
    const eventSource = new EventSource('/api/chats/sync')

    eventSource.onmessage = (event) => {
      const item = JSON.parse(event.data)
      write(item)
    }

    eventSource.addEventListener('ready', () => markReady())

    return () => {
      eventSource.close()
    }
  },
}))
```

## Options

### Common Options

| Option | Type | Description |
|--------|------|-------------|
| `startSync` | `boolean` | Whether to run the `sync` callback automatically on startup. Defaults to `true`. When `false`, use `collection.utils.runSync()` to trigger manually. |
| `prepare` | `() => Promise<unknown> \| unknown` | Runs before the initial data load (e.g., run migrations). |
| `sync` | `(params) => Promise<(() => void) \| void>` | Sync callback receiving `write`, `markReady`, `collection`, and `metadata`. Return a cleanup function to close subscriptions. |
| `rowUpdateMode` | `'partial' \| 'full'` | Whether sync updates contain partial changes or full row replacements. |
| `onInsert` | `(params) => Promise<void>` | Called when a row is inserted optimistically. Persist to your backend here. |
| `onUpdate` | `(params) => Promise<void>` | Called when a row is updated optimistically. Persist to your backend here. |
| `onDelete` | `(params) => Promise<void>` | Called when a row is deleted optimistically. Persist to your backend here. |

### `drizzleCollectionOptions` Specific

| Option | Type | Description |
|--------|------|-------------|
| `db` | `PgliteDatabase` | Drizzle PGlite database instance. |
| `table` | `PgTable` | Drizzle table definition. |
| `primaryColumn` | `IndexColumn` | The primary key column from the table. |

### `sqlCollectionOptions` Specific

| Option | Type | Description |
|--------|------|-------------|
| `db` | `PGlite \| PGliteWorker` | PGlite instance (or worker). |
| `tableName` | `string` | SQL table name. |
| `primaryKeyColumn` | `string` | Name of the primary key column. |
| `schema` | `StandardSchemaV1` | A Standard Schema (e.g., Zod) for the row type. |
| `getKey` | `(row) => string` | Custom key extractor. Defaults to `row[primaryKeyColumn]`. |

## Utilities

Both adapters expose a `utils` object on the collection:

```typescript
// Manually trigger sync (cleans up any previous sync, then re-syncs)
await chatsCollection.utils.runSync()
```

This is useful when `startSync: false` and you want to control when sync starts (e.g., after authentication).

## Sync Callback

The `sync` callback receives:

- **`write(message)`** — writes a change to both PGlite and the TanStack DB collection. Accepts `{ type: 'insert', value }`, `{ type: 'update', value }`, or `{ type: 'delete', key }`.
- **`markReady()`** — signals that the initial data is loaded and the collection is ready for queries. Must be called once.
- **`collection`** — reference to the collection instance.
- **`metadata`** — persisted sync metadata API for storing resume tokens, cursors, etc.

Return a cleanup function to close long-lived connections (WebSocket, EventSource, etc.) when the collection is destroyed or `runSync()` is called again.

## License

MIT
