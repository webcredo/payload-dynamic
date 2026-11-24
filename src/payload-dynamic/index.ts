import type { PostgresAdapter } from '@payloadcms/db-postgres'
import type { SQLiteAdapter } from '@payloadcms/db-sqlite'
import { createTableName, type RawRelation, type RawTable } from '@payloadcms/drizzle'
import {
  type Access,
  APIError,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type CollectionSlug,
  type Config,
  type Plugin,
} from 'payload'
import type { PayloadDynamicAccess, PayloadDynamicWorkspace } from './access'
import { definitionCollection, definitionDepth } from './definitions'
import { entryCollection, entryValueReferences } from './entries'
import { createStorageNames, protectStorageNamespace, type StorageNames } from './storage'

// SQL adapters store Array rows in their own table. CollectionConfig.indexes
// applies to the parent table; this index covers a range on a single field key.
function prepareNativeCollectionSchema<Schema>(
  storage: StorageNames,
  {
    adapter,
    schema,
  }: {
    // The SQLite hook receives the adapter at runtime in beta.9.
    adapter?: {
      rawRelations: Record<string, Record<string, RawRelation>>
      rawTables: Record<string, RawTable>
      versionsSuffix?: string
    }
    schema: Schema
  },
): Schema {
  const table = adapter?.rawTables[`${storage.entries}_values`]
  if (table) {
    const name = storage.numberIndex
    table.indexes = {
      ...table.indexes,
      [name]: { name, on: ['fieldKey', 'numberValue', '_parentID'] },
    }
  }

  // Drizzle must distinguish the parent and child links when both arrays are named fields.
  if (adapter) {
    const { rawRelations, rawTables, versionsSuffix = '_v' } = adapter
    // The definition hook supplies a label before saving, including when the form leaves it blank.
    for (const tableName of [
      `${storage.definitions}_fields`,
      `_${storage.definitions}${versionsSuffix}_version_fields`,
    ]) {
      const label = rawTables[tableName]?.columns.label
      if (label) label.notNull = true
    }

    for (let depth = 1; depth <= definitionDepth; depth++) {
      const tableName = storage.nestedDefinitions(depth)
      for (const child of [tableName, `_${tableName}${versionsSuffix}`]) {
        const toParent = rawRelations[child]?._parentID
        if (!toParent) continue
        const toChild = Object.values(rawRelations[toParent.to] ?? {}).find(
          (relation) => relation.type === 'many' && relation.to === child,
        )
        if (toChild) {
          toChild.relationName = child
          toParent.relationName = child
        }
      }
    }
  }
  return schema
}

const preservePostgresJSONStrings =
  (storage: StorageNames): PostgresAdapter['afterSchemaInit'][number] =>
  ({ adapter, schema }) => {
    const suffix = adapter.versionsSuffix ?? '_v'
    const tables = [`${storage.entries}_values`, `_${storage.entries}${suffix}_version_values`]
    for (let depth = 1; depth <= definitionDepth; depth++) {
      const table = storage.entryItems(depth)
      tables.push(table, `_${table}${suffix}`)
    }
    for (const table of tables) {
      const column = schema.tables[table]?.jsonValue
      if (column) {
        // The PostgreSQL driver already decodes JSON in Array results. Drizzle's
        // decoder otherwise interprets JSON-looking string values a second time.
        column.mapFromDriverValue = (value: unknown) => value
      }
    }
    return schema
  }

const preventReferencedUploadDeletion =
  (entrySlug: CollectionSlug): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    const { totalDocs } = await req.payload.count({
      collection: entrySlug,
      overrideAccess: true,
      req,
      where: {
        or: entryValueReferences(id, 'uploadValue', 'uploadValues'),
      },
    })
    if (totalDocs) throw new APIError('Remove references to this file before deleting it.', 409)
  }

const preventReferencedWorkspaceDeletion =
  (definitionSlug: CollectionSlug): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    const { totalDocs } = await req.payload.count({
      collection: definitionSlug,
      overrideAccess: true,
      req,
      where: { workspace: { equals: id } },
    })
    if (totalDocs)
      throw new APIError('Delete its dynamic collections before deleting this workspace.', 409)
  }

export type { PayloadDynamicAccess, PayloadDynamicWorkspace } from './access'

type CollectionOverrides = {
  access?: PayloadDynamicAccess
  slug?: string
  labels?: CollectionConfig['labels']
}

export type PayloadDynamicOptions = {
  /** Return the host config unchanged when false. */
  enabled?: boolean
  canManage: Access
  uploadCollection?: CollectionSlug
  workspace?: PayloadDynamicWorkspace
  /** Prefix to use for physical SQL storage in a shared database. */
  storagePrefix?: string
  collections?: CollectionOverrides
  entries?: CollectionOverrides
}

const routeSlug = /^[a-zA-Z0-9_-]+$/
const reservedPayloadSlugs = [
  'payload-jobs',
  'payload-jobs-stats',
  'payload-kv',
  'payload-llm-instructions',
  'payload-locked-documents',
  'payload-migrations',
  'payload-preferences',
  'payload-query-presets',
]

