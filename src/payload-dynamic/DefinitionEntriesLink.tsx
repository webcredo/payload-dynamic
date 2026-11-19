'use client'

import { Button, useConfig, useDocumentInfo } from '@payloadcms/ui'
import { entryListURL } from './entry-list'

export function DefinitionEntriesLink({ entrySlug }: { entrySlug: string }) {
  const { id } = useDocumentInfo()
  const { config } = useConfig()
  if (id == null) return null

  return (
    <Button buttonStyle="secondary" el="link" to={entryListURL(config.routes.admin, entrySlug, id)}>
      View entries
    </Button>
  )
}
