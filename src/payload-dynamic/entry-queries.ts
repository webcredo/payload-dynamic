import { type CollectionSlug, hasDraftsEnabled, type PayloadRequest, type Where } from 'payload'

export async function hasEntryMatching(
  req: PayloadRequest,
  collection: CollectionSlug,
  where: Where,
): Promise<boolean> {
  const query = { collection, req, where, overrideAccess: true }
  if ((await req.payload.count(query)).totalDocs) return true
  if (!hasDraftsEnabled(req.payload.collections[collection].config)) return false

  // Draft reads select the latest version per document. Check main as well so
  // a draft that clears a published value cannot hide that value.
  const { docs } = await req.payload.find({
    ...query,
    draft: true,
    depth: 0,
    limit: 1,
    select: { id: true },
  })
  return docs.length > 0
}
