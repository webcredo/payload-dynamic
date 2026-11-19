'use client'

import { useConfig, usePathname, useStepNav } from '@payloadcms/ui'
import { useEffect } from 'react'
import { collectionListPath, entryListURL } from './entry-list'

export function CollectionBreadcrumb({
  definitionID,
  entrySlug,
  title,
}: {
  definitionID: string
  entrySlug: string
  title?: string
}) {
  const { config } = useConfig()
  const pathname = usePathname().replace(/\/$/, '')
  const { setStepNav, stepNav } = useStepNav()
  const adminRoute = config.routes.admin
  const listPath = collectionListPath(adminRoute, entrySlug)
  const listURL = entryListURL(adminRoute, entrySlug, definitionID)
  const label = title ?? config.collections.find(({ slug }) => slug === entrySlug)?.labels.plural

  useEffect(() => {
    const [collection, ...rest] = stepNav
    if (!collection || !label) return

    const collectionPath = collection.url?.split('?')[0]?.replace(/\/$/, '')
    if (!pathname.startsWith(`${listPath}/`) || collectionPath !== listPath) {
      return
    }

    if (collection.label !== label || collection.url !== listURL) {
      setStepNav([{ ...collection, label, url: listURL }, ...rest])
    }
  }, [label, listPath, listURL, pathname, setStepNav, stepNav])

  return null
}
