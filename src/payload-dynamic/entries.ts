import { randomUUID } from 'node:crypto'
import {
  type Access,
  APIError,
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  type CollectionSlug,
  type Condition,
  type Field,
  type FieldHook,
  type FilterOptions,
  hasDraftsEnabled,
  type PayloadRequest,
  validations,
  type Where,
} from 'payload'
import { slugify } from 'payload/shared'
import {
  dynamicAccess,
  inheritDuplicateScope,
  type PayloadDynamicAccess,
  type PayloadDynamicWorkspace,
} from './access'
import {
  availableFieldTypes,
  type DefinitionField,
  definitionDepth,
  type FieldType,
} from './definitions'
import { type CollectionSlugs, entryDefinitionParam } from './entry-list'
import { hasEntryMatching } from './entry-queries'
import {
  defaultValue,
  hasStoredValue,
  type ID,
  invalidJSONDraftKey,
  isSingletonStructure,
  normalizeDate,
  referenceID,
  submittedValue,
  valueColumn,
  valuePresenceOptions,
} from './entry-values'
import { normalizePostgresValue, postgresValueFields } from './postgres-fields'
import { lockDefinition } from './schema-transaction'
import type { StorageNames } from './storage'
import { assertRichTextUploadScope, lockScopedUploads, uploadWorkspaceFilter } from './upload-scope'

export { hasEntryMatching as hasEntryValueReferences } from './entry-queries'

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
type NestedRow = { id?: string; rowKey?: string; blockKey?: string; items: ValueRow[] }

function isRowKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    !!value.trim() &&
    !/[\0\p{Surrogate}]/u.test(value)
  )
}

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
        ? {
            fields: doc.fields as DefinitionField[],
            workspaceID: 'workspace' in doc ? referenceID(doc.workspace) : undefined,
          }
        : undefined,
    )
}

