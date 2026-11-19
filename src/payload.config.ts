import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { type Access, buildConfig } from 'payload'
import { payloadDynamic } from './payload-dynamic'

const signedIn: Access = ({ req }) => Boolean(req.user)
const configDir = dirname(fileURLToPath(import.meta.url))
const databaseURL = process.env.DATABASE_URL ?? 'file:./native-collections.db'
const push = process.env.DATABASE_PUSH === '1'

export default buildConfig({
  secret: process.env.PAYLOAD_SECRET ?? '',
  admin: { user: 'users', importMap: { baseDir: configDir } },
  db: /^postgres(?:ql)?:\/\//.test(databaseURL)
    ? postgresAdapter({ pool: { connectionString: databaseURL }, push })
    : sqliteAdapter({ client: { url: databaseURL }, push }),
  graphQL: { disable: true },
  telemetry: false,
  typescript: { autoGenerate: false, outputFile: join(configDir, 'payload-types.ts') },
  collections: [
    { slug: 'users', auth: true, fields: [] },
    {
      slug: 'media',
      admin: { useAsTitle: 'filename' },
      access: { create: signedIn, read: signedIn, update: signedIn, delete: signedIn },
      upload: { staticDir: join(process.cwd(), 'demo-media') },
      fields: [{ name: 'title', type: 'text' }],
    },
  ],
  plugins: [payloadDynamic({ canManage: signedIn, uploadCollection: 'media' })],
})
