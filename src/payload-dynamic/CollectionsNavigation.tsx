import { randomUUID } from 'node:crypto'
import type { ServerProps } from 'payload'
import { DynamicCollectionsNav } from './DynamicCollectionsNav'
import type { CollectionSlugs } from './entry-list'

export function CollectionsNavigation({
  definitionSlug,
  entrySlug,
  permissions,
  user,
}: Pick<ServerProps, 'permissions' | 'user'> & CollectionSlugs) {
  if (!user || !permissions?.collections?.[definitionSlug]?.read) return null
  // Bulk actions refresh the server navigation without emitting a document event.
  return (
    <DynamicCollectionsNav
      definitionSlug={definitionSlug}
      entrySlug={entrySlug}
      refreshKey={randomUUID()}
    />
  )
}
