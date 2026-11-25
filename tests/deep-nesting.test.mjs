import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, getPayload, handleEndpoints } from 'payload'
import {
  decodePayloadDynamicDefinitionFields,
  decodePayloadDynamicEntryValues,
  encodePayloadDynamicDefinitionFields,
  encodePayloadDynamicEntryValues,
  payloadDynamic,
} from '../src/payload-dynamic/index.ts'

const depth = 6
const postgresURL = process.env.TEST_DATABASE_URL
const auth = { slug: 'users', auth: true, fields: [] }
const field = (key, fieldType, fields) => ({ key, fieldType, ...(fields && { fields }) })
const structure = (fieldKey, items, blockKey) => ({
  fieldKey,
  rows: [{ items, ...(blockKey && { blockKey, rowKey: `${blockKey}-id` }) }],
})
const leaf = { fieldKey: 'data', jsonValue: '[0,1]' }

process.env.DISABLE_PAYLOAD_HMR = 'true'
process.env.PAYLOAD_DROP_DATABASE = 'false'
process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'

test('SQLite rejects an explicit depth above the default', async () => {
  await assert.rejects(
    buildConfig({
      secret: randomUUID(),
      db: sqliteAdapter({ client: { url: 'file::memory:' } }),
      collections: [auth],
      plugins: [payloadDynamic({ canManage: () => true, maxNestingDepth: depth })],
    }),
    /requires PostgreSQL/,
  )
})

