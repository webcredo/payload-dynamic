import {
  type Access,
  APIError,
  type CollectionConfig,
  type CollectionSlug,
  type Condition,
  type Field,
  type FieldHook,
  type FilterOptions,
  type PayloadRequest,
  validations,
  type Where,
} from 'payload'
import { slugify } from 'payload/shared'
import {
  availableFieldTypes,
  type DefinitionField,
  definitionDepth,
  type FieldType,
} from './definitions'
import { type CollectionSlugs, entryDefinitionParam } from './entry-list'
import {
  allValueColumns,
  defaultValue,
  type ID,
  invalidJSONDraftKey,
  normalizeDate,
  referenceID,
  valueColumn,
} from './entry-values'
import { normalizePostgresValue, postgresValueFields } from './postgres-fields'

const entryAdminComponents = {
  arrayField: 'payload-dynamic/react#EntryFields',
  rowLabel: 'payload-dynamic/react#ValueRowLabel',
  choiceField: 'payload-dynamic/react#ChoiceField',
  textValueField: 'payload-dynamic/react#TextValueField',
  codeValueField: 'payload-dynamic/react#CodeValueField',
  nestedItemsField: 'payload-dynamic/react#EntryValueArray',
  nestedRowsField: 'payload-dynamic/react#NestedValueField',
  nestedRowLabel: 'payload-dynamic/react#NestedEntryRowLabel',
  blockTypeField: 'payload-dynamic/react#BlockTypeField',
}

