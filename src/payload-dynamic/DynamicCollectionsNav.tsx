'use client'

import {
  Link,
  NavGroup,
  useConfig,
  useDocumentEvents,
  usePathname,
  useSearchParams,
} from '@payloadcms/ui'
import { useEffect, useState } from 'react'
import { collectionListPath, entryDefinitionParam, entryListURL } from './entry-list'

type DefinitionTitle = { id: number | string; title: string }

export function DynamicCollectionsNav({
  definitionSlug,
  entrySlug,
  refreshKey,
}: {
  definitionSlug: string
  entrySlug: string
  refreshKey: string
}) {
  const { config } = useConfig()
  const { mostRecentUpdate } = useDocumentEvents()
  const pathname = usePathname()
  const query = useSearchParams()
  const [refreshed, setRefreshed] = useState<{ key: string; docs: DefinitionTitle[] }>()
  const { admin, api } = config.routes
  const change = mostRecentUpdate?.entitySlug === definitionSlug ? mostRecentUpdate : null
  const revision = change
    ? `${refreshKey}:${change.operation}:${change.doc?.id ?? change.id}:${change.updatedAt}`
    : refreshKey

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({
      depth: '0',
      pagination: 'false',
      'select[title]': 'true',
      sort: 'title',
    })
    void fetch(`${api}/${definitionSlug}?${params}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          if (!controller.signal.aborted) setRefreshed({ key: revision, docs: [] })
          return
        }
        if (!response.ok) return
        const { docs } = (await response.json()) as { docs: DefinitionTitle[] }
        if (!controller.signal.aborted) setRefreshed({ key: revision, docs })
      })
      .catch(() => {
        // A subsequent definition change refreshes the list after a failed request.
      })
    return () => controller.abort()
  }, [api, definitionSlug, revision])

  const definitions = refreshed?.key === revision ? refreshed.docs : []
  if (!definitions.length) return null

  const active =
    pathname === collectionListPath(admin, entrySlug) ? query.get(entryDefinitionParam) : null
  return (
    <NavGroup label="Dynamic collections" isOpen>
      {definitions.map(({ id, title }) => {
        const selected = active === String(id)
        return (
          <div className="nav__link-wrapper" key={id}>
            <Link
              aria-current={selected ? 'page' : undefined}
              className={selected ? 'nav__link nav__link--selected' : 'nav__link'}
              href={entryListURL(admin, entrySlug, id)}
              prefetch={false}
            >
              <span className="nav__link-label">{title}</span>
            </Link>
          </div>
        )
      })}
    </NavGroup>
  )
}
