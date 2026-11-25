import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, createPayloadRequest, getPayload, handleEndpoints } from 'payload'
import { reconcileSiblingRowKeys } from '../src/payload-dynamic/entry-values.ts'
import { payloadDynamic } from '../src/payload-dynamic/index.ts'

process.env.DISABLE_PAYLOAD_HMR = 'true'
process.env.PAYLOAD_DROP_DATABASE = 'false'
process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'

const definitionSlug = 'collections'
const entrySlug = 'entries'
const definitions = `/api/${definitionSlug}`
const entries = `/api/${entrySlug}`
const day = '2026-11-16T00:00:00.000Z'

const capacity = { key: 'capacity', label: 'Capacity', fieldType: 'number', min: 0, max: 500 }
const fields = [
  { ...capacity, required: true },
  { key: 'parking', label: 'Parking', fieldType: 'number', defaultNumber: 0 },
  {
    key: 'address',
    label: 'Address',
    fieldType: 'text',
    minLength: 4,
    maxLength: 60,
    defaultText: 'North wing',
  },
  { key: 'note', label: 'Note', fieldType: 'textarea', maxLength: 100 },
  { key: 'contact', label: 'Contact', fieldType: 'email' },
  { key: 'open', label: 'Open', fieldType: 'checkbox', defaultChecked: false },
  { key: 'opens', label: 'Opens', fieldType: 'date', defaultDate: day },
  {
    key: 'tier',
    label: 'Tier',
    fieldType: 'select',
    options: [
      { label: 'Standard', value: 'standard' },
      { label: 'Premium', value: 'premium' },
    ],
    defaultOption: 'standard',
  },
]

function namedField(fields, name) {
  const field = fields.find((candidate) => candidate.name === name)
  assert.ok(field, `Missing native field ${name}`)
  return field
}

async function request({ config, key, token }, method, path, status, body) {
  const headers = new Headers()
  if (token) headers.set('Authorization', `JWT ${token}`)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await handleEndpoints({
    config,
    payloadInstanceCacheKey: key,
    request: new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  })
  const result = response.status === 204 ? undefined : await response.json()
  const detail = JSON.stringify(result)?.slice(0, 500) ?? ''
  assert.equal(response.status, status, `${method} ${path}: ${detail}`)
  return result
}