function scopedDefinitionID(req: PayloadRequest) {
  const id = referenceID(req.query[entryDefinitionParam])
  if (typeof id !== 'string' || req.payload.db.defaultIDType !== 'number') return id
  const number = Number(id)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

type ValueRow = { id?: string | null; fieldKey: string; fieldPath?: string } & Record<
  string,
  unknown
>
type NestedRow = { id?: string; blockKey?: string; items: ValueRow[] }

const visible =
  (type: FieldType, many?: boolean): Condition =>
  (_, row) =>
    row.fieldType === type && (many === undefined || Boolean(row.fieldMany) === many)

const visibleFor =
  (...types: FieldType[]): Condition =>
  (_, row) =>
    types.includes(row.fieldType)

function findField(fields: DefinitionField[], path: string) {
  let current = fields
  let field: DefinitionField | undefined
  for (const key of path.split('.')) {
    field = current.find((item) => item.key === key)
    if (!field) return undefined
    current = field.fields ?? []
  }
  return field
}

export function entryValueReferences(
  id: ID,
  ...columns: ('relationshipValue' | 'relationshipValues' | 'uploadValue' | 'uploadValues')[]
): Where[] {
  return Array.from({ length: definitionDepth + 1 }, (_, depth) =>
    columns.map((column) => ({
      [`values${'.rows.items'.repeat(depth)}.${column}`]: { equals: id },
    })),
  ).flat()
}

function readSchema(
  req: PayloadRequest,
  definitionSlug: CollectionSlug,
  id: ID,
  overrideAccess = false,
) {
  return req.payload
    .findByID({
      collection: definitionSlug,
      id,
      req,
      depth: 0,
      overrideAccess,
      disableErrors: true,
    })
    .then((doc) =>
      doc && 'fields' in doc && Array.isArray(doc.fields)
        ? (doc.fields as DefinitionField[])
        : undefined,
    )
}

function entryHooks({
  definitionSlug,
  entrySlug,
  uploadCollection,
}: CollectionSlugs & { uploadCollection?: CollectionSlug }) {
  // Native relationship controls ask for filters per row during one form-state request.
  const schemas = new WeakMap<PayloadRequest, Map<string, ReturnType<typeof readSchema>>>()
  function getPickerSchema(req: PayloadRequest, id: ID) {
    let byID = schemas.get(req)
    if (!byID) {
      byID = new Map()
      schemas.set(req, byID)
    }
    const key = String(id)
    let pending = byID.get(key)
    if (!pending) {
      pending = readSchema(req, definitionSlug, id)
      byID.set(key, pending)
    }
    return pending
  }

  const filterReferences =
    (depth: number): FilterOptions =>
    async ({ data, siblingData, req }) => {
      const id = referenceID(data?.definition)
      const row = siblingData as Partial<ValueRow> | undefined
      const path = depth === 0 ? row?.fieldKey : row?.fieldPath
      if (id === undefined || typeof path !== 'string') return false
      const fields = await getPickerSchema(req, id)
      const field = fields && findField(fields, path)
      const target = referenceID(field?.targetDefinition)
      return field?.fieldType === 'relationship' && target !== undefined
        ? { definition: { equals: target } }
        : false
    }

  async function normalizeReference(
    field: DefinitionField,
    value: unknown,
    req: PayloadRequest,
    overrideAccess: boolean,
  ) {
    const list = field.hasMany ? value : [value]
    if (!Array.isArray(list) || list.length > 100) {
      throw new APIError(
        `Choose ${field.hasMany ? 'at most 100 entries' : 'one entry'} for ${field.label}.`,
        400,
      )
    }
    const ids: ID[] = []
    const keys = new Set<string>()
    for (const item of list) {
      const id = referenceID(item)
      if (id === undefined || keys.has(String(id))) {
        throw new APIError(`Choose valid, distinct entries for ${field.label}.`, 400)
      }
      keys.add(String(id))
      ids.push(id)
    }
    if (!ids.length) return []
    const target = referenceID(field.targetDefinition)
    const collection = field.fieldType === 'upload' ? uploadCollection : entrySlug
    if (!collection || (field.fieldType === 'relationship' && target === undefined)) {
      throw new APIError(`The target for ${field.label} is unavailable.`, 400)
    }
    const { docs } = await req.payload.find({
      collection,
      depth: 0,
      limit: ids.length,
      overrideAccess,
      req,
      select: { id: true },
      where: {
        id: { in: ids },
        ...(field.fieldType === 'relationship' ? { definition: { equals: target } } : {}),
      },
    })
    if (docs.length !== ids.length) {
      throw new APIError(
        `Some selections for ${field.label} are outside its target or inaccessible.`,
        400,
      )
    }
    return field.hasMany ? ids : ids[0]
  }

  async function normalizeValue(
    field: DefinitionField,
    value: unknown,
    req: PayloadRequest,
    overrideAccess: boolean,
  ) {
    if (field.fieldType === 'json' || field.fieldType === 'richText') {
      return normalizePostgresValue(field.fieldType, value, {
        required: Boolean(field.required),
        label: field.label,
      })
    }
    if (
      value == null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0 && field.hasMany)
    ) {
      if (field.required) throw new APIError(`${field.label} is required.`, 400)
      return null
    }
    switch (field.fieldType) {
      case 'text':
      case 'textarea':
      case 'email':
      case 'code':
      case 'slug':
        if (typeof value === 'string' && !/[\0\p{Surrogate}]/u.test(value)) {
          const text = field.fieldType === 'slug' ? slugify(value) : value
          if (!text) break
          if (
            (field.minLength != null && text.length < field.minLength) ||
            (field.maxLength != null && text.length > field.maxLength)
          ) {
            throw new APIError(`${field.label} is outside its configured length.`, 400)
          }
          return text
        }
        break
      case 'number':
        if (typeof value === 'number' && Number.isFinite(value)) {
          if (
            (field.min != null && value < field.min) ||
            (field.max != null && value > field.max)
          ) {
            throw new APIError(`${field.label} is outside its configured range.`, 400)
          }
          return value
        }
        break
      case 'checkbox':
        if (typeof value === 'boolean') return value
        break
      case 'date': {
        const normalized = normalizeDate(value)
        if (normalized) return normalized
        break
      }
      case 'select':
      case 'radio':
        if (typeof value === 'string' && field.options?.some((option) => option.value === value)) {
          return value
        }
        break
      case 'relationship':
      case 'upload':
        return normalizeReference(field, value, req, overrideAccess)
    }
    throw new APIError(`Enter a valid ${field.fieldType} for ${field.label}.`, 400)
  }

  type Operation = { req: PayloadRequest; overrideAccess: boolean }

  async function normalizeRows(
    field: DefinitionField,
    value: unknown,
    previousRows: NestedRow[],
    fieldPath: string,
    operation: Operation,
  ): Promise<NestedRow[]> {
    const { fieldType, label } = field
    const singleton = fieldType === 'group' || fieldType === 'tabs'
    const rows = value === undefined ? previousRows : value
    if (rows !== null && !Array.isArray(rows)) {
      throw new APIError(`${label}: rows must be an array.`, 400)
    }
    const input = rows ?? []
    const maxRows = singleton ? 1 : (field.maxRows ?? 100)
    const minRows = Math.max(field.minRows ?? 0, field.required && !singleton ? 1 : 0)
    if (input.length < minRows || input.length > maxRows) {
      throw new APIError(`${label}: provide between ${minRows} and ${maxRows} rows.`, 400)
    }
    const previous = new Map(previousRows.map((row) => [row.id, row]))
    const seen = new Set<string>()
    const normalized = []
    for (const row of singleton && !input.length ? [{}] : input) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new APIError(`${label}: provide valid rows.`, 400)
      }
      let fields = field.fields ?? []
      let blockKey: string | undefined
      if (fieldType === 'blocks') {
        const block = fields.find(({ key }) => key === row.blockKey)
        if (!block) throw new APIError(`${label}: choose a valid block type.`, 400)
        blockKey = block.key
        fields = block.fields ?? []
      } else if (row.blockKey != null && row.blockKey !== '') {
        throw new APIError(`${label}: a block type is only allowed for blocks.`, 400)
      }
      if (typeof row.id === 'string') {
        if (seen.has(row.id)) throw new APIError(`${label}: row IDs must be distinct.`, 400)
        seen.add(row.id)
      }
      const match = singleton ? previousRows[0] : previous.get(row.id)
      const previousRow = blockKey === (match?.blockKey ?? undefined) ? match : undefined
      normalized.push({
        id: previousRow?.id,
        blockKey,
        items: await normalizeValues(
          fields,
          row.items,
          previousRow?.items ?? [],
          blockKey ? `${fieldPath}.${blockKey}` : fieldPath,
          operation,
        ),
      })
    }
    return normalized
  }

  async function normalizeValues(
    fields: DefinitionField[],
    value: unknown,
    previousRows: ValueRow[],
    parentPath: string,
    operation: Operation,
  ): Promise<ValueRow[]> {
    const previous = new Map(previousRows.map((row) => [row.fieldKey, row]))
    const input = value === undefined ? previousRows : value
    if (!Array.isArray(input)) throw new APIError('Values must be an array.', 400)
    const rows = new Map<string, ValueRow>()
    for (const row of input) {
      if (!row || typeof row.fieldKey !== 'string' || rows.has(row.fieldKey)) {
        throw new APIError('Provide at most one value row for each field.', 400)
      }
      rows.set(row.fieldKey, row)
    }

    const values = []
    for (const field of fields) {
      const row = rows.get(field.key)
      const previousRow = previous.get(field.key)
      const column = valueColumn(field)
      const fieldPath = parentPath ? `${parentPath}.${field.key}` : field.key
      rows.delete(field.key)
      if (field.fieldType === 'json' && row?.[invalidJSONDraftKey] === true) {
        throw new APIError(`${field.label}: Enter valid JSON.`, 400)
      }
      if (
        row &&
        allValueColumns.some((key) => {
          const value = row[key]
          const emptyArray = Array.isArray(value) && value.length === 0
          return key !== column && value != null && (key === 'jsonValue' || !emptyArray)
        })
      ) {
        throw new APIError(`Use the ${field.fieldType} value for ${field.label}.`, 400)
      }
      const submitted = row?.[column]
      const normalized =
        column === 'rows'
          ? await normalizeRows(
              field,
              submitted,
              Array.isArray(previousRow?.rows) ? previousRow.rows : [],
              fieldPath,
              operation,
            )
          : await normalizeValue(
              field,
              !previousRow && submitted === undefined ? defaultValue(field) : submitted,
              operation.req,
              operation.overrideAccess,
            )
      values.push({
        id: previousRow?.id,
        fieldKey: field.key,
        ...(parentPath ? { fieldPath } : {}),
        fieldType: field.fieldType,
        fieldLabel: field.label,
        fieldMany: Boolean(field.hasMany),
        [column]: normalized,
      })
    }
    if (rows.size) throw new APIError('A value refers to a field outside this collection.', 400)
    return values
  }

  // Field hooks receive the operation's overrideAccess and run before native field validation.
  const prepareValues: FieldHook = async ({
    data,
    originalDoc,
    overrideAccess = false,
    req,
    value,
  }) => {
    if (!data) return value
    const previousID = referenceID(originalDoc?.definition)
    const id = data.definition === undefined ? previousID : referenceID(data.definition)
    if (id === undefined || (previousID !== undefined && String(id) !== String(previousID))) {
      throw new APIError('Choose a collection when creating an entry. It cannot be changed.', 400)
    }
    const schema = await readSchema(req, definitionSlug, id, overrideAccess)
    if (!schema) throw new APIError('Collection definition is unavailable.', 400)
    return normalizeValues(schema, value, originalDoc?.values ?? [], '', { req, overrideAccess })
  }

  return { prepareValues, filterReferences }
}

