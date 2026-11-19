import type { CollectionSlug } from 'payload'

export type CollectionSlugs = {
  definitionSlug: CollectionSlug
  entrySlug: CollectionSlug
}

export const entryDefinitionParam = 'entryDefinition'

export const collectionListPath = (adminRoute: string, slug: string) =>
  `${adminRoute}/collections/${slug}`

export function entryListURL(adminRoute: string, entrySlug: string, definitionID: number | string) {
  return withEntryDefinition(collectionListPath(adminRoute, entrySlug), definitionID)
}

export function withEntryDefinition(url: string, definitionID: number | string) {
  const query = new URLSearchParams({ [entryDefinitionParam]: String(definitionID) })
  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}