async function withFixture(
  run,
  postgresURL,
  pluginOptions,
  hostCollections = [],
  sqliteTransactions = false,
  adapterOptions = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'payload-dynamic-test-'))
  const dbURL = pathToFileURL(join(dir, 'db.sqlite')).href
  const key = randomUUID()
  const schemaName = `payload_test_${key.replaceAll('-', '')}`
  const email = 'manager@example.test'
  const password = randomBytes(24).toString('hex')
  const isManager = ({ req }) => req.user?.email === email
  const config = buildConfig({
    secret: randomBytes(32).toString('hex'),
    admin: { user: 'users' },
    db: postgresURL
      ? postgresAdapter({
          pool: { connectionString: postgresURL, connectionTimeoutMillis: 5_000 },
          disableCreateDatabase: true,
          push: true,
          schemaName,
          ...adapterOptions,
        })
      : sqliteAdapter({
          client: { url: dbURL },
          push: true,
          ...(sqliteTransactions ? { transactionOptions: {} } : {}),
          ...adapterOptions,
        }),
    graphQL: { disable: true },
    logger: { options: { level: 'fatal' } },
    telemetry: false,
    typescript: { autoGenerate: false },
    collections: [
      { slug: 'users', auth: true, fields: [] },
      {
        slug: 'media',
        upload: { staticDir: join(dir, 'media') },
        access: { read: isManager, create: isManager, delete: isManager },
        fields: [],
      },
      ...hostCollections,
    ],
    plugins: [
      payloadDynamic({ canManage: isManager, uploadCollection: 'media', ...pluginOptions }),
    ],
  })
  let payload
  try {
    payload = await getPayload({ config, key, disableDBConnect: Boolean(postgresURL) })
    if (postgresURL) await payload.db.connect()
    async function login(userEmail) {
      const user = await payload.create({
        collection: 'users',
        overrideAccess: true,
        data: { email: userEmail, password },
      })
      const { token } = await payload.login({
        collection: 'users',
        data: { email: userEmail, password },
      })
      assert.ok(token)
      return { request: request.bind(null, { config, key, token }), user }
    }
    const { request: manager, user } = await login(email)
    const { request: outsider, user: outsiderUser } = await login('other@example.test')
    await run({
      payload,
      manager,
      outsider,
      outsiderUser,
      login,
      schemaName,
      user,
      anonymous: request.bind(null, { config, key }),
    })
  } finally {
    try {
      if (payload) {
        try {
          if (postgresURL)
            await payload.db.pool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
        } finally {
          try {
            await payload.destroy()
          } finally {
            if (postgresURL) await payload.db.pool?.end()
            else payload.db.client.close()
          }
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

const createDefinition = async (call, title, slug, schema, endpoint = definitions) =>
  (await call('POST', `${endpoint}?depth=0`, 201, { title, slug, fields: schema })).doc

const createEntry = async (call, title, definition, values, endpoint = entries) =>
  (await call('POST', `${endpoint}?depth=0`, 201, { title, definition, values })).doc

function value(record, key, column) {
  return nestedValue(record.values, key, column)
}

function valueRow(rows, key) {
  const row = rows.find(({ fieldKey }) => fieldKey === key)
  assert.ok(row, `Missing stored row for ${key}`)
  return row
}

function nestedValue(items, key, column) {
  return valueRow(items, key)[column]
}

async function assertNativeStorage(payload) {
  const definition = payload.collections[definitionSlug].config
  const entry = payload.collections[entrySlug].config
  const definitionFields = namedField(definition.fields, 'fields')
  const entryValues = namedField(entry.fields, 'values')
  assert.equal(
    definition.fields.some(({ name }) => name === 'singleton'),
    false,
  )
  assert.equal(
    entry.fields.some(({ name }) => name === 'singletonKey'),
    false,
  )
  assert.equal(definitionFields.type, 'array')
  assert.equal(entryValues.type, 'array')
  const typeSelect = namedField(definitionFields.fields, 'fieldType')
  assert.equal(typeSelect.type, 'select')
  assert.deepEqual(
    new Set(
      typeSelect.options.map((option) => (typeof option === 'string' ? option : option.value)),
    ),
    new Set([
      ...fields.map(({ fieldType }) => fieldType),
      'relationship',
      'upload',
      'code',
      'radio',
      'slug',
      'group',
      'array',
      'tabs',
      'blocks',
    ]),
  )
  assert.equal(Boolean(namedField(definitionFields.fields, 'label').required), false)
  assert.equal(namedField(definitionFields.fields, 'fields').type, 'array')
  assert.equal(namedField(entryValues.fields, 'rows').type, 'array')
  assert.equal(namedField(namedField(entryValues.fields, 'rows').fields, 'items').type, 'array')
  const minimum = namedField(definitionFields.fields, 'min')
  assert.equal(minimum.type, 'number')
  assert.equal(minimum.admin.condition({}, { fieldType: 'number' }), true)
  assert.equal(minimum.admin.condition({}, { fieldType: 'text' }), false)
  const options = namedField(definitionFields.fields, 'options')
  assert.equal(options.type, 'array')
  assert.equal(options.admin.condition({}, { fieldType: 'select' }), true)
  assert.equal(options.admin.condition({}, { fieldType: 'radio' }), true)
  assert.equal(options.admin.condition({}, { fieldType: 'checkbox' }), false)

  function assertNativeFields(items) {
    for (const field of items) {
      assert.notEqual(field.virtual, true)
      assert.notEqual(field.type, 'json')
      assert.notEqual(field.type, 'richText')
      if (field.fields) assertNativeFields(field.fields)
    }
  }
  assertNativeFields(definitionFields.fields)
  assertNativeFields(entryValues.fields)
  assert.ok(!entry.fields.some(({ name }) => name === 'customFields'))

  const { client } = payload.db
  const { rows: tables } = await client.execute(
    "SELECT name FROM sqlite_schema WHERE type = 'table'",
  )
  const names = tables.map(({ name }) => name)
  assert.ok(names.includes('collection_definitions_fields'))
  assert.ok(names.includes('collection_entries_values'))
  assert.ok(!names.some((name) => /^dynamic_collection_|^dynamic_global_/.test(name)))
  if (names.includes('payload_kv')) {
    const { rows } = await client.execute('SELECT count(*) AS rows FROM payload_kv')
    assert.equal(Number(rows[0].rows), 0, 'Application data must stay out of the core KV table')
  }
  const { rows: columnRows } = await client.execute('PRAGMA table_info(collection_entries_values)')
  const columns = Object.fromEntries(columnRows.map(({ name, type }) => [name, type]))
  assert.match(columns.field_key, /^TEXT$/i)
  assert.match(columns.number_value, /^(?:REAL|NUMERIC)$/i)
  assert.match(columns.text_value, /^TEXT$/i)
  assert.match(columns.checkbox_value, /^INTEGER$/i)

  const { rows: nativeIndexes } = await client.execute(`
    SELECT columns.name FROM pragma_index_list('collection_entries_values') AS indexes
    JOIN pragma_index_info(indexes.name) AS columns
    GROUP BY indexes.name HAVING count(*) = 1
  `)
  const singleColumnIndexes = new Set(nativeIndexes.map(({ name }) => name))
  assert.ok(singleColumnIndexes.has('date_value'))
  assert.ok(singleColumnIndexes.has('select_value'))

  const indexName = 'collection_values_key_number_parent_idx'
  const { rows: indexColumns } = await client.execute(`PRAGMA index_info(${indexName})`)
  assert.deepEqual(
    indexColumns.map(({ name }) => name),
    ['field_key', 'number_value', '_parent_id'],
  )
  const { rows: plan } = await client.execute({
    sql: 'EXPLAIN QUERY PLAN SELECT _parent_id FROM collection_entries_values WHERE field_key = ? AND number_value >= ?',
    args: ['capacity', 100],
  })
  assert.ok(
    plan.some(({ detail }) => detail.includes(`COVERING INDEX ${indexName}`)),
    JSON.stringify(plan),
  )
  const { rows: version } = await client.execute('PRAGMA schema_version')
  return version[0].schema_version
}

async function verifyTypedStorage({ payload, manager, anonymous, outsider }) {
  const schemaVersion = await assertNativeStorage(payload)
  await anonymous('GET', definitions, 403)
  await outsider('POST', definitions, 403, { title: 'Private', slug: 'private', fields })

  const venues = await createDefinition(manager, 'Venues', 'venues', fields)
  const other = await createDefinition(manager, 'Other venues', 'other-venues', [capacity])
  const created = await createEntry(manager, 'North', venues.id, [
    { fieldKey: 'capacity', numberValue: 120.5 },
    { fieldKey: 'note', textareaValue: 'On the ground floor' },
    { fieldKey: 'contact', emailValue: 'venue@example.test' },
  ])
  assert.equal(value(created, 'capacity', 'numberValue'), 120.5)
  assert.equal(value(created, 'address', 'textValue'), 'North wing')
  assert.equal(value(created, 'parking', 'numberValue'), 0)
  assert.equal(value(created, 'open', 'checkboxValue'), false)
  assert.equal(value(created, 'tier', 'selectValue'), 'standard')
  assert.equal(value(created, 'opens', 'dateValue'), day)
  assert.equal(value(created, 'note', 'textareaValue'), 'On the ground floor')
  assert.equal(value(created, 'contact', 'emailValue'), 'venue@example.test')

  const entryPath = `${entries}/${created.id}?depth=0`
  await outsider('GET', entryPath, 403)
  await outsider('PATCH', entryPath, 403, { title: 'Writer with the wrong role' })
  const { doc: renamed } = await manager('PATCH', entryPath, 200, { title: 'Renamed' })
  assert.equal(renamed.title, 'Renamed')
  assert.deepEqual(
    renamed.values,
    created.values,
    'A title update must preserve values and row IDs',
  )
  const otherMatch = await createEntry(manager, 'South', venues.id, [
    { fieldKey: 'capacity', numberValue: 100 },
  ])
  await createEntry(manager, 'Parking only', venues.id, [
    { fieldKey: 'capacity', numberValue: 60 },
    { fieldKey: 'parking', numberValue: 200 },
  ])
  await createEntry(manager, 'Different definition', other.id, [
    { fieldKey: 'capacity', numberValue: 200 },
  ])
  const filter = new URLSearchParams({
    depth: '0',
    limit: '1',
    sort: 'id',
    'where[and][0][definition][equals]': String(venues.id),
    'where[and][1][values.fieldKey][equals]': 'capacity',
    'where[and][2][values.numberValue][greater_than_equal]': '100',
  })
  const firstPage = await manager('GET', `${entries}?${filter}`, 200)
  assert.deepEqual(
    firstPage.docs.map(({ id }) => id),
    [created.id],
  )
  assert.equal(firstPage.totalDocs, 2)
  filter.set('page', '2')
  const secondPage = await manager('GET', `${entries}?${filter}`, 200)
  assert.deepEqual(
    secondPage.docs.map(({ id }) => id),
    [otherMatch.id],
  )
  assert.equal(secondPage.totalDocs, 2)

  const { rows: stored } = await payload.db.client.execute({
    sql: 'SELECT number_value, typeof(number_value) AS type, text_value FROM collection_entries_values WHERE _parent_id = ? AND field_key = ?',
    args: [created.id, 'capacity'],
  })
  assert.deepEqual({ ...stored[0] }, { number_value: 120.5, type: 'real', text_value: null })
  assert.equal(
    await assertNativeStorage(payload),
    schemaVersion,
    'Adding schema documents needs no DDL',
  )
  await manager('DELETE', entryPath, 200)
  await manager('GET', entryPath, 404)
}

async function verifyValidation({ manager }) {
  const makeBadDefinition = (slug, invalidFields) =>
    manager('POST', definitions, 400, { title: 'Invalid', slug, fields: invalidFields })
  await makeBadDefinition('Bad_slug', fields)
  await makeBadDefinition('duplicate-field', [capacity, capacity])
  await makeBadDefinition('inverted-range', [{ ...capacity, min: 10, max: 1 }])
  await makeBadDefinition('unknown-default', [{ ...fields.at(-1), defaultOption: 'unknown' }])
  const date = { key: 'starts', label: 'Starts', fieldType: 'date' }
  await makeBadDefinition('malformed-default-date', [{ ...date, defaultDate: '12' }])
  await makeBadDefinition('impossible-default-date', [{ ...date, defaultDate: '2026-02-30' }])
  const unused = await createDefinition(manager, 'Draft schema', 'draft-schema', [capacity])
  const textCapacity = { key: 'capacity', label: 'Capacity', fieldType: 'text' }
  const { doc: changed } = await manager('PATCH', `${definitions}/${unused.id}`, 200, {
    fields: [textCapacity],
  })
  assert.equal(changed.fields[0].fieldType, 'text')
  await manager('DELETE', `${definitions}/${unused.id}`, 200)

  const venues = await createDefinition(manager, 'Validation venues', 'validation-venues', fields)
  await makeBadDefinition('validation-venues', fields)
  await manager('PATCH', `${definitions}/${venues.id}`, 409, { slug: 'changed' })

  const validCapacity = { fieldKey: 'capacity', numberValue: 150 }
  const bad = (input) =>
    manager('POST', entries, 400, { title: 'Invalid', definition: venues.id, values: input })
  await bad([])
  await bad([{ fieldKey: 'capacity', numberValue: true }])
  await bad([{ fieldKey: 'capacity', numberValue: 501 }])
  await bad([validCapacity, { fieldKey: 'address', textValue: 'x' }])
  await bad([validCapacity, { fieldKey: 'contact', emailValue: 'invalid' }])
  await bad([validCapacity, { fieldKey: 'tier', selectValue: 'unknown' }])
  await bad([validCapacity, { fieldKey: 'open', checkboxValue: 1 }])
  await bad([validCapacity, { fieldKey: 'parking', textValue: 'wrong stored column' }])
  await bad([validCapacity, { fieldKey: 'unknown', numberValue: 50 }])
  await bad([validCapacity, validCapacity])

  const venue = await createEntry(manager, 'Venue', venues.id, [validCapacity])
  await manager('PATCH', `${definitions}/${venues.id}`, 409, {
    fields: fields.map((field) => (field.key === 'capacity' ? textCapacity : field)),
  })
  await manager('DELETE', `${definitions}/${venues.id}`, 409)
  const rooms = await createDefinition(manager, 'Rooms', 'rooms', [capacity])
  await manager('PATCH', `${entries}/${venue.id}?depth=0`, 200, { definition: rooms.id })
  assert.equal((await manager('GET', `${entries}/${venue.id}?depth=0`, 200)).definition, venues.id)
}

async function verifyAdditionalFieldTypes({ payload, manager, outsider }) {
  const radio = {
    key: 'publish_state',
    label: '  ',
    fieldType: 'radio',
    options: [
      { label: 'Draft', value: 'draft' },
      { label: 'Public', value: 'public' },
    ],
    defaultOption: 'draft',
  }
  const code = {
    key: 'source_code',
    fieldType: 'code',
    maxLength: 40,
    defaultText: 'return 1;',
  }
  const slug = {
    key: 'public-slug',
    label: 'URL segment',
    fieldType: 'slug',
    defaultText: 'First Page',
  }
  const group = {
    key: 'layout',
    fieldType: 'group',
    fields: [
      { key: 'width', fieldType: 'number', required: true },
      {
        key: 'tags',
        fieldType: 'array',
        fields: [{ key: 'tag', fieldType: 'text', required: true }],
      },
    ],
  }
  const array = {
    key: 'sections',
    fieldType: 'array',
    minRows: 1,
    maxRows: 2,
    fields: [{ key: 'heading', fieldType: 'text', required: true }],
  }
  const tabs = {
    key: 'settings',
    fieldType: 'tabs',
    fields: [
      {
        key: 'general',
        fieldType: 'group',
        fields: [{ key: 'summary', fieldType: 'textarea', required: true }],
      },
      {
        key: 'advanced',
        fieldType: 'group',
        fields: [{ key: 'visible', fieldType: 'checkbox', defaultChecked: true }],
      },
    ],
  }
  const blocks = {
    key: 'content',
    fieldType: 'blocks',
    maxRows: 2,
    fields: [
      {
        key: 'hero',
        fieldType: 'group',
        fields: [{ key: 'headline', fieldType: 'text', required: true }],
      },
      {
        key: 'quote',
        label: 'Quotation',
        fieldType: 'group',
        fields: [{ key: 'caption', fieldType: 'textarea', required: true }],
      },
    ],
  }
  const schema = [code, radio, slug, group, array, tabs, blocks]
  const pages = await createDefinition(manager, 'Pages', 'pages', schema)
  const persisted = await manager('GET', `${definitions}/${pages.id}?depth=0`, 200)
  assert.deepEqual(
    persisted.fields.slice(0, 3).map(({ label }) => label),
    ['Source Code', 'Publish State', 'URL segment'],
  )
  assert.equal(persisted.fields[3].fields[1].fields[0].label, 'Tag')
  assert.equal(persisted.fields[6].fields[1].label, 'Quotation')

  const nested = (fieldKey, rows) => ({ fieldKey, rows })
  const row = (...items) => ({ items })
  const width = (numberValue) => ({ fieldKey: 'width', numberValue })
  const heading = (textValue) => ({ fieldKey: 'heading', textValue })
  const layout = nested('layout', [
    row(width(960), nested('tags', [row({ fieldKey: 'tag', textValue: 'featured' })])),
  ])
  const sections = nested('sections', [row(heading('Introduction')), row(heading('Details'))])
  const settings = nested('settings', [
    row(
      nested('general', [row({ fieldKey: 'summary', textareaValue: 'A short introduction' })]),
      nested('advanced', [row()]),
    ),
  ])
  const hero = { ...row({ fieldKey: 'headline', textValue: 'A real headline' }), blockKey: 'hero' }
  const quote = {
    ...row({ fieldKey: 'caption', textareaValue: 'First line\nSecond line' }),
    blockKey: 'quote',
  }
  const content = nested('content', [hero, quote])
  const input = [layout, sections, settings, content]
  const {
    rows: [{ schema_version: before }],
  } = await payload.db.client.execute('PRAGMA schema_version')
  const page = await createEntry(manager, 'First page', pages.id, input)
  const pagePath = `${entries}/${page.id}?depth=0`
  const loaded = await manager('GET', pagePath, 200)
  assert.deepEqual(loaded.values, page.values)
  await outsider('GET', pagePath, 403)
  assert.equal(valueRow(loaded.values, code.key).fieldLabel, 'Source Code')
  assert.equal(value(loaded, code.key, 'textareaValue'), 'return 1;')
  assert.equal(value(loaded, radio.key, 'selectValue'), 'draft')
  assert.equal(value(loaded, slug.key, 'textValue'), 'first-page')
  const layoutItems = value(loaded, group.key, 'rows')[0].items
  assert.equal(nestedValue(layoutItems, 'width', 'numberValue'), 960)
  assert.equal(
    nestedValue(nestedValue(layoutItems, 'tags', 'rows')[0].items, 'tag', 'textValue'),
    'featured',
  )
  const storedSections = value(loaded, array.key, 'rows')
  assert.deepEqual(
    storedSections.map(({ items }) => nestedValue(items, 'heading', 'textValue')),
    ['Introduction', 'Details'],
  )
  const tabItems = value(loaded, tabs.key, 'rows')[0].items
  const general = nestedValue(tabItems, 'general', 'rows')[0].items
  const advanced = nestedValue(tabItems, 'advanced', 'rows')[0].items
  assert.equal(nestedValue(general, 'summary', 'textareaValue'), 'A short introduction')
  assert.equal(nestedValue(advanced, 'visible', 'checkboxValue'), true)
  const storedBlocks = value(loaded, blocks.key, 'rows')
  assert.deepEqual(
    storedBlocks.map(({ blockKey }) => blockKey),
    ['hero', 'quote'],
  )
  assert.equal(nestedValue(storedBlocks[0].items, 'headline', 'textValue'), 'A real headline')
  assert.equal(
    nestedValue(storedBlocks[1].items, 'caption', 'textareaValue'),
    'First line\nSecond line',
  )

  const { doc: renamed } = await manager('PATCH', pagePath, 200, { title: 'Renamed page' })
  assert.deepEqual(
    renamed.values,
    loaded.values,
    'A title-only update preserves nested IDs and values',
  )
  const values = loaded.values.map((field) => {
    if (field.fieldKey === array.key) return { ...field, rows: [...storedSections].reverse() }
    if (field.fieldKey === blocks.key) return { ...field, rows: [...storedBlocks].reverse() }
    if (field.fieldKey === code.key) return { ...field, textareaValue: 'return 2;\n' }
    if (field.fieldKey === radio.key) return { ...field, selectValue: 'public' }
    if (field.fieldKey === slug.key) return { ...field, textValue: 'Second Page' }
    return field
  })
  const { doc: updated } = await manager('PATCH', pagePath, 200, { values })
  assert.equal(value(updated, code.key, 'textareaValue'), 'return 2;\n')
  assert.equal(value(updated, radio.key, 'selectValue'), 'public')
  assert.equal(value(updated, slug.key, 'textValue'), 'second-page')
  assert.deepEqual(value(updated, array.key, 'rows'), [...storedSections].reverse())
  assert.deepEqual(value(updated, blocks.key, 'rows'), [...storedBlocks].reverse())
  assert.deepEqual((await manager('GET', pagePath, 200)).values, updated.values)

  const {
    rows: [{ schema_version: after }],
  } = await payload.db.client.execute('PRAGMA schema_version')
  assert.equal(after, before, 'Using nested collection types needs no DDL per definition or entry')

  const badDefinition = (slug, fields) =>
    manager('POST', definitions, 400, { title: 'Invalid', slug, fields })
  await badDefinition('bad-label', [{ ...code, label: 42 }])
  await badDefinition('bad-radio-default', [{ ...radio, defaultOption: 'unknown' }])
  await badDefinition('duplicate-nested-keys', [
    { ...group, fields: [group.fields[0], group.fields[0]] },
  ])
  await badDefinition('bad-array-limits', [{ ...array, minRows: 3 }])
  await badDefinition('bad-block-definition', [{ ...blocks, fields: [code] }])
  await badDefinition('bad-tab-definition', [{ ...tabs, fields: [code] }])
  await badDefinition('too-deep', [{ ...group, fields: [{ ...group, fields: [array] }] }])
  await manager('PATCH', `${definitions}/${pages.id}`, 409, {
    fields: schema.map((field) =>
      field.key === group.key ? { ...field, fields: [{ key: 'width', fieldType: 'text' }] } : field,
    ),
  })

  const badEntry = (values) =>
    manager('POST', entries, 400, { title: 'Invalid page', definition: pages.id, values })
  const replacing = (key, replacement) =>
    input.map((value) => (value.fieldKey === key ? replacement : value))
  await badEntry([...input, { fieldKey: code.key, textareaValue: 'x'.repeat(41) }])
  await badEntry([...input, { fieldKey: radio.key, selectValue: 'unknown' }])
  await badEntry([...input, { fieldKey: slug.key, textareaValue: 'wrong typed column' }])
  await badEntry(replacing(group.key, nested('layout', [row()])))
  await badEntry(replacing(group.key, nested('layout', [row(width(960)), row(width(1024))])))
  await badEntry(replacing(array.key, nested('sections', [])))
  await badEntry(
    replacing(
      array.key,
      nested('sections', [row(heading('1')), row(heading('2')), row(heading('3'))]),
    ),
  )
  await badEntry(replacing(array.key, nested('sections', [storedSections[0], storedSections[0]])))
  await badEntry(replacing(blocks.key, nested('content', [{ ...hero, blockKey: 'unknown' }])))
  await badEntry(replacing(blocks.key, nested('content', [{ ...hero, blockKey: 'quote' }])))
}

async function verifyReferences({ payload, manager, user }, routes = { definitions, entries }) {
  const { definitions, entries } = routes
  const define = (title, slug, fields) =>
    createDefinition(manager, title, slug, fields, definitions)
  const create = (title, definition, values) =>
    createEntry(manager, title, definition, values, entries)
  const venues = await define('Reference venues', 'reference-venues', [capacity])
  const north = await create('North', venues.id, [{ fieldKey: 'capacity', numberValue: 1 }])
  const south = await create('South', venues.id, [{ fieldKey: 'capacity', numberValue: 2 }])
  const east = await create('East', venues.id, [{ fieldKey: 'capacity', numberValue: 3 }])
  const reviews = await define('Reviews', 'reviews', [
    {
      key: 'venue',
      label: 'Venue',
      fieldType: 'relationship',
      targetDefinition: venues.id,
      required: true,
    },
    {
      key: 'nearby',
      label: 'Nearby',
      fieldType: 'relationship',
      targetDefinition: venues.id,
      hasMany: true,
    },
    { key: 'asset', label: 'Asset', fieldType: 'upload' },
  ])
  const file = Buffer.from('Temporary native collection fixture\n')
  const media = await payload.create({
    collection: 'media',
    overrideAccess: false,
    user,
    data: {},
    file: { name: 'fixture.txt', mimetype: 'text/plain', data: file, size: file.length },
  })
  const review = await create('Review', reviews.id, [
    { fieldKey: 'venue', relationshipValue: north.id },
    { fieldKey: 'nearby', relationshipValues: [east.id, south.id] },
    { fieldKey: 'asset', uploadValue: media.id },
  ])
  assert.equal(value(review, 'venue', 'relationshipValue'), north.id)
  assert.deepEqual(value(review, 'nearby', 'relationshipValues'), [east.id, south.id])
  assert.equal(value(review, 'asset', 'uploadValue'), media.id)
  await manager('POST', entries, 400, {
    title: 'Wrong target',
    definition: reviews.id,
    values: [{ fieldKey: 'venue', relationshipValue: review.id }],
  })
  await manager('POST', entries, 400, {
    title: 'Wrong cardinality',
    definition: reviews.id,
    values: [
      { fieldKey: 'venue', relationshipValue: north.id },
      { fieldKey: 'nearby', relationshipValue: south.id },
    ],
  })
  await manager('DELETE', `${entries}/${north.id}`, 409)
  await manager('DELETE', `${entries}/${south.id}`, 409)
  await manager('DELETE', `/api/media/${media.id}`, 409)
  const preserved = await manager('GET', `${entries}/${review.id}?depth=0`, 200)
  assert.equal(value(preserved, 'venue', 'relationshipValue'), north.id)
  assert.deepEqual(value(preserved, 'nearby', 'relationshipValues'), [east.id, south.id])
  assert.equal(value(preserved, 'asset', 'uploadValue'), media.id)

  const nestedReviews = await define('Nested reviews', 'nested-reviews', [
    {
      key: 'attachments',
      fieldType: 'group',
      fields: [
        {
          key: 'assets',
          fieldType: 'array',
          fields: [
            { key: 'site', fieldType: 'relationship', targetDefinition: venues.id, hasMany: true },
            { key: 'files', fieldType: 'upload', hasMany: true },
          ],
        },
      ],
    },
  ])
  const nestedValues = (id) => [
    {
      fieldKey: 'attachments',
      rows: [
        {
          items: [
            {
              fieldKey: 'assets',
              rows: [
                {
                  items: [
                    { fieldKey: 'site', relationshipValues: [id] },
                    { fieldKey: 'files', uploadValues: [media.id] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ]
  await manager('POST', entries, 400, {
    title: 'Wrong nested target',
    definition: nestedReviews.id,
    values: nestedValues(review.id),
  })
  const nestedReview = await create('Nested review', nestedReviews.id, nestedValues(north.id))
  const nestedPath = `${entries}/${nestedReview.id}?depth=0`
  const nestedResult = await manager('GET', nestedPath, 200)
  const assets = value(nestedResult, 'attachments', 'rows')[0].items
  const references = nestedValue(assets, 'assets', 'rows')[0].items
  assert.deepEqual(nestedValue(references, 'site', 'relationshipValues'), [north.id])
  assert.deepEqual(nestedValue(references, 'files', 'uploadValues'), [media.id])
  await manager('DELETE', `${entries}/${review.id}`, 200)
  await manager('DELETE', `${entries}/${north.id}`, 409)
  await manager('DELETE', `/api/media/${media.id}`, 409)
  await manager('DELETE', nestedPath, 200)

  await manager('DELETE', `${entries}/${north.id}`, 200)
  await manager('DELETE', `${entries}/${south.id}`, 200)
  await manager('DELETE', `/api/media/${media.id}`, 200)

  await manager('PATCH', `${definitions}/${venues.id}`, 200, {
    fields: [
      capacity,
      { key: 'related', label: 'Related', fieldType: 'relationship', targetDefinition: venues.id },
    ],
  })
  const eastPath = `${entries}/${east.id}?depth=0`
  const { doc: selfLinked } = await manager('PATCH', eastPath, 200, {
    values: [
      { fieldKey: 'capacity', numberValue: 3 },
      { fieldKey: 'related', relationshipValue: east.id },
    ],
  })
  assert.equal(value(selfLinked, 'related', 'relationshipValue'), east.id)
  await manager('DELETE', eastPath, 200)
  await manager('GET', eastPath, 404)
  await manager('DELETE', `${definitions}/${reviews.id}`, 200)
  await manager('DELETE', `${definitions}/${venues.id}`, 409)
  await manager('DELETE', `${definitions}/${nestedReviews.id}`, 200)
  await manager('DELETE', `${definitions}/${venues.id}`, 200)
}

async function verifyLocalAPI({ payload, user }) {
  const req = await createPayloadRequest({ payload, user })
  const withRequest = { req, overrideAccess: false, depth: 0 }
  const definition = await payload.create({
    ...withRequest,
    collection: definitionSlug,
    data: {
      title: 'Local venues',
      slug: 'local-venues',
      fields: [{ ...capacity, defaultNumber: 1 }],
    },
  })
  const createVenue = (title) =>
    payload.create({
      ...withRequest,
      collection: entrySlug,
      data: { title, definition: definition.id },
    })
  const first = await createVenue('Before schema update')
  assert.equal(value(first, 'capacity', 'numberValue'), 1)
  await payload.update({
    ...withRequest,
    collection: definitionSlug,
    id: definition.id,
    data: { fields: [{ ...capacity, defaultNumber: 2 }] },
  })
  const second = await createVenue('After schema update')
  assert.equal(value(second, 'capacity', 'numberValue'), 2)

  const privileged = { overrideAccess: true, depth: 0 }
  const notes = await payload.create({
    ...privileged,
    collection: definitionSlug,
    data: {
      title: 'Local notes',
      slug: 'local-notes',
      fields: [
        {
          key: 'venue',
          label: 'Venue',
          fieldType: 'relationship',
          targetDefinition: definition.id,
        },
      ],
    },
  })
  const createNote = (related) =>
    payload.create({
      ...privileged,
      collection: entrySlug,
      data: {
        title: 'Privileged note',
        definition: notes.id,
        values: [{ fieldKey: 'venue', relationshipValue: related }],
      },
    })
  const note = await createNote(first.id)
  assert.equal(value(note, 'venue', 'relationshipValue'), first.id)
  const updated = await payload.update({
    ...privileged,
    collection: entrySlug,
    id: note.id,
    data: { values: [{ fieldKey: 'venue', relationshipValue: second.id }] },
  })
  assert.equal(value(updated, 'venue', 'relationshipValue'), second.id)
  await assert.rejects(createNote(note.id), { status: 400 })
}

async function verifyUnsupportedPostgresFields({ payload, manager, user }) {
  for (const fieldType of ['json', 'richText']) {
    const data = {
      title: 'Unsupported field',
      slug: `unsupported-${fieldType.toLowerCase()}`,
      fields: [{ key: 'content', fieldType }],
    }
    await manager('POST', definitions, 400, data)
    await assert.rejects(
      payload.create({ collection: definitionSlug, data, overrideAccess: false, user }),
      { status: 400 },
    )
  }
}

function lexicalDocument(text) {
  const block = { direction: null, format: '', indent: 0, version: 1 }
  return {
    root: {
      ...block,
      type: 'root',
      children: [
        {
          ...block,
          type: 'paragraph',
          textFormat: 0,
          textStyle: '',
          children: text
            ? [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }]
            : [],
        },
      ],
    },
  }
}

async function verifyPostgresFields({
  payload,
  manager,
  outsider,
  outsiderUser,
  schemaName,
  user,
}) {
  const definitionField = namedField(payload.collections[definitionSlug].config.fields, 'fields')
  const types = namedField(definitionField.fields, 'fieldType').options
  assert.ok(types.some(({ label, value }) => label === 'JSON' && value === 'json'))
  assert.ok(types.some(({ label, value }) => label === 'Rich Text' && value === 'richText'))
  const valueFields = namedField(payload.collections[entrySlug].config.fields, 'values').fields
  assert.equal(namedField(valueFields, 'jsonValue').type, 'json')
  assert.equal(namedField(valueFields, 'richTextValue').type, 'richText')

  const { rows: columns } = await payload.db.pool.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name IN ('collection_entries_values', 'collection_entry_items_1')
       AND column_name IN ('json_value', 'rich_text_value')
     ORDER BY table_name, column_name`,
    [schemaName],
  )
  assert.deepEqual(
    columns.map(({ table_name, column_name, data_type }) => [table_name, column_name, data_type]),
    [
      ['collection_entries_values', 'json_value', 'jsonb'],
      ['collection_entries_values', 'rich_text_value', 'jsonb'],
      ['collection_entry_items_1', 'json_value', 'jsonb'],
      ['collection_entry_items_1', 'rich_text_value', 'jsonb'],
    ],
  )

  const documentFields = [
    { key: 'metadata', fieldType: 'json', required: true },
    { key: 'body', fieldType: 'richText', required: true },
    {
      key: 'details',
      fieldType: 'group',
      fields: [
        { key: 'extra', fieldType: 'json' },
        { key: 'note', fieldType: 'richText' },
      ],
    },
  ]
  const local = { user, overrideAccess: false, depth: 0 }
  const definitionsData = { title: 'Content', slug: 'content', fields: documentFields }
  const definition = await payload.create({
    ...local,
    collection: definitionSlug,
    data: definitionsData,
  })
  const scope = await manager('GET', `${definitions}/${definition.id}?depth=0`, 200)
  assert.deepEqual(
    scope.fields.map(({ fieldType }) => fieldType),
    ['json', 'richText', 'group'],
  )

  const data = {
    metadata: { numbers: [0, 1], nested: { flag: false, clear: null } },
    body: lexicalDocument('Created using Local API'),
    extra: 0,
    note: lexicalDocument('Nested document'),
  }
  const emptyLexical = lexicalDocument('')
  const valueRows = ({ metadata, body, extra, note }) => [
    { fieldKey: 'metadata', jsonValue: metadata },
    { fieldKey: 'body', richTextValue: body },
    {
      fieldKey: 'details',
      rows: [
        {
          items: [
            { fieldKey: 'extra', jsonValue: extra },
            { fieldKey: 'note', richTextValue: note },
          ],
        },
      ],
    },
  ]
  const readDocument = (entry) => {
    const { items } = value(entry, 'details', 'rows')[0]
    return {
      metadata: value(entry, 'metadata', 'jsonValue'),
      body: value(entry, 'body', 'richTextValue'),
      extra: nestedValue(items, 'extra', 'jsonValue'),
      note: nestedValue(items, 'note', 'richTextValue'),
    }
  }

  const created = await payload.create({
    ...local,
    collection: entrySlug,
    data: { title: 'Created locally', definition: definition.id, values: valueRows(data) },
  })
  const path = `${entries}/${created.id}?depth=0`
  assert.deepEqual(readDocument(await manager('GET', path, 200)), data)
  await outsider('GET', path, 403)
  await outsider('PATCH', path, 403, { values: valueRows(data) })
  await assert.rejects(
    payload.findByID({ ...local, user: outsiderUser, collection: entrySlug, id: created.id }),
    { status: 403 },
  )

  const changed = {
    metadata: ['updated', { active: true }],
    body: lexicalDocument('Updated using REST API'),
    extra: false,
    note: emptyLexical,
  }
  await manager('PATCH', path, 200, { values: valueRows(changed) })
  const read = () => payload.findByID({ ...local, collection: entrySlug, id: created.id })
  assert.deepEqual(readDocument(await read()), changed)

  const { doc: renamed } = await manager('PATCH', path, 200, { title: 'Only the title changed' })
  assert.deepEqual(readDocument(renamed), changed)

  const restCreated = await createEntry(
    manager,
    'Created using REST',
    definition.id,
    valueRows(data),
  )
  const withEmptyString = { ...data, metadata: '{"keep":"string"}', extra: '' }
  await payload.update({
    ...local,
    collection: entrySlug,
    id: restCreated.id,
    data: { values: valueRows(withEmptyString) },
  })
  const restPath = `${entries}/${restCreated.id}?depth=0`
  assert.deepEqual(readDocument(await manager('GET', restPath, 200)), withEmptyString)

  const jsonLookingStrings = { ...data, metadata: 'true', extra: '[0,1]' }
  await manager('PATCH', path, 200, { values: valueRows(jsonLookingStrings) })
  assert.deepEqual(readDocument(await read()), jsonLookingStrings)

  await manager('PATCH', path, 400, {
    values: valueRows({ ...data, body: { text: 'Not Lexical' } }),
  })
  await manager('PATCH', path, 400, { values: valueRows({ ...data, body: null }) })
  await manager('PATCH', path, 400, { values: valueRows({ ...data, body: emptyLexical }) })
  for (const children of [
    [],
    [{ type: 'unknown', version: 1 }],
    data.body.root.children[0].children,
    [{ ...data.body.root.children[0], $slots: { aside: { type: 'unknown', version: 1 } } }],
  ]) {
    await manager('PATCH', path, 400, {
      values: valueRows({ ...data, note: { root: { ...data.body.root, children } } }),
    })
  }
  await manager('PATCH', path, 400, { values: valueRows({ ...data, metadata: undefined }) })
  await assert.rejects(
    payload.update({
      ...local,
      collection: entrySlug,
      id: created.id,
      data: { values: valueRows({ ...data, metadata: { invalid: 1n } }) },
    }),
    { status: 400 },
  )
  await manager('PATCH', path, 400, {
    values: [{ fieldKey: 'metadata', richTextValue: data.body }, ...valueRows(data).slice(1)],
  })
  await manager('PATCH', path, 400, {
    values: [
      { fieldKey: 'metadata', jsonValue: data.metadata, jsonEditorInvalid: true },
      ...valueRows(data).slice(1),
    ],
  })
  assert.deepEqual(readDocument(await read()), jsonLookingStrings)

  await payload.delete({ ...local, collection: entrySlug, id: created.id })
  await manager('GET', path, 404)
  await manager('DELETE', restPath, 200)
  await assert.rejects(payload.findByID({ ...local, collection: entrySlug, id: restCreated.id }), {
    status: 404,
  })
}

test('the native plugin works on a clean SQLite installation', async (t) => {
  await withFixture(async (fixture) => {
    await t.test('saves typed array fields and filters a numeric row in its collection', () =>
      verifyTypedStorage(fixture),
    )
    await t.test('rejects invalid configurations and submitted values', () =>
      verifyValidation(fixture),
    )
    await t.test('omits PostgreSQL-only field types from the SQLite APIs', () =>
      verifyUnsupportedPostgresFields(fixture),
    )
    await t.test('round-trips code, radio, slug, and nested fields with native arrays', () =>
      verifyAdditionalFieldTypes(fixture),
    )
    await t.test('uses typed relationships and uploads with configured targets', () =>
      verifyReferences(fixture),
    )
    await t.test(
      'updates the schema within a shared request and honors explicit Local API access override',
      () => verifyLocalAPI(fixture),
    )
  })
})

const postgresURL = process.env.TEST_DATABASE_URL

async function verifyEmptyFieldEvolution({ payload, manager }) {
  const keep = { key: 'keep', label: 'Keep', fieldType: 'text' }
  const amount = { key: 'amount', label: 'Amount', fieldType: 'text' }
  const obsolete = { key: 'obsolete', label: 'Obsolete', fieldType: 'text' }
  const definition = await createDefinition(manager, 'Evolution', 'evolution', [
    keep,
    amount,
    obsolete,
  ])
  const definitionPath = `${definitions}/${definition.id}?depth=0`
  const path = (entry) => `${entries}/${entry.id}?depth=0`
  const docs = []
  for (const [index, populated] of [true, false, true].entries()) {
    docs.push(
      await createEntry(manager, `Entry ${index}`, definition.id, [
        { fieldKey: 'keep', textValue: `Preserve ${index}` },
        { fieldKey: 'amount', textValue: populated ? '123' : null },
        { fieldKey: 'obsolete', textValue: populated ? 'Old note' : null },
      ]),
    )
  }
  const number = { ...amount, fieldType: 'number' }
  const blocked = async (fields, field) => {
    const error = await manager('PATCH', definitionPath, 409, { fields })
    assert.ok(JSON.stringify(error).includes(field.key))
    assert.ok(JSON.stringify(error).includes(field.label))
  }
  const denyBoth = async (field, alternative) => {
    await blocked([keep, alternative], field)
    await blocked([keep], field)
  }
  const clear = async (entry) =>
    manager('PATCH', path(entry), 200, {
      values: entry.values.map((row) =>
        row.fieldKey === 'keep' ? row : { ...row, textValue: null },
      ),
    })
  for (const cleared of [undefined, docs[0]]) {
    if (cleared) await clear(cleared)
    await blocked([keep, number, obsolete], amount)
    await blocked([keep, amount], obsolete)
  }
  await clear(docs[2])
  await manager('PATCH', definitionPath, 409, {
    fields: [keep, { ...number, required: true, defaultNumber: 1 }, obsolete],
  })
  await manager('PATCH', definitionPath, 200, { fields: [keep, number] })

  // GET still contains empty SQL legacy rows. Both a normal form submission and
  // a title-only PATCH must safely reconcile them, preserving unrelated values/IDs.
  for (const [index, entry] of docs.entries()) {
    const loaded = await manager('GET', path(entry), 200)
    assert.equal(value(loaded, 'amount', 'textValue'), null)
    assert.equal(value(loaded, 'obsolete', 'textValue'), null)
    if (index === 1) {
      const old = valueRow(loaded.values, 'obsolete')
      await manager('PATCH', path(entry), 400, {
        values: [...loaded.values, { fieldKey: 'unknown' }],
      })
      await manager('PATCH', path(entry), 400, {
        values: loaded.values.map((row) => (row === old ? { ...row, id: randomUUID() } : row)),
      })
      await manager('PATCH', path(entry), 400, {
        values: loaded.values.map((row) => (row === old ? { ...row, textValue: 'Spoofed' } : row)),
      })
      await manager('PATCH', path(entry), 400, {
        values: loaded.values.map((row) =>
          row === old ? { ...row, jsonEditorInvalid: true } : row,
        ),
      })
    }
    // A same-ID API row may inherit old hidden metadata from Payload. A value
    // supplied in the new column must still be accepted without fieldType.
    const submitted = loaded.values.map((row) =>
      index === 2 && row.fieldKey === 'amount'
        ? { id: row.id, fieldKey: row.fieldKey, numberValue: 17 }
        : row,
    )
    const { doc: saved } = await manager(
      'PATCH',
      path(entry),
      200,
      index === 0 ? { title: 'Title only' } : { values: submitted },
    )
    assert.equal(value(saved, 'keep', 'textValue'), `Preserve ${index}`)
    assert.equal(valueRow(saved.values, 'keep').id, valueRow(entry.values, 'keep').id)
    assert.equal(valueRow(saved.values, 'amount').id, valueRow(entry.values, 'amount').id)
    assert.equal(valueRow(saved.values, 'amount').fieldType, 'number')
    assert.equal(value(saved, 'amount', 'numberValue'), index === 2 ? 17 : null)
    assert.ok(!saved.values.some(({ fieldKey }) => fieldKey === 'obsolete'))
    if (index === 2) {
      await manager('PATCH', path(entry), 200, {
        values: saved.values.map((row) =>
          row.fieldKey === 'amount' ? { ...row, numberValue: null } : row,
        ),
      })
    }
  }
  await manager('POST', entries, 400, {
    title: 'Unknown empty key',
    definition: definition.id,
    values: [{ fieldKey: 'obsolete', textValue: null }],
  })

  const types = [
    'text',
    'textarea',
    'code',
    'slug',
    'email',
    'date',
    'select',
    'radio',
    'relationship',
    'upload',
  ]
  if (payload.db.name === 'postgres') types.push('json', 'richText')
  for (const fieldType of types) {
    const field = {
      ...amount,
      fieldType,
      ...(['select', 'radio'].includes(fieldType)
        ? { options: [{ label: 'One', value: 'one' }] }
        : {}),
      ...(fieldType === 'relationship' ? { targetDefinition: definition.id } : {}),
    }
    await manager('PATCH', definitionPath, 200, { fields: [keep, field] })
    const { doc } = await manager('PATCH', path(docs[0]), 200, { title: `Empty ${fieldType}` })
    assert.equal(valueRow(doc.values, 'amount').fieldType, fieldType)
    if (fieldType === 'slug') {
      await manager('PATCH', path(docs[0]), 409, {
        values: doc.values.map((row) =>
          row.fieldKey === 'amount' ? { ...row, fieldType: 'text', textValue: 'Stale Text' } : row,
        ),
      })
      assert.equal(value(await manager('GET', path(docs[0]), 200), 'amount', 'textValue'), null)
      const { doc: fresh } = await manager('PATCH', path(docs[0]), 200, {
        values: [
          { fieldKey: 'keep', textValue: 'Preserve 0' },
          { fieldKey: 'amount', textValue: 'Fresh Slug' },
        ],
      })
      assert.equal(value(fresh, 'amount', 'textValue'), 'fresh-slug')
      await manager('PATCH', path(docs[0]), 200, {
        values: fresh.values.map((row) =>
          row.fieldKey === 'amount' ? { ...row, textValue: null } : row,
        ),
      })
    }
    if (fieldType === 'relationship') {
      await manager('PATCH', definitionPath, 409, { fields: [keep, { ...field, hasMany: true }] })
    }
    const values =
      fieldType === 'json'
        ? [0, false, '', {}, [], [null]]
        : fieldType === 'richText'
          ? [lexicalDocument('')]
          : []
    for (const stored of values) {
      const column = fieldType === 'json' ? 'jsonValue' : 'richTextValue'
      const { doc: filled } = await manager('PATCH', path(docs[0]), 200, {
        values: [
          { fieldKey: 'keep', textValue: 'Preserve 0' },
          { fieldKey: 'amount', [column]: stored },
        ],
      })
      await denyBoth(field, number)
      await manager('PATCH', path(docs[0]), 200, {
        values: filled.values.map((row) =>
          row.fieldKey === 'amount' ? { ...row, [column]: null } : row,
        ),
      })
    }
  }
  await manager('PATCH', definitionPath, 200, { fields: [keep, number] })
  const { doc: zero } = await manager('PATCH', path(docs[0]), 200, {
    values: [
      { fieldKey: 'keep', textValue: 'Preserve 0' },
      { fieldKey: 'amount', numberValue: 0 },
    ],
  })
  await denyBoth(number, amount)
  await manager('PATCH', path(docs[0]), 200, {
    values: zero.values.map((row) =>
      row.fieldKey === 'amount' ? { ...row, numberValue: null } : row,
    ),
  })

  // Seed old-column/nested legacy data through the adapter, bypassing entry
  // validation only in this fixture. Schema checks must inspect every column.
  const empty = await manager('GET', path(docs[0]), 200)
  const seed = (rows) =>
    payload.db.updateOne({ collection: entrySlug, id: empty.id, data: { values: rows } })
  for (const legacy of [
    { textValue: 'An old value' },
    {
      rows: [
        {
          id: randomUUID(),
          items: [
            {
              id: randomUUID(),
              fieldKey: 'child',
              fieldLabel: 'Child',
              fieldType: 'text',
              textValue: 'Nested',
            },
          ],
        },
      ],
    },
  ]) {
    await seed(empty.values.map((row) => (row.fieldKey === 'amount' ? { ...row, ...legacy } : row)))
    await denyBoth(number, amount)
    await seed(empty.values)
  }

  const checkbox = { ...amount, fieldType: 'checkbox' }
  await manager('PATCH', definitionPath, 200, { fields: [keep, checkbox] })
  await manager('PATCH', path(docs[0]), 200, {
    values: [
      { fieldKey: 'keep', textValue: 'Preserve 0' },
      { fieldKey: 'amount', checkboxValue: false },
    ],
  })
  await denyBoth(checkbox, amount)
}

for (const [adapter, url] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `empty optional leaf fields can evolve safely on ${adapter}`,
    { skip: adapter === 'PostgreSQL' && !url },
    () => withFixture(verifyEmptyFieldEvolution, url, undefined, [], true),
  )
}

test('SQLite without adapter transactions keeps destructive schema edits fail-closed', () =>
  withFixture(async ({ manager }) => {
    const keep = { key: 'keep', label: 'Keep', fieldType: 'text' }
    const field = { key: 'empty', label: 'Empty', fieldType: 'text' }
    const definition = await createDefinition(manager, 'No transactions', 'no-transactions', [
      keep,
      field,
    ])
    const entry = await createEntry(manager, 'Empty entry', definition.id, [])
    await manager('PATCH', `${definitions}/${definition.id}`, 409, { fields: [keep] })
    await manager('PATCH', `${definitions}/${definition.id}`, 409, {
      fields: [keep, { ...field, fieldType: 'number' }],
    })
    await manager('PATCH', `${entries}/${entry.id}`, 200, { title: 'Ordinary updates still work' })
  }))

for (const [adapter, url] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `custom slugs and labels work with host collections on ${adapter}`,
    { skip: adapter === 'PostgreSQL' && !url },
    () =>
      withFixture(
        async (fixture) => {
          const { payload, manager, outsider, user } = fixture
          const definitions = '/api/content-types'
          const entries = '/api/content-records'

          assert.deepEqual(payload.collections['content-types'].config.labels, {
            singular: 'Content type',
            plural: 'Content types',
          })
          assert.deepEqual(payload.collections['content-records'].config.labels, {
            singular: 'Record',
            plural: 'Entries',
          })
          assert.ok(payload.db.rawTables.collection_definitions)
          assert.ok(payload.db.rawTables.collection_entries_values)
          await manager('GET', '/api/collections', 200)
          await manager('GET', '/api/entries', 200)
          await outsider('GET', definitions, 403)
          await outsider('GET', entries, 403)

          const definition = await payload.create({
            collection: 'content-types',
            overrideAccess: false,
            user,
            data: { title: 'Rooms', slug: 'rooms', fields: [capacity] },
          })
          const room = await createEntry(
            manager,
            'Lobby',
            definition.id,
            [{ fieldKey: 'capacity', numberValue: 25 }],
            entries,
          )
          const found = await payload.findByID({
            collection: 'content-records',
            id: room.id,
            depth: 0,
            overrideAccess: false,
            user,
          })
          assert.equal(found.definition, definition.id)
          assert.equal(value(found, 'capacity', 'numberValue'), 25)
          await manager('DELETE', `${definitions}/${definition.id}`, 409)
          await verifyReferences(fixture, { definitions, entries })
        },
        url,
        {
          collections: {
            slug: 'content-types',
            labels: { singular: 'Content type', plural: 'Content types' },
          },
          entries: { slug: 'content-records', labels: { singular: 'Record' } },
        },
        [
          { slug: 'collections', fields: [] },
          { slug: 'entries', fields: [] },
        ],
      ),
  )
}

for (const [adapter, url] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `prefixed storage coexists with host collections on ${adapter}`,
    { skip: adapter === 'PostgreSQL' && !url },
    () =>
      withFixture(
        async ({ payload, manager }) => {
          const definitions = '/api/content-types'
          const entries = '/api/content-records'
          const names = payload.db.rawTables
          for (const name of [
            'collection_definitions',
            'collection_entries',
            'workshop_definitions',
            '_workshop_definitions_v_version_fields',
            'workshop_def_fields_l1',
            '_workshop_def_fields_l1_v',
            'workshop_def_fields_l2',
            '_workshop_def_fields_l2_v',
            'workshop_entries',
            'workshop_entries_values',
            '_workshop_entries_v_version_values',
            'workshop_entry_rows_1',
            '_workshop_entry_rows_1_v',
            'workshop_entry_rows_2',
            '_workshop_entry_rows_2_v',
            'workshop_entry_items_1',
            '_workshop_entry_items_1_v',
            'workshop_entry_items_2',
            '_workshop_entry_items_2_v',
          ]) {
            assert.ok(names[name], `Missing physical table ${name}`)
          }
          assert.equal(names._workshop_definitions_v_version_fields.columns.label.notNull, true)
          assert.deepEqual(
            names.workshop_entries_values.indexes.workshop_values_key_number_parent_idx.on,
            ['fieldKey', 'numberValue', '_parentID'],
          )
          assert.equal(
            names.workshop_entries_values.indexes.collection_values_key_number_parent_idx,
            undefined,
          )

          const { doc: hostDefinition } = await manager('POST', '/api/collections', 201, {
            label: 'Existing host definition',
          })
          const { doc: hostEntry } = await manager('POST', '/api/entries', 201, {
            note: 'Existing host entry',
          })
          const fieldType = url ? 'json' : 'text'
          const column = url ? 'jsonValue' : 'textValue'
          const schema = [
            capacity,
            { key: 'data', fieldType },
            {
              key: 'settings',
              fieldType: 'group',
              fields: [
                {
                  key: 'nested',
                  fieldType: 'group',
                  fields: [{ key: 'metadata', fieldType }],
                },
              ],
            },
          ]
          const definition = await createDefinition(manager, 'Rooms', 'rooms', schema, definitions)
          const values = [
            { fieldKey: 'capacity', numberValue: 42 },
            { fieldKey: 'data', [column]: '{"literal":true}' },
            {
              fieldKey: 'settings',
              rows: [
                {
                  items: [
                    {
                      fieldKey: 'nested',
                      rows: [{ items: [{ fieldKey: 'metadata', [column]: '[0,1]' }] }],
                    },
                  ],
                },
              ],
            },
          ]
          const entry = await createEntry(manager, 'Lobby', definition.id, values, entries)
          await manager('PATCH', `${definitions}/${definition.id}`, 200, {
            fields: [...schema, { key: 'extra', fieldType: 'text' }],
          })
          const { doc: updated } = await manager('PATCH', `${entries}/${entry.id}`, 200, {
            title: 'Renamed lobby',
          })
          assert.equal(value(updated, 'data', column), '{"literal":true}')
          const versions = await manager('GET', `${entries}/versions?depth=0`, 200)
          const original = versions.docs.find(({ version }) => version.title === 'Lobby')
          assert.ok(original)
          assert.equal(value(original.version, 'data', column), '{"literal":true}')
          const nested = value(original.version, 'settings', 'rows')[0].items[0]
          assert.equal(nested.rows[0].items[0][column], '[0,1]')
          const restored = await manager('POST', `${entries}/versions/${original.id}?depth=0`, 200)
          assert.equal(restored.id, entry.id)
          assert.equal(restored.title, 'Lobby')
          assert.equal(restored.definition, definition.id)
          assert.equal(
            (await manager('GET', `/api/collections/${hostDefinition.id}`, 200)).label,
            'Existing host definition',
          )
          assert.equal(
            (await manager('GET', `/api/entries/${hostEntry.id}`, 200)).note,
            'Existing host entry',
          )
        },
        url,
        {
          collections: { slug: 'content-types' },
          entries: { slug: 'content-records' },
          storagePrefix: 'workshop',
        },
        [
          {
            slug: 'collections',
            dbName: 'collection_definitions',
            timestamps: false,
            versions: false,
            fields: [{ name: 'label', type: 'text', required: true }],
          },
          {
            slug: 'entries',
            dbName: 'collection_entries',
            fields: [{ name: 'note', type: 'text', required: true }],
          },
        ],
        true,
      ),
  )
}

for (const [adapter, url] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(`prefixed storage rejects aliases that could overwrite the host catalog on ${adapter}`, {
    skip: adapter === 'PostgreSQL' && !url,
  }, async () => {
    const options = {
      collections: { slug: 'content-types' },
      entries: { slug: 'content-records' },
      storagePrefix: 'workshop',
    }
    const field = { name: 'legacyField', type: 'text' }
    const cases = [
      {
        host: { slug: 'legacy', dbName: () => 'workshop_entries', fields: [field] },
        error: /SQL (name|table) "workshop_entries" conflicts/,
      },
      {
        host: { slug: 'legacy', dbName: 'Workshop_Entries', fields: [field] },
        error: /SQL name "Workshop_Entries" conflicts/,
      },
      {
        host: { slug: 'workshop-entries-values', fields: [field] },
        error: /SQL name "workshop_entries_values" conflicts/,
      },
      {
        host: { slug: 'workshop-entries-values', dbName: 'legacy_content', fields: [field] },
        error: /SQL name "workshop_entries_values" conflicts/,
      },
      {
        host: {
          slug: 'content',
          fields: [{ name: 'records', type: 'array', fields: [field] }],
        },
        error: /SQL registration "content_records" conflicts/,
      },
      {
        host: {
          slug: 'content',
          versions: false,
          fields: [{ name: 'records', type: 'array', dbName: 'workshop_entries', fields: [field] }],
        },
        error: /SQL (name|table) "workshop_entries" conflicts/,
      },
      {
        host: {
          slug: 'content',
          versions: false,
          fields: [
            {
              name: 'records',
              type: 'array',
              dbName: () => 'workshop_entries',
              fields: [field],
            },
          ],
        },
        error: /SQL (name|table) "workshop_entries" conflicts/,
      },
    ]
    for (const { host, error } of cases) {
      await assert.rejects(
        withFixture(
          () => assert.fail('A conflicting SQL layout must never connect'),
          url,
          options,
          [host],
        ),
        error,
      )
    }
  })
}

for (const [adapter, url] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `prefixed storage rejects generated relationship table conflicts on ${adapter}`,
    {
      skip: adapter === 'PostgreSQL' && !url,
    },
    () =>
      assert.rejects(
        withFixture(
          () => assert.fail('A conflicting SQL layout must never connect'),
          url,
          { storagePrefix: 'workshop' },
          [
            {
              slug: 'work',
              fields: [
                { type: 'relationship', name: 'assignees', relationTo: ['users'], hasMany: true },
              ],
            },
          ],
          false,
          { relationshipsSuffix: 'shop_entries' },
        ),
        /SQL table "workshop_entries" conflicts/,
      ),
  )
}

test(
  'prefixed storage rejects generated PostgreSQL enum and table conflicts',
  {
    skip: !postgresURL,
  },
  () =>
    assert.rejects(
      withFixture(
        () => assert.fail('A conflicting SQL layout must never connect'),
        postgresURL,
        { storagePrefix: 'enum' },
        [{ slug: 'entry', fields: [{ type: 'select', name: 'rows_1', options: ['legacy'] }] }],
      ),
      /SQL enum "enum_entry_rows_1" conflicts/,
    ),
)

test(
  'prefixed storage rejects duplicate PostgreSQL enums with conflicting options',
  { skip: !postgresURL },
  () =>
    assert.rejects(
      withFixture(
        () => assert.fail('A conflicting SQL layout must never connect'),
        postgresURL,
        { storagePrefix: 'enum' },
        [
          {
            slug: 'legacy',
            fields: [
              {
                type: 'select',
                name: 'tier',
                options: ['legacy'],
                enumName: 'enum_enum_definitions_fields_field_type',
              },
            ],
          },
        ],
      ),
      /SQL enum "enum_enum_definitions_fields_field_type" has conflicting options/,
    ),
)

test('concurrent prefixed initialization preserves shared host callbacks', async () => {
  const dbName = () => 'legacy_records'
  const config = buildConfig({
    secret: randomBytes(32).toString('hex'),
    db: sqliteAdapter({ client: { url: 'file::memory:' } }),
    logger: { options: { level: 'fatal' } },
    telemetry: false,
    graphQL: { disable: true },
    typescript: { autoGenerate: false },
    collections: [{ slug: 'legacy', dbName, fields: [] }],
    plugins: [payloadDynamic({ canManage: () => true, storagePrefix: 'workshop' })],
  })
  const instances = await Promise.all(
    [randomUUID(), randomUUID()].map((key) => getPayload({ config, key, disableDBConnect: true })),
  )
  try {
    assert.equal((await config).collections.find(({ slug }) => slug === 'legacy').dbName, dbName)
    for (const payload of instances) {
      assert.equal(payload.collections.legacy.config.dbName, dbName)
      assert.ok(payload.db.rawTables.legacy_records)
      assert.ok(payload.db.rawTables.workshop_entries)
    }
  } finally {
    await Promise.all(instances.map((payload) => payload.destroy()))
  }
})

for (const [adapter, uri] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `singleton definitions enforce one current entry and retain native versions on ${adapter}`,
    { skip: adapter === 'PostgreSQL' && !uri },
    () =>
      withFixture(
        async ({ payload, manager, user }) => {
          const { doc: settings } = await manager('POST', `${definitions}?depth=0`, 201, {
            title: 'Settings',
            slug: 'settings',
            singleton: true,
            fields: [capacity],
          })
          const regular = await createDefinition(manager, 'Regular', 'regular', [capacity])
          assert.equal(settings.singleton, true)
          assert.equal(regular.singleton, false)
          await manager('PATCH', `${definitions}/${settings.id}`, 409, { singleton: false })
          await manager('PATCH', `${definitions}/${regular.id}`, 409, { singleton: true })

          const results = await Promise.allSettled(
            ['First', 'Second'].map((title, i) =>
              payload.create({
                collection: entrySlug,
                data: {
                  title,
                  definition: settings.id,
                  singletonKey: `untrusted-${i}`,
                  values: [{ fieldKey: 'capacity', numberValue: 123 }],
                },
                depth: 0,
                overrideAccess: false,
                user,
              }),
            ),
          )
          const successes = results.filter((result) => result.status === 'fulfilled')
          assert.equal(successes.length, 1)
          const duplicate = results.find((result) => result.status === 'rejected')
          assert.ok(duplicate)
          assert.match(JSON.stringify(duplicate.reason), /unique/i)
          const original = successes[0].value
          const reread = await payload.findByID({
            collection: entrySlug,
            id: original.id,
            depth: 0,
            showHiddenFields: true,
            overrideAccess: true,
          })
          assert.equal(reread.singletonKey, String(settings.id))

          // Adapter writes bypass hooks. The table must independently reject
          // writing another row with the same key.
          await assert.rejects(
            payload.db.create({
              collection: entrySlug,
              data: {
                title: 'Duplicate raw key',
                definition: settings.id,
                singletonKey: String(settings.id),
              },
            }),
            (error) => /unique/i.test(JSON.stringify(error)),
          )
          await manager('POST', `${entries}/${original.id}/duplicate?depth=0`, 400, {})

          const baseline = await manager('GET', `${entries}/versions?depth=0`, 200)
          const version = baseline.docs.find(({ parent }) => parent === original.id)
          assert.ok(version)
          const { doc: modified } = await manager(
            'PATCH',
            `${entries}/${original.id}?depth=0`,
            200,
            {
              title: 'Modified',
              definition: regular.id,
              singletonKey: null,
              values: [{ fieldKey: 'capacity', numberValue: 456 }],
            },
          )
          assert.equal(modified.definition, settings.id)
          assert.equal(value(modified, 'capacity', 'numberValue'), 456)
          await assert.rejects(
            payload.update({
              collection: entrySlug,
              id: original.id,
              data: { definition: regular.id },
              overrideAccess: true,
            }),
            /cannot be changed/,
          )

          const restored = await manager('POST', `${entries}/versions/${version.id}?depth=0`, 200)
          assert.equal(restored.id, original.id)
          assert.equal(restored.definition, settings.id)
          assert.equal(restored.title, original.title)
          assert.equal(value(restored, 'capacity', 'numberValue'), 123)
          await manager('POST', entries, 400, {
            title: 'Duplicate after restore',
            definition: settings.id,
          })

          const first = await createEntry(manager, 'Regular first', regular.id, [])
          const second = await createEntry(manager, 'Regular second', regular.id, [])
          assert.notEqual(first.id, second.id)
          const counts = await Promise.all(
            [settings, regular].map(({ id }) =>
              payload.count({
                collection: entrySlug,
                where: { definition: { equals: id } },
                overrideAccess: true,
              }),
            ),
          )
          assert.deepEqual(
            counts.map(({ totalDocs }) => totalDocs),
            [1, 2],
          )
        },
        uri,
        { singletons: true, storagePrefix: 'oneonly' },
      ),
  )
}

const entryDrafts = { entries: { versions: { drafts: true, maxPerDoc: 0 } } }

async function verifyDraftFieldEvolution({ manager }) {
  const note = { key: 'note', label: 'Note', fieldType: 'text' }
  const draftOnly = await createDefinition(manager, 'Unpublished', 'unpublished', [note])
  const { doc: draft } = await manager('POST', `${entries}?draft=true&depth=0`, 201, {
    title: 'First draft',
    definition: draftOnly.id,
    values: [{ fieldKey: 'note', textValue: 'Unpublished entry' }],
  })
  assert.equal(draft._status, 'draft')
  await manager('DELETE', `${definitions}/${draftOnly.id}`, 409)

  const definition = await createDefinition(manager, 'Draft evolution', 'draft-evolution', [
    capacity,
    note,
  ])
  const definitionURL = `${definitions}/${definition.id}?depth=0`
  const publishedEmpty = await createEntry(manager, 'Published empty', definition.id, [])
  const liveURL = (entry) => `${entries}/${entry.id}?depth=0`
  const draftURL = (entry) => `${liveURL(entry)}&draft=true`
  const draftNote = (entry, textValue) =>
    manager('PATCH', draftURL(entry), 200, { values: [{ fieldKey: 'note', textValue }] })
  const number = { ...note, fieldType: 'number' }

  await draftNote(publishedEmpty, 'Draft value')
  assert.equal(value(await manager('GET', liveURL(publishedEmpty), 200), 'note', 'textValue'), null)
  assert.match(
    JSON.stringify(await manager('PATCH', definitionURL, 409, { fields: [capacity] })),
    /Note \(note\)/,
  )
  await manager('PATCH', definitionURL, 409, { fields: [capacity, number] })
  const stillEditable = await manager('PATCH', draftURL(publishedEmpty), 200, {
    title: 'Draft still editable',
  })
  assert.equal(value(stillEditable.doc, 'note', 'textValue'), 'Draft value')

  await draftNote(publishedEmpty, null)
  const publishedFilled = await createEntry(manager, 'Published filled', definition.id, [
    { fieldKey: 'note', textValue: 'Published value' },
  ])
  await draftNote(publishedFilled, null)
  // Latest drafts are now empty but the published value still protects the field.
  await manager('PATCH', definitionURL, 409, { fields: [capacity, number] })
  await manager('PATCH', liveURL(publishedFilled), 200, { _status: 'published' })

  // Older populated versions remain in history. Only the two active views block evolution.
  const { docs: versions } = await manager('GET', `${entries}/versions?depth=0`, 200)
  assert.ok(
    versions.some(
      ({ parent, version }) =>
        parent === publishedEmpty.id && value(version, 'note', 'textValue') === 'Draft value',
    ),
  )
  await manager('PATCH', definitionURL, 200, { fields: [capacity, number] })
  const { doc: evolved } = await manager('PATCH', draftURL(publishedEmpty), 200, {
    values: [{ fieldKey: 'note', numberValue: 7 }],
  })
  assert.equal(value(evolved, 'note', 'numberValue'), 7)
}

for (const [adapter, uri] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `field edits preserve values in published entries and latest drafts on ${adapter}`,
    { skip: adapter === 'PostgreSQL' && !uri },
    () => withFixture(verifyDraftFieldEvolution, uri, entryDrafts, [], true),
  )

  test(
    `singleton drafts publish to the same native ID on ${adapter}`,
    { skip: adapter === 'PostgreSQL' && !uri },
    () =>
      withFixture(
        async ({ payload, manager }) => {
          assert.equal(payload.collections[entrySlug].config.versions.maxPerDoc, 0)
          const { doc: settings } = await manager('POST', `${definitions}?depth=0`, 201, {
            title: 'Draft settings',
            slug: 'draft-settings',
            singleton: true,
            fields: [capacity],
          })
          const { doc: draft } = await manager('POST', `${entries}?draft=true&depth=0`, 201, {
            title: 'Unpublished',
            definition: settings.id,
            values: [{ fieldKey: 'capacity', numberValue: 12 }],
          })
          assert.equal(draft._status, 'draft')
          await manager('POST', `${entries}?draft=true&depth=0`, 400, {
            title: 'Second draft',
            definition: settings.id,
          })

          const { doc: published } = await manager('PATCH', `${entries}/${draft.id}?depth=0`, 200, {
            title: 'Published',
            _status: 'published',
            values: [{ fieldKey: 'capacity', numberValue: 34 }],
          })
          assert.equal(published.id, draft.id)
          assert.equal(published._status, 'published')
          assert.equal(value(published, 'capacity', 'numberValue'), 34)
          const { doc: pending } = await manager(
            'PATCH',
            `${entries}/${draft.id}?draft=true&depth=0`,
            200,
            { title: 'Next draft', values: [{ fieldKey: 'capacity', numberValue: 56 }] },
          )
          assert.equal(pending.id, draft.id)
          assert.equal(value(pending, 'capacity', 'numberValue'), 56)

          const live = await manager('GET', `${entries}/${draft.id}?draft=false&depth=0`, 200)
          assert.equal(live.title, 'Published')
          assert.equal(value(live, 'capacity', 'numberValue'), 34)
          const { doc: nextDraft } = await manager(
            'PATCH',
            `${entries}/${draft.id}?draft=true&depth=0`,
            200,
            { title: 'Second save', values: [{ fieldKey: 'capacity', numberValue: 67 }] },
          )
          assert.equal(nextDraft.id, draft.id)
          assert.equal(value(nextDraft, 'capacity', 'numberValue'), 67)

          const { doc: republished } = await manager(
            'PATCH',
            `${entries}/${draft.id}?depth=0`,
            200,
            { _status: 'published' },
          )
          assert.equal(republished.id, draft.id)
          assert.equal(value(republished, 'capacity', 'numberValue'), 67)
          await manager('PATCH', `${entries}/${draft.id}?draft=true&depth=0`, 200, {
            title: 'Pending restore',
            values: [{ fieldKey: 'capacity', numberValue: 84 }],
          })
          const { docs } = await manager('GET', `${entries}/versions?depth=0`, 200)
          const earlier = docs.find(({ version }) => version.title === 'Published')
          assert.ok(earlier)
          const restored = await manager('POST', `${entries}/versions/${earlier.id}?depth=0`, 200)
          assert.equal(restored.id, draft.id)
          assert.equal(restored._status, 'published')
          assert.equal(value(restored, 'capacity', 'numberValue'), 34)

          // Bulk writes without the draft flag start from the published
          // document even when Payload also has a newer pending draft.
          await manager('PATCH', `${entries}/${draft.id}?draft=true&depth=0`, 200, {
            title: 'Pending bulk',
            values: [{ fieldKey: 'capacity', numberValue: 91 }],
          })
          const where = new URLSearchParams({ 'where[id][equals]': String(draft.id), depth: '0' })
          const { docs: updated } = await manager('PATCH', `${entries}?${where}`, 200, {
            title: 'Bulk title',
          })
          assert.equal(updated.length, 1)
          assert.equal(value(updated[0], 'capacity', 'numberValue'), 34)

          assert.ok(docs.length >= 6)
          assert.ok(docs.every(({ parent }) => parent === draft.id))
          assert.ok(
            docs.some(
              ({ version }) => version._status === 'draft' && version.title === 'Next draft',
            ),
          )
          await manager('POST', entries, 400, {
            title: 'Another live entry',
            definition: settings.id,
          })
          const { totalDocs } = await payload.count({
            collection: entrySlug,
            where: { definition: { equals: settings.id } },
            overrideAccess: true,
          })
          assert.equal(totalDocs, 1)
        },
        uri,
        { ...entryDrafts, singletons: true, storagePrefix: 'oneonly' },
        [],
        true,
      ),
  )
}

for (const [adapter, uri] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `draft-only entry and media references block deletion on ${adapter}`,
    { skip: adapter === 'PostgreSQL' && !uri },
    () =>
      withFixture(
        async ({ payload, manager, user }) => {
          const targetDefinition = await createDefinition(manager, 'Targets', 'targets', [capacity])
          const target = await createEntry(manager, 'Linked entry', targetDefinition.id, [])
          const file = Buffer.from('Draft-only upload')
          const upload = await payload.create({
            collection: 'media',
            user,
            overrideAccess: false,
            data: {},
            file: { name: 'draft-only.txt', mimetype: 'text/plain', data: file, size: file.length },
          })
          const owner = await createDefinition(manager, 'Owners', 'owners', [
            { key: 'link', fieldType: 'relationship', targetDefinition: targetDefinition.id },
            { key: 'upload', fieldType: 'upload' },
          ])
          const published = await createEntry(manager, 'Reference owner', owner.id, [])
          const draftURL = `${entries}/${published.id}?draft=true&depth=0`
          const linkedValues = [
            { fieldKey: 'link', relationshipValue: target.id },
            { fieldKey: 'upload', uploadValue: upload.id },
          ]
          const { doc: draft } = await manager('PATCH', draftURL, 200, {
            values: linkedValues,
          })
          assert.equal(value(draft, 'link', 'relationshipValue'), target.id)
          assert.equal(value(draft, 'upload', 'uploadValue'), upload.id)
          const live = await manager('GET', `${entries}/${published.id}?draft=false&depth=0`, 200)
          assert.equal(value(live, 'link', 'relationshipValue'), null)
          assert.equal(value(live, 'upload', 'uploadValue'), null)
          await manager('DELETE', `${entries}/${target.id}`, 409)
          await manager('DELETE', `/api/media/${upload.id}`, 409)

          await manager('PATCH', `${entries}/${published.id}?depth=0`, 200, {
            _status: 'published',
          })
          await manager('PATCH', draftURL, 200, {
            values: [
              { fieldKey: 'link', relationshipValue: null },
              { fieldKey: 'upload', uploadValue: null },
            ],
          })
          // A draft clearing a reference must not hide the live reference.
          await manager('DELETE', `${entries}/${target.id}`, 409)
          await manager('DELETE', `/api/media/${upload.id}`, 409)
        },
        uri,
        entryDrafts,
        [],
        true,
      ),
  )
}

test(
  'JSON and Rich Text work in PostgreSQL through the Local and REST APIs',
  { skip: !postgresURL },
  () => withFixture(verifyPostgresFields, postgresURL),
)

for (const [adapter, url] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `typed values retain presence and sibling-scoped row keys on ${adapter}`,
    { skip: adapter === 'PostgreSQL' && !url },
    () =>
      withFixture(
        async ({ payload, manager }) => {
          const leaf = { key: 'label', fieldType: 'text' }
          const group = (key, ...fields) => ({ key, fieldType: 'group', fields })
          const array = (key, ...fields) => ({ key, fieldType: 'array', fields })
          const rows = (fieldKey, ...rows) => ({ fieldKey, rows })
          const item = (rowKey, ...items) => ({ rowKey, items })
          const textColumn = url ? 'jsonValue' : 'textValue'
          const textLeaf = url ? { key: 'label', fieldType: 'json' } : leaf
          const minimum = await createDefinition(manager, 'Minimum', 'minimum', [
            { ...array('required_rows', leaf), minRows: 1 },
          ])
          await manager('POST', entries, 400, { title: 'Missing rows', definition: minimum.id })
          const withRows = await createEntry(manager, 'One row', minimum.id, [
            rows('required_rows', item('first')),
          ])
          await manager('PATCH', `${entries}/${withRows.id}`, 400, {
            values: [{ fieldKey: 'required_rows', rows: null }],
          })
          const targetDefinition = await createDefinition(manager, 'Targets', 'targets', [leaf])
          const target = await createEntry(manager, 'Nested link target', targetDefinition.id, [])
          const link = {
            key: 'link',
            fieldType: 'relationship',
            targetDefinition: targetDefinition.id,
          }
          const blocks = {
            key: 'content',
            fieldType: 'blocks',
            fields: [group('card', textLeaf)],
          }
          const definition = await createDefinition(manager, 'Nested page', 'nested-page', [
            group('section', array('items', textLeaf, link)),
            blocks,
            group('optional', { ...leaf, required: true }),
            array('empty_array', leaf),
            { key: 'empty_string', fieldType: 'text' },
            ...(url ? [{ key: 'empty_json', fieldType: 'json' }] : []),
            { key: 'defaulted', fieldType: 'text', defaultText: 'Default' },
          ])
          const section = rows(
            'section',
            item(
              undefined,
              rows(
                'items',
                item(
                  'native-item-1',
                  { fieldKey: 'label', [textColumn]: '[0,1]' },
                  { fieldKey: 'link', relationshipValue: target.id },
                ),
                item('native-item-2', { fieldKey: 'label', [textColumn]: 'second' }),
              ),
            ),
          )
          const explicit = [
            section,
            rows('content', {
              ...item('native-block', { fieldKey: 'label', [textColumn]: 'A card' }),
              blockKey: 'card',
            }),
            { fieldKey: 'empty_array', rows: [] },
            { fieldKey: 'empty_string', textValue: '' },
            ...(url ? [{ fieldKey: 'empty_json', jsonValue: [], valuePresence: 'absent' }] : []),
            { fieldKey: 'defaulted', valuePresence: 'absent' },
          ]
          const original = await createEntry(manager, 'Before', definition.id, explicit)
          // The same Native row identities can exist under another entry.
          const sibling = await createEntry(manager, 'Other entry', definition.id, explicit)
          const nestedRows = (doc) =>
            nestedValue(value(doc, 'section', 'rows')[0].items, 'items', 'rows')
          const path = `${entries}/${original.id}?depth=0`
          const read = await manager('GET', path, 200)
          const stored = nestedRows(read)
          assert.deepEqual(
            stored.map(({ rowKey }) => rowKey),
            ['native-item-1', 'native-item-2'],
          )
          assert.notEqual(stored[0].id, nestedRows(sibling)[0].id)
          assert.equal(valueRow(stored[0].items, 'label')[textColumn], '[0,1]')
          assert.equal(value(read, 'optional', 'valuePresence'), 'absent')
          assert.equal(value(read, 'empty_array', 'valuePresence'), 'value')
          assert.equal(value(read, 'empty_string', 'textValue'), '')
          if (url) {
            assert.equal(value(read, 'empty_json', 'valuePresence'), 'value')
            assert.deepEqual(value(read, 'empty_json', 'jsonValue'), [])
          }
          assert.equal(value(read, 'defaulted', 'valuePresence'), 'absent')
          assert.equal(value(read, 'content', 'rows')[0].rowKey, 'native-block')
          await manager('DELETE', `${entries}/${target.id}`, 409)

          const changed = structuredClone(explicit)
          const changedRows = nestedRows({ values: changed })
          changedRows.reverse()
          await manager('PATCH', path, 400, {
            values: [...changed, rows('optional', item(undefined))],
          })
          const { doc: updated } = await manager('PATCH', path, 200, {
            title: 'Reordered',
            values: [...changed, { fieldKey: 'optional', rows: null }],
          })
          assert.equal(value(updated, 'optional', 'valuePresence'), 'null')
          assert.deepEqual(
            nestedRows(updated).map(({ id }) => id),
            stored.map(({ id }) => id).reverse(),
          )
          changedRows[1].rowKey = changedRows[0].rowKey
          await manager('PATCH', path, 400, { values: changed })
          const { doc: present } = await manager('PATCH', path, 200, {
            values: [
              ...explicit,
              rows('optional', item(undefined, { fieldKey: 'label', textValue: 'Group value' })),
            ],
          })
          assert.equal(value(present, 'optional', 'valuePresence'), 'value')
          const { doc: cleared } = await manager('PATCH', path, 200, {
            values: [...explicit, { fieldKey: 'optional', rows: [] }],
          })
          assert.equal(value(cleared, 'optional', 'valuePresence'), 'null')
          const { doc: afterTitle } = await manager('PATCH', path, 200, { title: 'After' })
          assert.equal(value(afterTitle, 'optional', 'valuePresence'), 'null')
          const versions = await manager('GET', `${entries}/versions?depth=0`, 200)
          const version = versions.docs.find(({ version }) => version.title === 'Before')
          assert.ok(version)
          assert.equal(value(version.version, 'optional', 'valuePresence'), 'absent')
          assert.deepEqual(
            nestedRows(version.version).map(({ rowKey }) => rowKey),
            ['native-item-1', 'native-item-2'],
          )
          assert.equal(value(version.version, 'content', 'rows')[0].rowKey, 'native-block')
          const restored = await manager('POST', `${entries}/versions/${version.id}?depth=0`, 200)
          assert.equal(value(restored, 'optional', 'valuePresence'), 'absent')
          assert.equal(valueRow(nestedRows(restored)[0].items, 'label')[textColumn], '[0,1]')

          const legacy = structuredClone(version.version)
          const legacyRow = nestedRows(legacy)[0]
          legacyRow.id = 'legacy-array-item'
          delete legacyRow.rowKey
          const legacyVersion = await payload.db.createVersion({
            collectionSlug: entrySlug,
            parent: restored.id,
            versionData: legacy,
            createdAt: version.createdAt,
            updatedAt: version.updatedAt,
            autosave: false,
          })
          const restoreLegacy = () =>
            manager('POST', `${entries}/versions/${legacyVersion.id}?depth=0`, 200)
          const firstLegacyRestore = nestedRows(await restoreLegacy())[0]
          assert.equal(firstLegacyRestore.rowKey, legacyRow.id)
          const secondLegacyRestore = nestedRows(await restoreLegacy())[0]
          assert.equal(secondLegacyRestore.rowKey, firstLegacyRestore.rowKey)
          assert.equal(secondLegacyRestore.id, firstLegacyRestore.id)
        },
        url,
        {
          entries: { versions: true, preserveValuePresence: true, stableRowKeys: true },
        },
        [],
        true,
      ),
  )
}

test('admin copies and pastes retain the existing row identity on overwrite', () => {
  const rows = [
    { id: 'copy-above', key: 'native-1' },
    { id: 'old', key: 'pasted-from-another-entry' },
    { id: 'copy-below', key: 'native-1' },
    { id: 'different-sibling', key: 'native-2' },
  ]
  const { updates, owners } = reconcileSiblingRowKeys(rows, new Map([['native-1', 'old']]))
  assert.equal(updates.size, 3)
  assert.equal(updates.get(0), null)
  assert.equal(updates.get(1), 'native-1')
  assert.equal(updates.get(2), null)
  assert.equal(owners.get('native-1'), 'old')
  assert.equal(owners.get('native-2'), 'different-sibling')
  const legacy = reconcileSiblingRowKeys([{ id: 'legacy' }], new Map())
  const pasted = reconcileSiblingRowKeys([{ id: 'legacy', key: 'foreign-key' }], legacy.owners)
  assert.equal(pasted.updates.get(0), 'legacy')
})

test('operation policies differentiate create and update during explicit validation', () =>
  withFixture(
    async ({ payload, manager, user, outsiderUser }) => {
      const data = { title: 'Room', slug: 'room', fields: [capacity] }
      const validateAs = (user, options) =>
        payload.validate({
          collection: definitionSlug,
          data,
          user,
          overrideAccess: false,
          ...options,
        })
      assert.equal((await validateAs(user)).valid, true)
      await assert.rejects(validateAs(outsiderUser), { status: 403 })

      const { doc } = await manager('POST', definitions, 201, data)
      await assert.rejects(validateAs(user, { id: doc.id }), { status: 403 })
      assert.equal((await validateAs(outsiderUser, { id: doc.id })).valid, true)
    },
    undefined,
    {
      collections: {
        access: {
          create: ({ req }) => req.user?.email === 'manager@example.test',
          update: ({ req }) => req.user?.email === 'other@example.test',
        },
      },
    },
  ))

for (const [adapter, url] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(`workspace scopes and operation-specific policies apply on ${adapter}`, {
    skip: adapter === 'PostgreSQL' && !url,
  }, async () => {
    const memberships = new Map()
    const signedIn = ({ req }) => Boolean(req.user)
    await withFixture(
      async ({ payload, manager, outsider, outsiderUser, user, login, anonymous }) => {
        const north = await payload.create({
          collection: 'workspaces',
          data: { name: 'North' },
          overrideAccess: true,
        })
        const south = await payload.create({
          collection: 'workspaces',
          data: { name: 'South' },
          overrideAccess: true,
        })
        const { request: shared, user: sharedUser } = await login('shared@example.test')
        memberships.set(user.email, [north.id])
        memberships.set(outsiderUser.email, [south.id])
        memberships.set(sharedUser.email, [north.id, south.id])

        const definition = (workspace, title) => ({
          title,
          slug: 'rooms',
          workspace,
          fields: [capacity],
        })
        const { doc: northRooms } = await manager('POST', `${definitions}?depth=0`, 201, {
          ...definition(north.id, 'North rooms'),
        })
        const { doc: southRooms } = await outsider('POST', `${definitions}?depth=0`, 201, {
          ...definition(south.id, 'South rooms'),
        })
        await manager('DELETE', `/api/workspaces/${north.id}`, 409)
        const { request: noWorkspace } = await login('no-workspace@example.test')
        await noWorkspace('GET', definitions, 403)
        await noWorkspace('GET', entries, 403)
        await manager('POST', definitions, 400, definition(north.id, 'Duplicate in North'))
        await manager('POST', definitions, 403, definition(south.id, 'Outside North'))
        await shared('PATCH', `${definitions}/${northRooms.id}`, 409, { workspace: south.id })
        await outsider('PATCH', `${definitions}/${northRooms.id}`, 403, { title: 'Foreign title' })
        await outsider('GET', `${definitions}/${northRooms.id}`, 404)
        assert.deepEqual(
          (await outsider('GET', definitions, 200)).docs.map(({ id }) => id),
          [southRooms.id],
        )
        await anonymous('GET', definitions, 403)
        const copiedDefinition = await manager(
          'POST',
          `${definitions}/${northRooms.id}/duplicate?depth=0`,
          200,
          {},
        )
        assert.equal(copiedDefinition.doc.workspace, north.id)
        assert.match(copiedDefinition.doc.slug, /^rooms-copy-[a-f0-9]{12}$/)
        await outsider('POST', `${definitions}/${northRooms.id}/duplicate`, 403, {})

        const relatedRoom = (targetDefinition) => ({
          key: 'room',
          label: 'Room',
          fieldType: 'relationship',
          targetDefinition,
        })
        const links = (targetDefinition) => ({
          title: 'Links',
          slug: 'links',
          workspace: north.id,
          fields: [relatedRoom(targetDefinition)],
        })
        await shared('POST', definitions, 400, links(southRooms.id))
        const { doc: northLinks } = await shared(
          'POST',
          `${definitions}?depth=0`,
          201,
          links(northRooms.id),
        )

        const values = [{ fieldKey: 'capacity', numberValue: 25 }]
        const northEntry = await createEntry(manager, 'North lobby', northRooms.id, values)
        const southEntry = await createEntry(outsider, 'South lobby', southRooms.id, values)
        const copiedEntry = await manager(
          'POST',
          `${entries}/${northEntry.id}/duplicate?depth=0`,
          200,
          {},
        )
        assert.equal(copiedEntry.doc.definition, northRooms.id)
        assert.equal(value(copiedEntry.doc, 'capacity', 'numberValue'), 25)
        await outsider('POST', `${entries}/${northEntry.id}/duplicate`, 403, {})

        const scopedCreate = await manager(
          'POST',
          `${entries}?depth=0&entryDefinition=${northRooms.id}`,
          201,
          { title: 'Created from scoped list', values },
        )
        assert.equal(scopedCreate.doc.definition, northRooms.id)
        await createEntry(outsider, 'Hidden entry', southRooms.id, values)
        await outsider('POST', `${entries}?entryDefinition=${northRooms.id}`, 403, {
          title: 'Foreign default',
          values,
        })
        await outsider('POST', `${entries}?entryDefinition=${southRooms.id}`, 403, {
          title: 'Forged definition',
          definition: northRooms.id,
          workspace: south.id,
          values,
        })
        await outsider('GET', `${entries}/${northEntry.id}`, 404)
        await outsider('PATCH', `${entries}/${northEntry.id}`, 403, { title: 'Foreign edit' })
        await outsider('PATCH', `${entries}/${southEntry.id}`, 200, { title: 'Own edit' })
        await outsider('DELETE', `${entries}/${southEntry.id}`, 403)
        await manager('DELETE', `${entries}/${southEntry.id}`, 403)
        await shared('POST', entries, 400, {
          title: 'Cross-workspace relationship',
          definition: northLinks.id,
          values: [{ fieldKey: 'room', relationshipValue: southEntry.id }],
        })

        assert.deepEqual(
          (await outsider('GET', entries, 200)).docs.map(({ id }) => id),
          [southEntry.id],
        )
        const localFind = await payload.find({
          collection: entrySlug,
          depth: 0,
          overrideAccess: false,
          user: outsiderUser,
        })
        assert.deepEqual(
          localFind.docs.map(({ id }) => id),
          [southEntry.id],
        )
        await assert.rejects(
          payload.create({
            collection: entrySlug,
            data: { title: 'Foreign Local API entry', definition: northRooms.id, values },
            overrideAccess: false,
            user: outsiderUser,
          }),
          { status: 403 },
        )

        const trustedEntry = await payload.create({
          collection: entrySlug,
          data: { title: 'Trusted North entry', definition: northRooms.id, values },
          depth: 0,
          overrideAccess: true,
          user: outsiderUser,
        })
        assert.equal(trustedEntry.definition, northRooms.id)
        assert.equal(value(trustedEntry, 'capacity', 'numberValue'), 25)
        await assert.rejects(
          payload.create({
            collection: definitionSlug,
            data: { ...links(southRooms.id), slug: 'trusted-cross-workspace' },
            overrideAccess: true,
            user: outsiderUser,
          }),
          { status: 400, message: /target collection does not exist in this workspace/ },
        )

        assert.equal((await outsider('GET', `${entries}/count`, 200)).totalDocs, 1)
        const bothEntries = new URLSearchParams({
          'where[id][in]': `${northEntry.id},${southEntry.id}`,
          depth: '0',
        })
        const updated = await outsider('PATCH', `${entries}?${bothEntries}`, 200, {
          title: 'Scoped bulk edit',
        })
        assert.deepEqual(
          updated.docs.map(({ id }) => id),
          [southEntry.id],
        )
        assert.equal(updated.docs[0].title, 'Scoped bulk edit')
        assert.equal(
          (await manager('GET', `${entries}/${northEntry.id}`, 200)).title,
          'North lobby',
        )

        const northVersions = await manager('GET', `${entries}/versions?depth=0`, 200)
        const northVersion = northVersions.docs.find(({ parent }) => parent === northEntry.id)
        assert.ok(northVersion)
        await outsider('GET', `${entries}/versions/${northVersion.id}`, 403)
        await manager('PATCH', `${entries}/${northEntry.id}`, 200, { title: 'Renamed lobby' })
        await outsider('POST', `${entries}/versions/${northVersion.id}`, 403)
        const restored = await manager(
          'POST',
          `${entries}/versions/${northVersion.id}?depth=0`,
          200,
        )
        assert.equal(restored.id, northEntry.id)
        assert.equal(restored.title, 'North lobby')
        assert.equal(restored.definition, northRooms.id)
        const southVersions = await outsider('GET', `${entries}/versions?depth=0`, 200)
        assert.ok(southVersions.docs.length)
        assert.ok(southVersions.docs.every(({ parent }) => parent === southEntry.id))

        const deleted = await manager('DELETE', `${entries}?${bothEntries}`, 200)
        assert.deepEqual(
          deleted.docs.map(({ id }) => id),
          [northEntry.id],
        )
        await manager('GET', `${entries}/${northEntry.id}`, 404)
        assert.equal(
          (await outsider('GET', `${entries}/${southEntry.id}`, 200)).title,
          'Scoped bulk edit',
        )

        const sameWorkspaceLink = await createEntry(shared, 'North link', northLinks.id, [
          { fieldKey: 'room', relationshipValue: trustedEntry.id },
        ])
        assert.equal(value(sameWorkspaceLink, 'room', 'relationshipValue'), trustedEntry.id)

        // Simulate a legacy link left behind by an incomplete workspace backfill.
        await payload.db.updateOne({
          collection: definitionSlug,
          id: northLinks.id,
          data: { fields: [{ ...northLinks.fields[0], targetDefinition: southRooms.id }] },
        })
        const invalidLink = await shared('POST', entries, 400, {
          title: 'Legacy cross-workspace relationship',
          definition: northLinks.id,
          values: [{ fieldKey: 'room', relationshipValue: southEntry.id }],
        })
        assert.match(invalidLink.errors[0].message, /outside its target or inaccessible/)

        memberships.delete(outsiderUser.email)
        await outsider('GET', definitions, 403)
        await outsider('GET', `${entries}/count`, 403)
        await outsider('GET', `${entries}/versions`, 403)
        await outsider('PATCH', `${entries}/${southEntry.id}`, 403, { title: 'Revoked edit' })
      },
      url,
      {
        collections: { access: { create: signedIn, read: signedIn, update: signedIn } },
        entries: {
          access: {
            create: signedIn,
            read: ({ req }) => Boolean(req.user) && { title: { not_equals: 'Hidden entry' } },
            update: signedIn,
          },
        },
        workspace: {
          collection: 'workspaces',
          allowedIDs: async (req) => memberships.get(req.user?.email) ?? [],
        },
      },
      [{ slug: 'workspaces', fields: [{ name: 'name', type: 'text' }] }],
      true,
    )
  })
}

for (const [adapter, uri] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(`uploads always belong to the entry workspace on ${adapter}`, {
    skip: adapter === 'PostgreSQL' && !uri,
  }, async () => {
    const workspaces = []
    const validationEntered = Promise.withResolvers()
    const finishValidation = Promise.withResolvers()
    await withFixture(
      async ({ payload, manager, user }) => {
        const addWorkspace = (name) =>
          payload.create({ collection: 'workspaces', data: { name }, user, overrideAccess: false })
        const [north, south] = [await addWorkspace('North'), await addWorkspace('South')]
        workspaces.push(north.id, south.id)
        const addFile = (workspace, name) => {
          const data = Buffer.from(name)
          return payload.create({
            collection: 'workspace-media',
            data: { workspace },
            user,
            overrideAccess: false,
            file: { name: `${name}.txt`, mimetype: 'text/plain', data, size: data.length },
          })
        }
        const own = await addFile(north.id, 'north')
        const other = await addFile(south.id, 'south')
        const historical = await addFile(north.id, 'historical')
        const { doc: definition } = await manager('POST', definitions, 201, {
          title: 'Articles',
          slug: 'articles',
          workspace: north.id,
          fields: [
            { key: 'asset', fieldType: 'upload' },
            { key: 'gallery', fieldType: 'upload', hasMany: true },
            ...(uri ? [{ key: 'body', fieldType: 'richText' }] : []),
          ],
        })
        const entryData = {
          title: 'Article',
          definition: definition.id,
          values: [
            { fieldKey: 'asset', uploadValue: own.id },
            { fieldKey: 'gallery', uploadValues: [own.id] },
          ],
        }
        assert.equal(
          (await payload.validate({ collection: entrySlug, data: entryData, user })).valid,
          true,
        )
        const { doc: entry } = await manager('POST', `${entries}?depth=0`, 201, entryData)
        assert.equal(value(entry, 'asset', 'uploadValue'), own.id)
        assert.deepEqual(value(entry, 'gallery', 'uploadValues'), [own.id])
        const retained = await createEntry(manager, 'Retained file', definition.id, [
          { fieldKey: 'asset', uploadValue: historical.id },
        ])
        await manager('PATCH', `${entries}/${retained.id}`, 200, { values: [] })
        await manager('DELETE', `/api/workspace-media/${historical.id}`, 409)

        await manager('PATCH', `${entries}/${entry.id}?draft=true`, 400, {
          values: [{ fieldKey: 'gallery', uploadValues: [own.id, other.id] }],
        })
        await assert.rejects(
          payload.create({
            collection: entrySlug,
            overrideAccess: true,
            data: { ...entryData, values: [{ fieldKey: 'asset', uploadValue: other.id }] },
          }),
          { status: 400, message: /outside its target or inaccessible/ },
        )
        await assert.rejects(
          payload.update({
            collection: 'workspace-media',
            id: own.id,
            overrideAccess: true,
            data: { workspace: south.id },
          }),
          { status: 400, message: /workspace of an uploaded file cannot be changed/ },
        )

        if (uri) {
          const lexicalOnly = await addFile(north.id, 'lexical-only')
          const embedded = (id) => {
            const doc = lexicalDocument('Media attached')
            doc.root.children.push({
              type: 'upload',
              id: 'embedded-file',
              relationTo: 'workspace-media',
              value: id,
              fields: {},
              format: '',
              version: 1,
            })
            return { fieldKey: 'body', richTextValue: doc }
          }
          const valid = await payload.create({
            collection: entrySlug,
            depth: 0,
            user,
            overrideAccess: false,
            data: { ...entryData, values: [embedded(lexicalOnly.id)] },
          })
          assert.equal(
            value(valid, 'body', 'richTextValue').root.children.at(-1).value,
            lexicalOnly.id,
          )
          await manager('DELETE', `/api/workspace-media/${lexicalOnly.id}`, 409)
          await manager('PATCH', `${entries}/${valid.id}`, 200, { values: [] })
          await manager('DELETE', `/api/workspace-media/${lexicalOnly.id}`, 409)
          await assert.rejects(
            payload.create({
              collection: entrySlug,
              overrideAccess: true,
              data: { ...entryData, values: [...entryData.values, embedded(other.id)] },
            }),
            { status: 400, message: /rich text file is outside this workspace/ },
          )

          const attachment = await addFile(north.id, 'concurrent-attachment')
          const save = payload.create({
            collection: entrySlug,
            context: { pauseScopedUploadValidation: true },
            overrideAccess: true,
            data: { ...entryData, values: [embedded(attachment.id)] },
          })
          await Promise.race([
            validationEntered.promise,
            save.then(() => assert.fail('Save finished before the upload validation pause.')),
          ])
          const deleting = payload
            .delete({
              collection: 'workspace-media',
              id: attachment.id,
              overrideAccess: true,
            })
            .then(
              () => 200,
              (error) => error.status,
            )
          let waiting = false
          try {
            const deadline = Date.now() + 3_000
            while (!waiting && Date.now() < deadline) {
              const result = await payload.db.pool.query(`
                  SELECT 1 FROM pg_stat_activity
                  WHERE wait_event_type = 'Lock' AND query LIKE '%workspace_media%for update%'
                `)
              waiting = result.rows.length > 0
              if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20))
            }
          } finally {
            finishValidation.resolve()
          }
          await save
          assert.equal(await deleting, 409)
          assert.equal(waiting, true)
        }

        const later = new Date(Date.now() + 10_000).toISOString()
        const imported = await payload.db.createVersion({
          collectionSlug: entrySlug,
          autosave: false,
          createdAt: later,
          parent: entry.id,
          updatedAt: later,
          versionData: {
            ...entry,
            values: entry.values.map((row) =>
              row.fieldKey === 'asset' ? { ...row, uploadValue: other.id } : row,
            ),
          },
        })
        await manager('POST', `${entries}/versions/${imported.id}?depth=0`, 400)
        const unused = await addFile(north.id, 'unused')
        await manager('DELETE', `/api/workspace-media/${unused.id}`, 200)
      },
      uri,
      {
        ...entryDrafts,
        workspace: { collection: 'workspaces', allowedIDs: () => workspaces },
        uploadCollection: 'workspace-media',
        uploadWorkspaceField: 'workspace',
      },
      [
        { slug: 'workspaces', fields: [{ name: 'name', type: 'text' }] },
        {
          slug: 'workspace-media',
          upload: { disableLocalStorage: true },
          fields: [{ name: 'workspace', type: 'relationship', relationTo: 'workspaces' }],
          hooks: {
            afterRead: [
              async ({ doc, req }) => {
                if (req.context.pauseScopedUploadValidation) {
                  validationEntered.resolve()
                  await finishValidation.promise
                }
                return doc
              },
            ],
          },
        },
      ],
      true,
    )
  })
}

for (const [adapter, uri] of [
  ['SQLite', undefined],
  ['PostgreSQL', postgresURL],
]) {
  test(
    `definitions retain their own entry history on ${adapter}`,
    {
      skip: adapter === 'PostgreSQL' && !uri,
    },
    () =>
      withFixture(
        async ({ payload, manager, user }) => {
          const createDefinitionWithLimit = async (slug, limit) =>
            (
              await manager('POST', definitions, 201, {
                title: slug,
                slug,
                fields: [capacity],
                versionsMaxPerEntry: limit,
              })
            ).doc
          const small = await createDefinitionWithLimit('small-history', 1)
          const unlimited = await createDefinitionWithLimit('long-history', 0)
          const checked = await payload.validate({
            collection: entrySlug,
            data: { title: 'Validation only', definition: small.id },
            user,
          })
          assert.equal(checked.valid, true)
          const tracked = await createEntry(manager, 'Limited record', small.id, [])
          const sibling = await createEntry(manager, 'Sibling record', small.id, [])
          const retained = await createEntry(manager, 'Unlimited record', unlimited.id, [])
          const versions = async (id) =>
            (
              await manager(
                'GET',
                `${entries}/versions?where[parent][equals]=${id}&depth=0&sort=-id`,
                200,
              )
            ).docs
          const originalSibling = await versions(sibling.id)
          const originalRetained = await versions(retained.id)
          await manager('PATCH', `${entries}/${retained.id}`, 200, { title: 'Retained update' })
          await manager('PATCH', `${entries}/${tracked.id}?draft=true&select[title]=true`, 200, {
            title: 'Draft update',
          })
          const [draft] = await versions(tracked.id)
          assert.equal(draft.version.title, 'Draft update')
          assert.equal((await versions(tracked.id)).length, 1)
          assert.equal((await versions(sibling.id))[0].id, originalSibling[0].id)
          assert.ok((await versions(retained.id)).some(({ id }) => id === originalRetained[0].id))
          await manager('POST', `${entries}/versions/${draft.id}?depth=0`, 200)
          const restored = await versions(tracked.id)
          assert.equal(restored.length, 1)
          assert.equal(restored[0].version.title, 'Draft update')
        },
        uri,
        { entries: { versions: { drafts: true, maxPerDoc: 0 }, retentionByDefinition: true } },
        [],
        true,
      ),
  )
}
