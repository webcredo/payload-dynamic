import type { PostgresAdapter } from '@payloadcms/db-postgres'
import { createTableName, type DrizzleAdapter, operatorMap } from '@payloadcms/drizzle'
import {
  APIError,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  type CollectionSlug,
  type PayloadRequest,
  type Where,
} from 'payload'
import { type ID, referenceID } from './entry-values'
import type { StorageNames } from './storage'

export function assertUploadWorkspaceField(
  upload: CollectionConfig | undefined,
  workspace: CollectionSlug | undefined,
  fieldName: string,
) {
  const field = upload?.fields.find(
    (candidate) => 'name' in candidate && candidate.name === fieldName,
  )
  if (
    !upload?.upload ||
    !workspace ||
    field?.type !== 'relationship' ||
    field.hasMany ||
    field.localized ||
    field.relationTo !== workspace
  ) {
    throw new Error(
      'uploadWorkspaceField must name a single relationship from the upload collection to the configured workspace collection.',
    )
  }
}

export const preserveUploadWorkspace =
  (field: string): CollectionBeforeChangeHook =>
  ({ data, originalDoc }) => {
    const current = referenceID(data[field])
    if (originalDoc?.id !== undefined) {
      const previous = referenceID(originalDoc[field])
      if (data[field] === undefined || (previous === undefined && current === undefined))
        return data
      if (current !== undefined && previous !== undefined && String(current) === String(previous)) {
        return data
      }
      throw new APIError('The workspace of an uploaded file cannot be changed.', 400)
    }
    if (current === undefined) throw new APIError('Choose a workspace for this file.', 400)
    return data
  }

export function uploadWorkspaceFilter(field: string, workspaceID: ID): Where {
  return { [field]: { equals: workspaceID } }
}

export async function lockScopedUploads(
  req: PayloadRequest,
  collection: CollectionSlug,
  ids: ID[],
  operation: 'reference' | 'delete',
) {
  if (operation === 'reference' && req.operation === 'validate') return true
  const adapter = req.payload.db as unknown as DrizzleAdapter
  const transactionID = await req.transactionID
  const transaction = transactionID == null ? undefined : adapter.sessions?.[String(transactionID)]
  if (!transaction) {
    throw new APIError('Workspace uploads require a database transaction.', 400)
  }
  if (adapter.name === 'sqlite') return true
  if (adapter.name !== 'postgres') throw new Error('Unsupported workspace upload adapter.')

  const postgres = adapter as unknown as PostgresAdapter
  const { db } = postgres.sessions[String(transactionID)]
  const key = createTableName({
    adapter: { tableNameMap: new Map() },
    config: { slug: collection },
  })
  const table = postgres.tables[postgres.tableNameMap.get(key) ?? key]
  if (!table) throw new Error('The workspace upload table is unavailable.')
  const where = operatorMap.in(table.id, ids)
  // A same-value write also creates a serialization conflict under snapshot isolation.
  const rows =
    operation === 'reference'
      ? await db.update(table).set({ id: table.id }).where(where).returning({ id: table.id })
      : await db.select({ id: table.id }).from(table).where(where).for('update')
  return rows.length === ids.length
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
}

export async function assertRichTextUploadScope({
  value,
  collection,
  field,
  workspaceID,
  req,
  overrideAccess,
}: {
  value: unknown
  collection: CollectionSlug
  field: string
  workspaceID?: ID
  req: PayloadRequest
  overrideAccess: boolean
}) {
  const root = record(record(value)?.root)
  if (!Array.isArray(root?.children)) return
  const ids = new Map<string, ID>()
  const rejected = () =>
    new APIError('A rich text file is outside this workspace or inaccessible.', 400)
  const nodes: unknown[] = [...root.children]
  while (nodes.length) {
    const node = record(nodes.pop())
    if (!node) continue
    if (Array.isArray(node.children)) {
      for (const child of node.children) nodes.push(child)
    }
    const fields = record(node.fields)
    const ref = node.type === 'link' && fields?.linkType === 'internal' ? record(fields.doc) : node
    const target = ref?.relationTo
    const isUpload =
      typeof target === 'string' &&
      req.payload.collections[target as CollectionSlug]?.config?.upload
    if (
      node.type !== 'upload' &&
      !((node.type === 'relationship' || node.type === 'link') && isUpload)
    ) {
      continue
    }
    const id = referenceID(ref?.value)
    if (workspaceID === undefined || target !== collection || id === undefined) throw rejected()
    ids.set(String(id), id)
  }
  if (ids.size && workspaceID !== undefined) {
    if (!(await lockScopedUploads(req, collection, [...ids.values()], 'reference')))
      throw rejected()
    const { docs } = await req.payload.find({
      collection,
      req,
      overrideAccess,
      depth: 0,
      limit: ids.size,
      select: { id: true },
      where: { id: { in: [...ids.values()] }, ...uploadWorkspaceFilter(field, workspaceID) },
    })
    if (docs.length !== ids.size || docs.some(({ id }) => !ids.has(String(id)))) throw rejected()
  }
}
export async function hasRichTextUploadReference(
  req: PayloadRequest,
  storage: StorageNames,
  depth: number,
  upload: CollectionSlug,
  id: ID,
) {
  if (req.payload.db.name !== 'postgres') return false
  const adapter = req.payload.db as unknown as PostgresAdapter
  const { sql } = await import('@payloadcms/db-postgres')
  const transactionID = await req.transactionID
  const db = transactionID == null ? adapter.drizzle : adapter.sessions[String(transactionID)]?.db
  if (!db) throw new Error('No database connection for the upload reference check.')
  const suffix = adapter.versionsSuffix ?? '_v'
  const names = [`${storage.entries}_values`, `_${storage.entries}${suffix}_version_values`]
  for (let level = 1; level <= depth; level++) {
    const table = storage.entryItems(level)
    names.push(table, `_${table}${suffix}`)
  }
  const path = `lax $.root.children.** ? (
    ((@.type == "upload" || @.type == "relationship") && @.relationTo == $collection &&
      (@.value == $id || @.value == $stringID || @.value.id == $id || @.value.id == $stringID)) ||
    (@.type == "link" && @.fields.linkType == "internal" && @.fields.doc.relationTo == $collection &&
      (@.fields.doc.value == $id || @.fields.doc.value == $stringID ||
        @.fields.doc.value.id == $id || @.fields.doc.value.id == $stringID))
  )`
  const variables = JSON.stringify({ collection: upload, id, stringID: String(id) })
  for (const name of names) {
    const table = adapter.tables[name]
    if (!table?.richTextValue) continue
    const rows = await db
      .select({ found: sql`true` })
      .from(table)
      .where(sql`jsonb_path_exists(${table.richTextValue}, ${path}::jsonpath, ${variables}::jsonb)`)
      .limit(1)
    if (rows.length) return true
  }
  return false
}
