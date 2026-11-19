'use client'

import {
  ConfigProvider,
  DefaultEditView,
  DefaultListView,
  Link,
  useConfig,
  useDocumentInfo,
  useListDrawerContext,
  useRouter,
  useSearchParams,
} from '@payloadcms/ui'
import type { ListViewClientProps } from 'payload'
import { type ComponentProps, useEffect, useMemo, useState } from 'react'
import { collectionListPath, entryDefinitionParam, withEntryDefinition } from './entry-list'

function ChooseCollection({ definitionSlug }: { definitionSlug: string }) {
  const { config } = useConfig()
  const router = useRouter()
  const href = collectionListPath(config.routes.admin, definitionSlug)
  useEffect(() => {
    router.replace(href)
  }, [href, router])
  return <Link href={href}>Choose a collection</Link>
}

function TitledEntriesList({
  definitionID,
  definitionSlug,
  ...props
}: ListViewClientProps & { definitionID: string; definitionSlug: string }) {
  const { config } = useConfig()
  const api = config.routes.api
  const [result, setResult] = useState<{ id: string; title: string }>()

  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams({ depth: '0', 'select[title]': 'true' })
    void fetch(`${api}/${definitionSlug}/${encodeURIComponent(definitionID)}?${query}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return
        const { title } = (await response.json()) as { title: string }
        if (!controller.signal.aborted) setResult({ id: definitionID, title })
      })
      .catch(() => {
        // The list keeps its default label if the definition is unavailable.
      })
    return () => controller.abort()
  }, [api, definitionID, definitionSlug])

  const title = result?.id === definitionID ? result.title : undefined
  const collectionSlug = props.collectionSlug
  const listConfig = useMemo(() => {
    if (!title) return config
    return {
      ...config,
      collections: config.collections.map((collection) =>
        collection.slug === collectionSlug
          ? { ...collection, labels: { ...collection.labels, plural: title } }
          : collection,
      ),
    }
  }, [collectionSlug, config, title])

  return (
    <ConfigProvider config={listConfig}>
      <DefaultListView {...props} />
    </ConfigProvider>
  )
}

export function ScopedEntriesList({
  definitionSlug,
  ...props
}: ListViewClientProps & { definitionSlug: string }) {
  const definition = useSearchParams().get(entryDefinitionParam)
  const { isInDrawer } = useListDrawerContext()
  if (!definition && !isInDrawer) return <ChooseCollection definitionSlug={definitionSlug} />

  const listProps = {
    ...props,
    hasCreatePermission: props.hasCreatePermission && Boolean(definition),
    newDocumentURL: definition
      ? withEntryDefinition(props.newDocumentURL, definition)
      : props.newDocumentURL,
  }

  return !isInDrawer && definition ? (
    <TitledEntriesList
      {...listProps}
      definitionID={definition}
      definitionSlug={definitionSlug}
      key={definition}
    />
  ) : (
    <DefaultListView {...listProps} />
  )
}

export function ScopedEntryEdit({
  definitionSlug,
  ...props
}: ComponentProps<typeof DefaultEditView> & { definitionSlug: string }) {
  const definition = useSearchParams().get(entryDefinitionParam)
  const { id } = useDocumentInfo()
  if (id == null && !definition) return <ChooseCollection definitionSlug={definitionSlug} />
  return <DefaultEditView {...props} />
}
