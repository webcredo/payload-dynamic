import '@payloadcms/next/css'
import config from '@payload-config'
import {
  generatePayloadViewport,
  handleServerFunctions,
  RootLayout,
} from '@payloadcms/next/layouts'
import type { ServerFunctionClient } from 'payload'
import type { ReactNode } from 'react'
import { importMap } from './admin/importMap.js'

export const generateViewport = generatePayloadViewport

const serverFunction: ServerFunctionClient = async (args) => {
  'use server'
  return handleServerFunctions({ ...args, config, importMap })
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
      {children}
    </RootLayout>
  )
}