test('PostgreSQL authoring retains nested blocks and version values at six levels', {
  skip: !postgresURL,
}, async () => {
  const key = randomUUID()
  const schemaName = `depth_test_${key.replaceAll('-', '')}`
  const temp = await mkdtemp(join(tmpdir(), 'payload-dynamic-depth-'))
  const workspaceIDs = []
  const config = buildConfig({
    secret: key,
    admin: { user: 'users' },
    db: postgresAdapter({
      pool: { connectionString: postgresURL, connectionTimeoutMillis: 5_000 },
      disableCreateDatabase: true,
      push: true,
      schemaName,
    }),
    graphQL: { disable: true },
    telemetry: false,
    typescript: { autoGenerate: false },
    collections: [
      auth,
      {
        slug: 'workspaces',
        access: { create: () => true, read: () => true },
        fields: [{ name: 'title', type: 'text', required: true }],
      },
      {
        slug: 'media',
        upload: { staticDir: temp },
        access: { create: () => true, read: () => true, delete: () => true },
        fields: [{ name: 'workspace', type: 'relationship', relationTo: 'workspaces' }],
      },
    ],
    plugins: [
      payloadDynamic({
        canManage: () => true,
        maxNestingDepth: depth,
        uploadCollection: 'media',
        uploadWorkspaceField: 'workspace',
        workspace: { collection: 'workspaces', allowedIDs: () => workspaceIDs },
        entries: { versions: { drafts: true }, preserveValuePresence: true, stableRowKeys: true },
      }),
    ],
  })
  let payload
  try {
    payload = await getPayload({ config, key, disableDBConnect: true })
    await payload.db.connect()
    const workspace = await payload.create({ collection: 'workspaces', data: { title: 'Local' } })
    const foreign = await payload.create({ collection: 'workspaces', data: { title: 'Neighbor' } })
    workspaceIDs.push(workspace.id, foreign.id)
    const define = (slug, fields) =>
      payload.create({
        collection: 'collections',
        depth: 0,
        data: {
          title: slug,
          slug,
          workspace: workspace.id,
          fields: encodePayloadDynamicDefinitionFields(fields, depth),
        },
      })
    const addEntry = (title, definition, values) =>
      payload.create({
        collection: 'entries',
        data: { title, definition, values: encodePayloadDynamicEntryValues(values, depth) },
      })
    const destination = await define('destination', [field('name', 'text')])
    const link = await addEntry('Linked document', destination.id, [])
    const file = Buffer.from('depth fixture')
    const createUpload = (name, id) =>
      payload.create({
        collection: 'media',
        data: { workspace: id },
        file: { name, mimetype: 'text/plain', data: file, size: file.length },
      })
    const upload = await createUpload('depth.txt', workspace.id)
    const foreignUpload = await createUpload('foreign-depth.txt', foreign.id)
    const variants = [
      field('shell', 'tabs', [
        field('main', 'group', [
          field('sections', 'blocks', [
            field('section', 'group', [
              field('cards', 'blocks', [field('card', 'group', [field('data', 'json')])]),
            ]),
          ]),
        ]),
      ]),
    ]
    const groups = Array.from({ length: depth }, (_, index) => `group-${index}`)
    const deepest = [
      { ...field('related', 'relationship'), targetDefinition: destination.id },
      field('file', 'upload'),
      field('data', 'json'),
      { ...field('choice', 'select'), options: [{ label: 'One', value: 'one' }] },
    ]
    const definition = await define('nested', [
      ...variants,
      ...groups.reduceRight((fields, key) => [field(key, 'group', fields)], deepest),
    ])
    const decodedDefinition = decodePayloadDynamicDefinitionFields(definition.fields, depth)
    const listDeepest = (fields) =>
      groups.reduce((rows, key) => rows.find((row) => row.key === key).fields, fields)
    assert.equal(listDeepest(decodedDefinition)[0].targetDefinition, destination.id)
    assert.equal(decodedDefinition[0].fields[0].fields[0].fields[0].fields[0].fieldType, 'blocks')

    const variantValues = structure('shell', [
      structure('main', [structure('sections', [structure('cards', [leaf], 'card')], 'section')]),
    ])
    const deepValues = groups.reduceRight(
      (items, key) => [structure(key, items)],
      [
        leaf,
        { fieldKey: 'related', relationshipValue: link.id },
        { fieldKey: 'file', uploadValue: upload.id },
        { fieldKey: 'choice', selectValue: 'one' },
      ],
    )
    const originalValues = [variantValues, ...deepValues]
    const entry = await addEntry('Nested document', definition.id, originalValues)
    const read = (doc) => decodePayloadDynamicEntryValues(doc.values, depth)
    const descendants = (values, keys) =>
      keys.reduce(
        (items, key) => items.find(({ fieldKey }) => fieldKey === key).rows[0].items,
        values,
      )
    assert.equal(
      descendants(read(entry), ['shell', 'main', 'sections', 'cards'])[0].jsonValue,
      '[0,1]',
    )
    assert.equal(
      descendants(read(entry), ['shell', 'main', 'sections'])[0].rows[0].rowKey,
      'card-id',
    )
    assert.equal(
      descendants(read(entry), groups).find(({ fieldKey }) => fieldKey === 'data').jsonValue,
      '[0,1]',
    )

    const response = await handleEndpoints({
      config,
      payloadInstanceCacheKey: key,
      request: new Request(`http://localhost/api/entries/${entry.id}?depth=2`),
    })
    assert.equal(response.status, 200)
    const populated = descendants(read(await response.json()), groups)
    assert.equal(populated.find(({ fieldKey }) => fieldKey === 'file').uploadValue.id, upload.id)
    assert.equal(
      populated.find(({ fieldKey }) => fieldKey === 'related').relationshipValue.id,
      link.id,
    )
    const invalid = structuredClone(originalValues)
    descendants(invalid, groups).find(({ fieldKey }) => fieldKey === 'file').uploadValue =
      foreignUpload.id
    await assert.rejects(addEntry('Wrong workspace file', definition.id, invalid), { status: 400 })
    await assert.rejects(payload.delete({ collection: 'media', id: upload.id }), { status: 409 })
    await assert.rejects(payload.delete({ collection: 'entries', id: link.id }), { status: 409 })
    await assert.rejects(payload.delete({ collection: 'collections', id: destination.id }), {
      status: 409,
    })

    const changed = structuredClone(originalValues)
    descendants(changed, groups).find(({ fieldKey }) => fieldKey === 'data').jsonValue = null
    const update = await payload.update({
      collection: 'entries',
      id: entry.id,
      draft: true,
      data: { title: 'Changed draft', values: encodePayloadDynamicEntryValues(changed, depth) },
      depth: 0,
    })
    assert.equal(
      descendants(read(update), groups).find(({ fieldKey }) => fieldKey === 'file').uploadValue,
      upload.id,
    )
    assert.equal(
      descendants(read(update), groups).find(({ fieldKey }) => fieldKey === 'data').valuePresence,
      'null',
    )
    const versions = await payload.findVersions({
      collection: 'entries',
      depth: 2,
      overrideAccess: true,
      where: { parent: { equals: entry.id } },
    })
    const version = versions.docs.find(({ version }) => version.title === 'Nested document')
    assert.ok(version)
    assert.equal(
      descendants(read(version.version), groups).find(({ fieldKey }) => fieldKey === 'file')
        .uploadValue.id,
      upload.id,
    )
    const restored = await payload.restoreVersion({
      collection: 'entries',
      id: version.id,
      overrideAccess: true,
      depth: 0,
    })
    assert.equal(restored.title, 'Nested document')
    assert.equal(
      descendants(read(restored), groups).find(({ fieldKey }) => fieldKey === 'data').jsonValue,
      '[0,1]',
    )
    assert.equal(
      descendants(read(restored), groups).find(({ fieldKey }) => fieldKey === 'file').uploadValue,
      upload.id,
    )
    const cleared = structuredClone(originalValues)
    descendants(cleared, groups).find(({ fieldKey }) => fieldKey === 'file').uploadValue = null
    const published = await payload.update({
      collection: 'entries',
      id: entry.id,
      data: { _status: 'published', values: encodePayloadDynamicEntryValues(cleared, depth) },
      depth: 0,
    })
    assert.equal(
      descendants(read(published), groups).find(({ fieldKey }) => fieldKey === 'file').uploadValue,
      null,
    )
    await assert.rejects(payload.delete({ collection: 'media', id: upload.id }), { status: 409 })
  } finally {
    try {
      if (payload) {
        try {
          await payload.db.pool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
        } finally {
          try {
            await payload.destroy()
          } finally {
            await payload.db.pool?.end()
          }
        }
      }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
})