function entryHooks({
  definitionSlug,
  entrySlug,
  uploadCollection,
  uploadWorkspaceField,
  scoped,
  preserveValuePresence,
  stableRowKeys,
  storage,
}: CollectionSlugs & {
  uploadCollection?: CollectionSlug
  uploadWorkspaceField?: string
  scoped: boolean
  preserveValuePresence: boolean
  stableRowKeys: boolean
  storage: StorageNames
}) {
  type Operation = { req: PayloadRequest; overrideAccess: boolean; workspaceID?: ID }

  // Payload loads the latest version for updates by ID and restores, but
  // bulk writes that are neither drafts nor trash operations start from main.
  const bulkUpdatesFromMain = new WeakSet<PayloadRequest>()
  const rememberUpdateSource: CollectionBeforeOperationHook = ({
    args,
    collection,
    operation,
    req,
  }) => {
    if (!hasDraftsEnabled(collection)) return
    if (operation === 'restoreVersion' || operation === 'create') bulkUpdatesFromMain.delete(req)
    if (operation !== 'update') return
    const isBulk = 'where' in args && args.where && !('id' in args && args.id !== undefined)
    const isTrash =
      collection.trash && 'deletedAt' in (args.data ?? {}) && args.data?.deletedAt != null
    if (isBulk && !args.draft && !isTrash) bulkUpdatesFromMain.add(req)
    else bulkUpdatesFromMain.delete(req)
  }

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
    (depth: number, type: 'relationship' | 'upload' = 'relationship'): FilterOptions =>
    async ({ data, siblingData, req }) => {
      const id = referenceID(data?.definition)
      const row = siblingData as Partial<ValueRow> | undefined
      const path = depth === 0 ? row?.fieldKey : row?.fieldPath
      if (id === undefined || typeof path !== 'string') return false
      const schema = await getPickerSchema(req, id)
      if (!schema || (scoped && schema.workspaceID === undefined)) return false
      const field = findField(schema.fields, path)
      if (field?.fieldType !== type) return false
      if (type === 'upload') {
        return uploadWorkspaceField === undefined || schema.workspaceID === undefined
          ? false
          : uploadWorkspaceFilter(uploadWorkspaceField, schema.workspaceID)
      }
      const target = referenceID(field?.targetDefinition)
      if (target === undefined) return false
      return {
        definition: { equals: target },
        ...(scoped && { 'definition.workspace': { equals: schema.workspaceID } }),
      }
    }

  async function normalizeReference(
    field: DefinitionField,
    value: unknown,
    { req, overrideAccess, workspaceID }: Operation,
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
    const isUpload = field.fieldType === 'upload'
    const collection = isUpload ? uploadCollection : entrySlug
    if (!collection || (field.fieldType === 'relationship' && target === undefined)) {
      throw new APIError(`The target for ${field.label} is unavailable.`, 400)
    }
    if (isUpload && uploadWorkspaceField !== undefined && workspaceID === undefined) {
      throw new APIError(`The workspace for ${field.label} is unavailable.`, 400)
    }
    const rejected = () =>
      new APIError(
        `Some selections for ${field.label} are outside its target or inaccessible.`,
        400,
      )
    if (
      isUpload &&
      uploadWorkspaceField !== undefined &&
      !(await lockScopedUploads(req, collection, ids, 'reference'))
    )
      throw rejected()
    const { docs } = await req.payload.find({
      collection,
      depth: 0,
      limit: ids.length,
      overrideAccess,
      req,
      select: { id: true },
      where: {
        id: { in: ids },
        ...(field.fieldType === 'relationship' && {
          definition: { equals: target },
          ...(scoped && { 'definition.workspace': { equals: workspaceID } }),
        }),
        ...(isUpload &&
          uploadWorkspaceField !== undefined &&
          workspaceID !== undefined &&
          uploadWorkspaceFilter(uploadWorkspaceField, workspaceID)),
      },
    })
    if (docs.length !== ids.length) throw rejected()
    return field.hasMany ? ids : ids[0]
  }

  async function normalizeValue(field: DefinitionField, value: unknown, operation: Operation) {
    if (field.fieldType === 'json' || field.fieldType === 'richText') {
      const normalized = normalizePostgresValue(field.fieldType, value, {
        required: Boolean(field.required),
        label: field.label,
      })
      if (
        field.fieldType === 'richText' &&
        uploadCollection &&
        uploadWorkspaceField !== undefined
      ) {
        await assertRichTextUploadScope({
          value: normalized,
          collection: uploadCollection,
          field: uploadWorkspaceField,
          ...operation,
        })
      }
      return normalized
    }
    if (
      value == null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0 && field.hasMany)
    ) {
      if (field.required) throw new APIError(`${field.label} is required.`, 400)
      if (preserveValuePresence) {
        if (Array.isArray(value)) return []
        if (value === '' && ['text', 'textarea', 'code'].includes(field.fieldType)) {
          if (field.minLength) {
            throw new APIError(`${field.label} is outside its configured length.`, 400)
          }
          return value
        }
      }
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
        return normalizeReference(field, value, operation)
    }
    throw new APIError(`Enter a valid ${field.fieldType} for ${field.label}.`, 400)
  }

  async function normalizeRows(
    field: DefinitionField,
    value: unknown,
    previousRows: NestedRow[],
    fieldPath: string,
    operation: Operation,
  ): Promise<NestedRow[]> {
    const { fieldType, label } = field
    const singleton = isSingletonStructure(fieldType)
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
    const previousKeys =
      stableRowKeys && !singleton
        ? new Map(previousRows.map((row) => [row.rowKey ?? row.id, row]))
        : undefined
    const seen = new Set<string>()
    const seenKeys = new Set<string>()
    const normalized = []
    for (const row of singleton && !input.length && !preserveValuePresence ? [{}] : input) {
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
      const matchByID = singleton ? previousRows[0] : previous.get(row.id)
      let rowKey: string | undefined
      let match = matchByID
      if (previousKeys) {
        if (row.rowKey != null && !isRowKey(row.rowKey)) {
          throw new APIError(`${label}: provide a valid row key.`, 400)
        }
        const previousKey = matchByID?.rowKey ?? matchByID?.id
        if (row.rowKey != null && previousKey !== undefined && row.rowKey !== previousKey) {
          throw new APIError(`${label}: existing row keys cannot change.`, 400)
        }
        const suppliedID = isRowKey(row.id) ? row.id : undefined
        const key: string = row.rowKey ?? previousKey ?? suppliedID ?? randomUUID()
        if (seenKeys.has(key)) throw new APIError(`${label}: row keys must be distinct.`, 400)
        seenKeys.add(key)
        rowKey = key
        match = previousKeys.get(key)
      }
      const previousRow = blockKey === (match?.blockKey ?? undefined) ? match : undefined
      normalized.push({
        id: previousRow?.id,
        ...(rowKey !== undefined && { rowKey }),
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
    const byKey = new Map(fields.map((field) => [field.key, field]))
    for (const row of previousRows) {
      const field = byKey.get(row.fieldKey)
      if ((!field || row.fieldType !== field.fieldType) && hasStoredValue(row)) {
        throw new APIError(
          `${row.fieldLabel ?? row.fieldKey} (${row.fieldKey}): Stored values no longer match the collection. Restore the field definition before editing this entry.`,
          409,
        )
      }
    }
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
        row?.fieldType != null &&
        row.fieldType !== field.fieldType &&
        valueColumn({
          fieldType: row.fieldType as FieldType,
          hasMany: Boolean(row.fieldMany),
        }) === column &&
        hasStoredValue(row)
      ) {
        throw new APIError(
          `${field.label} (${field.key}): The field type changed. Reload the entry before saving.`,
          409,
        )
      }
      if (row && hasStoredValue(row, column)) {
        throw new APIError(`Use the ${field.fieldType} value for ${field.label}.`, 400)
      }
      const submitted = preserveValuePresence ? submittedValue(row, field, column) : row?.[column]
      const input =
        !previousRow &&
        submitted === undefined &&
        !(preserveValuePresence && row?.valuePresence === 'absent')
          ? (defaultValue(field) ?? undefined)
          : submitted
      if (preserveValuePresence && input == null) {
        if (field.required) throw new APIError(`${field.label} is required.`, 400)
        if (column === 'rows' && field.minRows) {
          throw new APIError(`${field.label}: provide at least ${field.minRows} rows.`, 400)
        }
      }
      const normalized =
        preserveValuePresence && input == null
          ? null
          : column === 'rows'
            ? await normalizeRows(
                field,
                input,
                Array.isArray(previousRow?.rows) ? previousRow.rows : [],
                fieldPath,
                operation,
              )
            : await normalizeValue(field, input, operation)
      values.push({
        id: previousRow?.id,
        fieldKey: field.key,
        ...(parentPath ? { fieldPath } : {}),
        fieldType: field.fieldType,
        fieldLabel: field.label,
        fieldMany: Boolean(field.hasMany),
        ...(preserveValuePresence && {
          valuePresence: input === undefined ? 'absent' : normalized == null ? 'null' : 'value',
        }),
        [column]: normalized,
      })
    }
    for (const row of rows.values()) {
      const old = previous.get(row.fieldKey)
      // Only a genuinely persisted, empty legacy row may be discarded. Unknown
      // submitted keys (even null ones) and filled stale rows remain errors.
      if (!old?.id || row.id !== old.id || hasStoredValue(old) || hasStoredValue(row)) {
        throw new APIError('A value refers to a field outside this collection.', 400)
      }
    }
    return values
  }

  // Field hooks receive the operation's overrideAccess and run before native field validation.
  const prepareValues: FieldHook = async ({
    collection,
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
    const synchronized =
      req.operation !== 'validate' && (await lockDefinition(req, storage.definitions, id))
    if (synchronized && originalDoc?.id !== undefined) {
      const latest = await req.payload.findByID({
        collection: entrySlug,
        id: originalDoc.id,
        req,
        depth: 0,
        draft: collection !== null && hasDraftsEnabled(collection) && !bulkUpdatesFromMain.has(req),
        overrideAccess: true,
        showHiddenFields: true,
      })
      const latestValues = 'values' in latest && Array.isArray(latest.values) ? latest.values : []
      if (JSON.stringify(latestValues) !== JSON.stringify(originalDoc.values ?? [])) {
        throw new APIError('The entry values changed. Reload the entry before saving.', 409)
      }
    }
    const schema = await readSchema(req, definitionSlug, id, overrideAccess)
    if (!schema || (scoped && schema.workspaceID === undefined)) {
      throw new APIError('Collection definition is unavailable.', 400)
    }
    return normalizeValues(schema.fields, value, originalDoc?.values ?? [], '', {
      req,
      overrideAccess,
      workspaceID: schema.workspaceID,
    })
  }

  return { prepareValues, filterReferences, rememberUpdateSource }
}

// The array's write hook validates relationship scope. The picker uses filterOptions for UI only.
const validateRelationship: typeof validations.relationship = (value, options) =>
  validations.relationship(value, { ...options, filterOptions: undefined })

const validateUpload: typeof validations.upload = (value, options) =>
  validations.upload(value, { ...options, filterOptions: undefined })

export function entryCollection({
  access,
  canManage,
  definitionSlug,
  entrySlug,
  labels,
  postgres,
  preserveValuePresence = false,
  singletons,
  stableRowKeys = false,
  storage,
  uploadCollection,
  uploadWorkspaceField,
  versions,
  workspace,
}: CollectionSlugs & {
  access?: PayloadDynamicAccess
  canManage: Access
  labels?: CollectionConfig['labels']
  postgres: boolean
  preserveValuePresence?: boolean
  singletons: boolean
  stableRowKeys?: boolean
  storage: StorageNames
  uploadCollection?: CollectionSlug
  uploadWorkspaceField?: string
  versions?: CollectionConfig['versions']
  workspace?: PayloadDynamicWorkspace
}): CollectionConfig {
  const { prepareValues, filterReferences, rememberUpdateSource } = entryHooks({
    definitionSlug,
    entrySlug,
    uploadCollection,
    uploadWorkspaceField,
    scoped: Boolean(workspace),
    preserveValuePresence,
    stableRowKeys,
    storage,
  })
  const fieldTypes = availableFieldTypes(postgres).map(({ value }) => value)

  const singletonFields: Field[] = singletons
    ? [
        {
          name: 'singletonKey',
          type: 'text',
          unique: true,
          hidden: true,
          access: { create: () => false, update: () => false },
          hooks: {
            beforeChange: [
              async ({ data, originalDoc, overrideAccess = false, req }) => {
                // Resolve the persisted ID so alternate representations of an ID
                // cannot produce distinct keys for the same collection.
                const id = referenceID(data?.definition ?? originalDoc?.definition)
                if (id === undefined) return null
                const select = { id: true, singleton: true } as const
                const definition = await req.payload.findByID({
                  collection: definitionSlug,
                  id,
                  req,
                  depth: 0,
                  overrideAccess,
                  disableErrors: true,
                  select,
                })
                return definition && 'singleton' in definition && definition.singleton === true
                  ? String(definition.id)
                  : null
              },
            ],
          },
        },
      ]
    : []

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
    if (preserveValuePresence) {
      fields.push({
        name: 'valuePresence',
        type: 'select',
        options: [...valuePresenceOptions],
        admin: { hidden: true },
      })
    }
    if (depth > 0) {
      fields.push({ name: 'fieldPath', type: 'text', admin: { hidden: true } })
    }
    if (postgres)
      fields.push(...postgresValueFields(uploadWorkspaceField ? uploadCollection : undefined))
    if (uploadCollection) {
      const uploadPicker =
        uploadWorkspaceField === undefined
          ? {}
          : {
              filterOptions: filterReferences(depth, 'upload'),
              validate: validateUpload,
            }
      fields.push(
        {
          name: 'uploadValue',
          type: 'upload',
          label: 'File value',
          relationTo: uploadCollection,
          ...uploadPicker,
          admin: { condition: visible('upload', false) },
        },
        {
          name: 'uploadValues',
          type: 'upload',
          label: 'File values',
          relationTo: uploadCollection,
          ...uploadPicker,
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
        dbName: storage.entryRows(level),
        maxRows: 100,
        admin: {
          condition: visibleFor('array', 'group', 'blocks', 'tabs'),
          components: {
            Field: {
              path: entryAdminComponents.nestedRowsField,
              clientProps: { preserveValuePresence, stableRowKeys },
            },
            RowLabel: entryAdminComponents.nestedRowLabel,
          },
        },
        fields: [
          ...(stableRowKeys
            ? [{ name: 'rowKey', type: 'text' as const, maxLength: 255, admin: { hidden: true } }]
            : []),
          {
            name: 'blockKey',
            type: 'text',
            maxLength: 50,
            admin: { components: { Field: entryAdminComponents.blockTypeField } },
          },
          {
            name: 'items',
            type: 'array',
            dbName: storage.entryItems(level),
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
    dbName: storage.entries,
    ...(versions !== undefined && { versions }),
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
    access: dynamicAccess(
      canManage,
      access,
      workspace && {
        path: 'definition.workspace',
        workspace,
        canCreate: async ({ data, req }, ids) => {
          const id =
            data?.definition === undefined ? scopedDefinitionID(req) : referenceID(data.definition)
          if (id === undefined) return false
          const { totalDocs } = await req.payload.count({
            collection: definitionSlug,
            overrideAccess: true,
            req,
            where: { id: { equals: id }, workspace: { in: [...ids] } },
          })
          return totalDocs === 1
        },
      },
    ),
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
        access: { update: ({ id, req }) => req.operation === 'validate' && id === undefined },
        admin: { hidden: true },
      },
      ...singletonFields,
      {
        name: 'values',
        type: 'array',
        maxRows: 100,
        admin: {
          components: {
            Field: {
              path: entryAdminComponents.arrayField,
              clientProps: { definitionSlug, entrySlug, preserveValuePresence },
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
      beforeOperation: [
        rememberUpdateSource,
        ...(workspace ? [inheritDuplicateScope('definition')] : []),
      ],
      beforeChange: [
        ({ data, operation, originalDoc }) => {
          // Payload strips update-protected fields from version restores before
          // required-field validation. Reuse the current entry's definition.
          if (operation === 'update' && data.definition === undefined && originalDoc) {
            return { ...data, definition: originalDoc.definition }
          }
          return data
        },
      ],
      beforeDelete: [
        async ({ id, req }) => {
          const referenced = await hasEntryMatching(req, entrySlug, {
            id: { not_equals: id },
            or: entryValueReferences(id, 'relationshipValue', 'relationshipValues'),
          })
          if (referenced) throw new APIError('Another entry still links to this entry.', 409)
        },
      ],
    },
  }
}
