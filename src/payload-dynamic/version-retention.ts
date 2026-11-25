import {
  APIError,
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionSlug,
  type Field,
  hasDraftsEnabled,
} from 'payload'
import { referenceID } from './entry-values'

const fieldName = 'versionsMaxPerEntry'

export const versionRetentionField: Field = {
  name: fieldName,
  type: 'number',
  label: 'Maximum versions per entry',
  min: 0,
  max: 2_147_483_646,
  validate: (value: unknown) =>
    value == null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_646)
      ? true
      : 'Enter a whole number from zero to 2147483646.',
  admin: { description: 'Leave blank or enter zero to retain all versions.' },
}

export const requireVersionRetentionTransaction: CollectionBeforeChangeHook = async ({
  data,
  req,
}) => {
  if (req.operation !== 'validate' && (await req.transactionID) == null) {
    throw new APIError('Version retention by definition requires a database transaction.', 400)
  }
  return data
}

export const retainEntryVersions =
  (definitionSlug: CollectionSlug): CollectionAfterChangeHook =>
  async ({ collection, doc, req }) => {
    const parent = { equals: doc.id }
    const entry = await req.payload.findByID({
      collection: collection.slug,
      id: doc.id,
      depth: 0,
      draft: hasDraftsEnabled(collection),
      overrideAccess: true,
      req,
      select: { definition: true },
    })
    const definitionID = referenceID(Reflect.get(entry, 'definition'))
    if (definitionID === undefined)
      throw new Error('Entry has no definition for version retention.')
    const selection = { id: true, [fieldName]: true } as const
    const definition = await req.payload.findByID({
      collection: definitionSlug,
      id: definitionID,
      depth: 0,
      overrideAccess: true,
      req,
      select: selection,
    })
    const limit: unknown = Reflect.get(definition, fieldName)
    if (typeof limit !== 'number' || limit === 0) return doc

    const {
      docs: [lastRetained],
    } = await req.payload.db.findVersions({
      collection: collection.slug,
      where: { parent },
      req,
      page: limit,
      limit: 1,
      pagination: false,
      sort: '-updatedAt',
      select: { updatedAt: true },
    })
    if (!lastRetained) return doc
    await req.payload.db.deleteVersions({
      collection: collection.slug,
      req,
      where: {
        parent,
        // Keep ties to avoid removing the just-written version when IDs are UUIDs.
        updatedAt: { less_than: lastRetained.updatedAt },
      },
    })
    return doc
  }