function validateNames(
  config: Config,
  definitionSlug: string,
  entrySlug: string,
  storage: StorageNames,
) {
  if (definitionSlug === entrySlug) {
    throw new Error('payload-dynamic requires distinct slugs for definitions and entries.')
  }

  // Both SQL adapters use these normalized keys, even for collections with a custom dbName.
  const adapter = { tableNameMap: new Map<string, string>() }
  const sqlKey = (slug: string) => createTableName({ adapter, config: { slug } })
  const collections = config.collections ?? []
  const reserved = new Set(reservedPayloadSlugs.map(sqlKey))
  if (!config.admin?.user && !collections.some(({ auth }) => auth)) reserved.add(sqlKey('users'))

  const hosts = [...collections, ...(config.globals ?? [])]
  const occupied = new Map(hosts.map(({ slug }) => [sqlKey(slug), slug]))
  for (const host of hosts) {
    const name = host.dbName ?? sqlKey(host.slug)
    if (name === storage.definitions || name === storage.entries) {
      throw new Error(
        `payload-dynamic SQL table "${name}" conflicts with the host "${host.slug}". Configure an unused storagePrefix.`,
      )
    }
  }
  for (const slug of [definitionSlug, entrySlug]) {
    if (typeof slug !== 'string' || !routeSlug.test(slug) || !/[a-zA-Z0-9]/.test(slug)) {
      throw new Error(
        `Invalid payload-dynamic slug "${slug}". Use letters, numbers, hyphens, and underscores.`,
      )
    }
    const key = sqlKey(slug)
    if (slug.startsWith('globals') || reserved.has(key)) {
      throw new Error(`The payload-dynamic slug "${slug}" is reserved by Payload.`)
    }
    const conflictingSlug = occupied.get(key)
    if (conflictingSlug !== undefined) {
      throw new Error(
        `The payload-dynamic slug "${slug}" conflicts with the Payload slug "${conflictingSlug}" in SQL.`,
      )
    }
    occupied.set(key, slug)
  }
}

export function payloadDynamic({
  canManage,
  uploadCollection,
  workspace,
  storagePrefix,
  collections: definitionOptions,
  entries: entryOptions,
  enabled = true,
}: PayloadDynamicOptions): Plugin {
  return (config) => {
    if (!enabled) return config
    const collections = config.collections ?? []
    const definitionSlug = (definitionOptions?.slug ?? 'collections') as CollectionSlug
    const entrySlug = (entryOptions?.slug ?? 'entries') as CollectionSlug
    const storage = createStorageNames(storagePrefix)
    validateNames(config, definitionSlug, entrySlug, storage)
    if (
      uploadCollection &&
      !collections.some(({ slug, upload }) => slug === uploadCollection && upload)
    ) {
      throw new Error('The configured upload target must be a Payload upload collection.')
    }

    if (workspace && !collections.some(({ slug }) => slug === workspace.collection)) {
      throw new Error('The configured workspace must be an existing Payload collection.')
    }

    const slugs = { definitionSlug, entrySlug }
    const options = {
      ...slugs,
      canManage,
      storage,
      postgres: config.db.name === 'postgres',
      uploadCollection,
      workspace,
    }
    const hosts = collections.map((collection) => {
      const guards: CollectionBeforeDeleteHook[] = []
      if (collection.slug === uploadCollection)
        guards.push(preventReferencedUploadDeletion(entrySlug))
      if (collection.slug === workspace?.collection) {
        guards.push(preventReferencedWorkspaceDeletion(definitionSlug))
      }
      return guards.length
        ? {
            ...collection,
            hooks: {
              ...collection.hooks,
              beforeDelete: [...guards, ...(collection.hooks?.beforeDelete ?? [])],
            },
          }
        : collection
    })
    return {
      ...config,
      collections: [
        ...hosts,
        definitionCollection({
          ...options,
          access: definitionOptions?.access,
          labels: definitionOptions?.labels,
        }),
        entryCollection({ ...options, access: entryOptions?.access, labels: entryOptions?.labels }),
      ],
      admin: {
        ...config.admin,
        components: {
          ...config.admin?.components,
          afterNavLinks: [
            ...(config.admin?.components?.afterNavLinks ?? []),
            {
              path: 'payload-dynamic/react/CollectionsNavigation#CollectionsNavigation',
              serverProps: slugs,
            },
          ],
        },
      },
      db: {
        ...config.db,
        init(args) {
          const adapter = config.db.init(args)
          if (storagePrefix && (adapter.name === 'sqlite' || adapter.name === 'postgres')) {
            protectStorageNamespace(
              adapter as SQLiteAdapter | PostgresAdapter,
              storagePrefix,
              definitionSlug,
              entrySlug,
              storage,
            )
          }
          if (adapter.name === 'sqlite') {
            const sqlite = adapter as SQLiteAdapter
            sqlite.beforeSchemaInit = [
              ...sqlite.beforeSchemaInit,
              (args) => prepareNativeCollectionSchema(storage, args),
            ]
          } else if (adapter.name === 'postgres') {
            const postgres = adapter as PostgresAdapter
            postgres.beforeSchemaInit = [
              ...postgres.beforeSchemaInit,
              (args) => prepareNativeCollectionSchema(storage, args),
            ]
            postgres.afterSchemaInit = [
              ...postgres.afterSchemaInit,
              preservePostgresJSONStrings(storage),
            ]
          }
          return adapter
        },
      },
    }
  }
}
