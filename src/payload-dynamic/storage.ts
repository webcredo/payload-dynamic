import { createTableName, type DrizzleAdapter, type RawTable } from '@payloadcms/drizzle'
import type { CollectionSlug } from 'payload'

export function createStorageNames(prefix?: string) {
  if (
    prefix !== undefined &&
    (typeof prefix !== 'string' || !/^[a-z][a-z0-9]{0,7}$/.test(prefix))
  ) {
    throw new Error(
      'payload-dynamic storagePrefix must be 1–8 lowercase letters or digits, starting with a letter.',
    )
  }

  const name = (base: string) => `${prefix ?? 'collection'}_${base}`
  return {
    definitions: name('definitions'),
    entries: name('entries'),
    nestedDefinitions: (depth: number) => name(`def_fields_l${depth}`),
    entryRows: (depth: number) => name(`entry_rows_${depth}`),
    entryItems: (depth: number) => name(`entry_items_${depth}`),
    numberIndex: name('values_key_number_parent_idx'),
  }
}

export type StorageNames = ReturnType<typeof createStorageNames>

/** Some adapter children, including relationship tables, bypass tableNameMap. */
function protectRawTables(
  adapter: Pick<DrizzleAdapter, 'rawTables'>,
  reserved: (name: string) => boolean,
) {
  const property = Object.getOwnPropertyDescriptor(adapter, 'rawTables')
  let tables = adapter.rawTables
  const wrap = (source: Record<string, RawTable> | undefined) => {
    if (!source) return source
    const keys = new Map(Object.keys(source).map((name) => [name.toLowerCase(), name]))
    return new Proxy(source, {
      set(target, key, value) {
        if (typeof key === 'string' && reserved(key)) {
          const normalized = key.toLowerCase()
          const previous = keys.get(normalized)
          if (
            previous !== undefined &&
            Object.hasOwn(target, previous) &&
            (previous !== key || target[previous] !== value)
          ) {
            throw new Error(
              `payload-dynamic SQL table "${key}" conflicts with "${previous}". Configure an unused storagePrefix.`,
            )
          }
          keys.set(normalized, key)
        }
        return Reflect.set(target, key, value)
      },
    })
  }
  let guarded = wrap(tables)
  Object.defineProperty(adapter, 'rawTables', {
    configurable: true,
    enumerable: property?.enumerable ?? true,
    get: () => guarded,
    set(next: Record<string, RawTable>) {
      // Compose with another namespace guard when a host uses multiple instances.
      property?.set?.call(adapter, next)
      tables = property?.get?.call(adapter) ?? next
      guarded = wrap(tables)
    },
  })
  return () => {
    if (property && !('value' in property)) {
      Object.defineProperty(adapter, 'rawTables', property)
    } else {
      Object.defineProperty(adapter, 'rawTables', {
        configurable: true,
        enumerable: true,
        writable: true,
        ...property,
        value: tables,
      })
    }
  }
}

function assertEnumTableNames(
  rawTables: Record<string, RawTable>,
  reserved: (name: string) => boolean,
) {
  const names = new Set(
    Object.keys(rawTables)
      .filter(reserved)
      .map((name) => name.toLowerCase()),
  )
  const optionsByName = new Map<string, string>()
  for (const table of Object.values(rawTables)) {
    for (const column of Object.values(table.columns)) {
      if (column.type !== 'enum' || !('enumName' in column) || !reserved(column.enumName)) continue
      const name = column.enumName.toLowerCase()
      if (names.has(name)) {
        throw new Error(
          `payload-dynamic SQL enum "${column.enumName}" conflicts with a table of the same name. Configure an unused storagePrefix.`,
        )
      }
      const options = JSON.stringify(column.options)
      const previous = optionsByName.get(name)
      if (previous !== undefined && previous !== options) {
        throw new Error(
          `payload-dynamic SQL enum "${column.enumName}" has conflicting options. Configure an unused storagePrefix.`,
        )
      }
      optionsByName.set(name, options)
    }
  }
}

/** Reserve the SQL namespace while Payload initializes the adapter, before it connects. */
export function protectStorageNamespace(
  adapter: Pick<
    DrizzleAdapter,
    'init' | 'name' | 'payload' | 'rawTables' | 'tableNameMap' | 'versionsSuffix'
  >,
  prefix: string,
  definitionSlug: CollectionSlug,
  entrySlug: CollectionSlug,
  storage: StorageNames,
) {
  const initialize = adapter.init
  if (!initialize) return
  const roots = [prefix, `_${prefix}`, `enum_${prefix}`, `enum__${prefix}`]
  const reserved = (name: string) => {
    // Quoting does not make SQLite identifiers case-sensitive.
    const normalized = name.toLowerCase()
    return roots.some((root) => normalized === root || normalized.startsWith(`${root}_`))
  }
  const collision = (name: string, owner: string) =>
    new Error(
      `payload-dynamic SQL name "${name}" conflicts with storagePrefix "${prefix}" in "${owner}". Configure an unused storagePrefix.`,
    )

  adapter.init = async () => {
    const { collections, globals } = adapter.payload.config
    const names = { tableNameMap: new Map<string, string>() }
    const keyOf = (slug: string) => createTableName({ adapter: names, config: { slug } })
    const aliases = new Map<string, string>()
    for (const [slug, table] of [
      [definitionSlug, storage.definitions],
      [entrySlug, storage.entries],
    ]) {
      const key = keyOf(slug)
      const suffix = adapter.versionsSuffix ?? '_v'
      aliases.set(key, table)
      aliases.set(`_${key}${suffix}`, `_${table}${suffix}`)
    }
    for (const host of [...collections, ...globals]) {
      if (host.slug === definitionSlug || host.slug === entrySlug) continue
      const key = keyOf(host.slug)
      if (reserved(key)) throw collision(key, host.slug)
    }

    const registry = adapter.tableNameMap
    const originalSet = registry.set
    const descriptor = Object.getOwnPropertyDescriptor(registry, 'set')
    const restoreTables = protectRawTables(adapter, reserved)
    try {
      // The adapter records evaluated dbName/enumName callbacks here. Guard
      // the result without modifying the host's shared sanitized config.
      registry.set = (key, value) => {
        if (reserved(value) && !reserved(key) && aliases.get(key) !== value) {
          throw collision(value, key)
        }
        const previous = registry.get(key)
        if (
          previous !== undefined &&
          previous !== value &&
          (reserved(key) || reserved(previous) || reserved(value))
        ) {
          throw new Error(
            `payload-dynamic SQL registration "${key}" conflicts between "${previous}" and "${value}". Configure distinct host names and plugin slugs.`,
          )
        }
        return originalSet.call(registry, key, value)
      }

      await initialize.call(adapter)
      if (adapter.name === 'postgres') assertEnumTableNames(adapter.rawTables, reserved)
    } finally {
      if (descriptor) Object.defineProperty(registry, 'set', descriptor)
      else Reflect.deleteProperty(registry, 'set')
      restoreTables()
    }
  }
}
