import config from '@payload-config'
import { generatePageMetadata, RootPage } from '@payloadcms/next/views'
import { importMap } from '../importMap.js'

type Props = {
  params: Promise<{ segments: string[] }>
  searchParams: Promise<Record<string, string | string[]>>
}

export function generateMetadata({ params, searchParams }: Props) {
  return generatePageMetadata({ config, params, searchParams })
}

export default function Admin({ params, searchParams }: Props) {
  return RootPage({ config, params, searchParams, importMap })
}