// The array's write hook validates relationship scope. The picker uses filterOptions for UI only.
const validateRelationship: typeof validations.relationship = (value, options) =>
  validations.relationship(value, { ...options, filterOptions: undefined })

export function entryCollection({
  canManage,
  definitionSlug,
  entrySlug,
  labels,
  postgres,
  uploadCollection,
}: CollectionSlugs & {
  canManage: Access
  labels?: CollectionConfig['labels']
  postgres: boolean
  uploadCollection?: CollectionSlug
}): CollectionConfig {
  const { prepareValues, filterReferences } = entryHooks({
    definitionSlug,
    entrySlug,
    uploadCollection,
  })
  const fieldTypes = availableFieldTypes(postgres).map(({ value }) => value)

  function valueFields(depth: number): Field[] {
    const fields: Field[] = [
      { name: 'fieldKey', type: 'text', required: true, index: true, admin: { hidden: true } },
      { name: 'fieldLabel', type: 'text', required: true, admin: { hidden: true } },
      {
        name: 'fieldType',
        type: 'select',
        options: fieldTypes,
        required: true,
        admin: { hidden: true },
      },
      { name: 'fieldMany', type: 'checkbox', admin: { hidden: true } },
      {
        name: 'textValue',
        type: 'text',
        label: 'Text value',
        admin: {
          condition: visibleFor('text', 'slug'),
          components: { Field: entryAdminComponents.textValueField },
        },
      },
      {
        name: 'textareaValue',
        type: 'textarea',
        label: 'Long text value',
        admin: {
          condition: visibleFor('textarea', 'code'),
          components: { Field: entryAdminComponents.codeValueField },
        },
      },
      {
        name: 'emailValue',
        type: 'email',
        label: 'Email value',
        admin: { condition: visible('email') },
      },
      {
        name: 'numberValue',
        type: 'number',
        label: 'Numeric value',
        index: true,
        admin: { condition: visible('number') },
      },
      {
        name: 'checkboxValue',
        type: 'checkbox',
        label: 'Checkbox value',
        admin: { condition: visible('checkbox') },
      },
      {
        name: 'dateValue',
        type: 'date',
        label: 'Date value',
        index: true,
        admin: { condition: visible('date'), date: { pickerAppearance: 'dayAndTime' } },
      },
      {
        // The options live in the definition; a static SQL enum cannot differ per row.
        name: 'selectValue',
        type: 'text',
        label: 'Option value',
        maxLength: 100,
        index: true,
        admin: {
          condition: visibleFor('select', 'radio'),
          components: { Field: entryAdminComponents.choiceField },
        },
      },
      {
        name: 'relationshipValue',
        type: 'relationship',
        label: 'Related entry',
        relationTo: entrySlug,
        filterOptions: filterReferences(depth),
        validate: validateRelationship,
        admin: { allowCreate: false, condition: visible('relationship', false) },
      },
      {
        name: 'relationshipValues',
        type: 'relationship',
        label: 'Related entries',
        relationTo: entrySlug,
        hasMany: true,
        filterOptions: filterReferences(depth),
        validate: validateRelationship,
        admin: { allowCreate: false, condition: visible('relationship', true) },
      },
    ]
    if (depth > 0) {
      fields.push({ name: 'fieldPath', type: 'text', admin: { hidden: true } })
    }
    if (postgres) fields.push(...postgresValueFields())
    if (uploadCollection) {
      fields.push(
        {
          name: 'uploadValue',
          type: 'upload',
          label: 'File value',
          relationTo: uploadCollection,
          admin: { condition: visible('upload', false) },
        },
        {
          name: 'uploadValues',
          type: 'upload',
          label: 'File values',
          relationTo: uploadCollection,
          hasMany: true,
          admin: { condition: visible('upload', true) },
        },
      )
    }
    if (depth < definitionDepth) {
      const level = depth + 1
      fields.push({
        name: 'rows',
        type: 'array',
        dbName: `collection_entry_rows_${level}`,
        maxRows: 100,
        admin: {
          condition: visibleFor('array', 'group', 'blocks', 'tabs'),
          components: {
            Field: entryAdminComponents.nestedRowsField,
            RowLabel: entryAdminComponents.nestedRowLabel,
          },
        },
        fields: [
          {
            name: 'blockKey',
            type: 'text',
            maxLength: 50,
            admin: { components: { Field: entryAdminComponents.blockTypeField } },
          },
          {
            name: 'items',
            type: 'array',
            dbName: `collection_entry_items_${level}`,
            maxRows: 100,
            admin: {
              components: {
                Field: entryAdminComponents.nestedItemsField,
                RowLabel: entryAdminComponents.rowLabel,
              },
              isSortable: false,
            },
            fields: valueFields(level),
          },
        ],
      })
    }
    return fields
  }

  return {
    slug: entrySlug,
    // Keep the SQL table when the public slug changes.
    dbName: 'collection_entries',
    labels: { singular: labels?.singular ?? 'Entry', plural: labels?.plural ?? 'Entries' },
    admin: {
      group: false,
      useAsTitle: 'title',
      defaultColumns: ['title', 'updatedAt'],
      baseFilter: ({ req }) => {
        if (req.query[entryDefinitionParam] === undefined) return null
        const id = scopedDefinitionID(req)
        return { definition: id === undefined ? { exists: false } : { equals: id } }
      },
      components: {
        views: {
          list: {
            Component: {
              path: 'payload-dynamic/react#ScopedEntriesList',
              clientProps: { definitionSlug },
            },
          },
          edit: {
            default: {
              Component: {
                path: 'payload-dynamic/react#ScopedEntryEdit',
                clientProps: { definitionSlug },
              },
            },
          },
        },
      },
    },
    access: { create: canManage, read: canManage, update: canManage, delete: canManage },
    indexes: [{ fields: ['definition', 'createdAt'] }],
    fields: [
      { name: 'title', type: 'text', required: true },
      {
        name: 'definition',
        label: 'Collection',
        type: 'relationship',
        relationTo: definitionSlug,
        required: true,
        defaultValue: ({ req }) => scopedDefinitionID(req),
        access: { update: () => false },
        admin: { hidden: true },
      },
      {
        name: 'values',
        type: 'array',
        maxRows: 100,
        admin: {
          components: {
            Field: {
              path: entryAdminComponents.arrayField,
              clientProps: { definitionSlug, entrySlug },
            },
            RowLabel: entryAdminComponents.rowLabel,
          },
          isSortable: false,
        },
        fields: valueFields(0),
        hooks: { beforeChange: [prepareValues] },
      },
    ],
    hooks: {
      beforeDelete: [
        async ({ id, req }) => {
          const { totalDocs } = await req.payload.count({
            collection: entrySlug,
            overrideAccess: true,
            req,
            where: {
              id: { not_equals: id },
              or: entryValueReferences(id, 'relationshipValue', 'relationshipValues'),
            },
          })
          if (totalDocs) throw new APIError('Another entry still links to this entry.', 409)
        },
      ],
    },
  }
}
