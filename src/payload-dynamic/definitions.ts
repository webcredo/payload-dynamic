import { randomUUID } from 'node:crypto'
import {
  type Access,
  APIError,
  type CollectionConfig,
  type CollectionSlug,
  type Condition,
  type Field,
  type PayloadRequest,
  validations,
} from 'payload'
import { slugify, toWords } from 'payload/shared'
import {
  dynamicAccess,
  inheritDuplicateScope,
  type PayloadDynamicAccess,
  type PayloadDynamicWorkspace,
  withinWorkspace,
} from './access'
import type { CollectionSlugs } from './entry-list'
import { hasStoredValue, normalizeDate, referenceID } from './entry-values'
import { lockDefinition } from './schema-transaction'
import type { StorageNames } from './storage'

const fieldTypeOptions = [
  { label: 'Text', value: 'text' },
  { label: 'Textarea', value: 'textarea' },
  { label: 'Code', value: 'code' },
  { label: 'Slug', value: 'slug' },
  { label: 'Email', value: 'email' },
  { label: 'Number', value: 'number' },
  { label: 'Checkbox', value: 'checkbox' },
  { label: 'Date', value: 'date' },
  { label: 'Select', value: 'select' },
  { label: 'Radio', value: 'radio' },
  { label: 'Relationship', value: 'relationship' },
  { label: 'Upload', value: 'upload' },
  { label: 'Array', value: 'array' },
  { label: 'Group', value: 'group' },
  { label: 'Blocks', value: 'blocks' },
  { label: 'Tabs', value: 'tabs' },
  { label: 'JSON', value: 'json' },
  { label: 'Rich Text', value: 'richText' },
] as const

export type FieldType = (typeof fieldTypeOptions)[number]['value']
export const definitionDepth = 2

export function availableFieldTypes(postgres: boolean) {
  return fieldTypeOptions.filter(
    ({ value }) => postgres || (value !== 'json' && value !== 'richText'),
  )
}

type ID = number | string

export type DefinitionField = {
  key: string
  label: string
  fieldType: FieldType
  required?: boolean | null
  description?: string | null
  minLength?: number | null
  maxLength?: number | null
  defaultText?: string | null
  min?: number | null
  max?: number | null
  defaultNumber?: number | null
  defaultChecked?: boolean | null
  defaultDate?: string | null
  options?: { label: string; value: string }[] | null
  defaultOption?: string | null
  targetDefinition?: ID | { id: ID } | null
  hasMany?: boolean | null
  minRows?: number | null
  maxRows?: number | null
  fields?: DefinitionField[] | null
}

const keyPattern = /^[a-z][a-z0-9_-]{0,49}$/
const textTypes: FieldType[] = ['text', 'textarea', 'email', 'code', 'slug']
const structureTypes: FieldType[] = ['array', 'group', 'blocks', 'tabs']
const maxDefinitionRows = 100

function hasSections(type: FieldType) {
  return type === 'blocks' || type === 'tabs'
}

function fitsDepth(type: FieldType, depth: number) {
  return !structureTypes.includes(type) || depth + (hasSections(type) ? 2 : 1) <= definitionDepth
}

const onlyFor =
  (...types: FieldType[]): Condition =>
  (_, row) =>
    types.includes(row.fieldType)

function idOf(value: unknown): ID | undefined {
  if (value && typeof value === 'object' && 'id' in value) value = value.id
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && value.length > 0) return value
}

function isStorageText(value: unknown): value is string {
  return typeof value === 'string' && !/[\0\p{Surrogate}]/u.test(value)
}

function isNonEmptyText(value: unknown): value is string {
  return isStorageText(value) && value.trim().length > 0
}

function invalidCount(count: unknown, max = Infinity) {
  return (
    count != null &&
    (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > max)
  )
}

async function assertSettings(field: DefinitionField, req: PayloadRequest) {
  function invalid(message: string): never {
    throw new APIError(`${field.label}: ${message}`, 400)
  }

  switch (field.fieldType) {
    case 'text':
    case 'textarea':
    case 'code':
    case 'slug':
    case 'email': {
      const { defaultText, minLength, maxLength } = field
      if (invalidCount(minLength) || invalidCount(maxLength)) {
        invalid('Lengths must be nonnegative whole numbers.')
      }
      if (minLength != null && maxLength != null && minLength > maxLength) {
        invalid('Minimum length must not exceed maximum length.')
      }
      if (defaultText == null || defaultText === '') break
      if (!isStorageText(defaultText)) invalid('Default text is invalid.')
      const normalized = field.fieldType === 'slug' ? slugify(defaultText) : defaultText
      if (!normalized) invalid('Enter a valid default slug.')
      if (normalized.length < (minLength ?? 0) || normalized.length > (maxLength ?? Infinity)) {
        invalid('Default text must fit the specified lengths.')
      }
      if (
        field.fieldType === 'email' &&
        (await validations.email(defaultText, {
          type: 'email',
          name: 'defaultText',
          req,
          blockData: {},
          data: {},
          path: ['defaultText'],
          preferences: { fields: {} },
          siblingData: {},
        })) !== true
      ) {
        invalid('Enter a valid default email address.')
      }
      break
    }
    case 'number': {
      const { defaultNumber, min, max } = field
      if ([defaultNumber, min, max].some((value) => value != null && !Number.isFinite(value))) {
        invalid('Minimum, maximum, and default must be finite numbers.')
      }
      if (min != null && max != null && min > max) invalid('Minimum must not exceed maximum.')
      if (
        defaultNumber != null &&
        (defaultNumber < (min ?? -Infinity) || defaultNumber > (max ?? Infinity))
      ) {
        invalid('The default must be within the specified range.')
      }
      break
    }
    case 'checkbox':
      if (field.defaultChecked != null && typeof field.defaultChecked !== 'boolean') {
        invalid('Default checked must be true or false.')
      }
      break
    case 'date':
      if (
        field.defaultDate != null &&
        field.defaultDate !== '' &&
        !normalizeDate(field.defaultDate)
      ) {
        invalid('Enter a valid default date.')
      }
      break
    case 'select':
    case 'radio': {
      const { options, defaultOption } = field
      if (!Array.isArray(options) || options.length === 0) invalid('Add at least one option.')
      const values = new Set<string>()
      for (const option of options) {
        if (!option || !isNonEmptyText(option.label) || !isNonEmptyText(option.value)) {
          invalid('Each option needs a label and a value.')
        }
        if (values.has(option.value)) invalid('Option values must be unique.')
        values.add(option.value)
      }
      if (defaultOption != null && defaultOption !== '' && !values.has(defaultOption)) {
        invalid('The default must match an option value.')
      }
      break
    }
    case 'relationship':
      if (idOf(field.targetDefinition) === undefined) invalid('Select a target collection.')
      break
    case 'array':
    case 'blocks': {
      const { minRows, maxRows } = field
      if (invalidCount(minRows, maxDefinitionRows)) {
        invalid(`Minimum rows must be a whole number between 0 and ${maxDefinitionRows}.`)
      }
      if (maxRows === 0 || invalidCount(maxRows, maxDefinitionRows)) {
        invalid(`Maximum rows must be a whole number between 1 and ${maxDefinitionRows}.`)
      }
      if (maxRows != null && Math.max(minRows ?? 0, field.required ? 1 : 0) > maxRows) {
        invalid('Maximum rows must permit the minimum number of rows.')
      }
      break
    }
  }
  if (
    (field.fieldType === 'relationship' || field.fieldType === 'upload') &&
    field.hasMany != null &&
    typeof field.hasMany !== 'boolean'
  ) {
    invalid('Allow multiple values must be true or false.')
  }
}

function preservesField(previous: DefinitionField, current: DefinitionField | undefined) {
  if (!current || current.fieldType !== previous.fieldType) return false
  if (structureTypes.includes(previous.fieldType)) {
    return preservesFields(previous.fields ?? [], current.fields ?? [])
  }
  if (previous.fieldType === 'relationship') {
    return (
      Boolean(previous.hasMany) === Boolean(current.hasMany) &&
      String(idOf(previous.targetDefinition)) === String(idOf(current.targetDefinition))
    )
  }
  return previous.fieldType !== 'upload' || Boolean(previous.hasMany) === Boolean(current.hasMany)
}

function preservesFields(previous: DefinitionField[], current: DefinitionField[]): boolean {
  const byKey = new Map(current.map((field) => [field.key, field]))
  return previous.every((field) => preservesField(field, byKey.get(field.key)))
}

function normalizeSettings(field: DefinitionField): DefinitionField {
  const type = field.fieldType
  const text = textTypes.includes(type)
  const choice = type === 'select' || type === 'radio'
  const repeated = type === 'array' || type === 'blocks'
  return {
    ...field,
    minLength: text ? (field.minLength ?? null) : null,
    maxLength: text ? (field.maxLength ?? null) : null,
    defaultText:
      text && field.defaultText
        ? type === 'slug'
          ? slugify(field.defaultText)
          : field.defaultText
        : null,
    min: type === 'number' ? (field.min ?? null) : null,
    max: type === 'number' ? (field.max ?? null) : null,
    defaultNumber: type === 'number' ? (field.defaultNumber ?? null) : null,
    defaultChecked: type === 'checkbox' ? (field.defaultChecked ?? null) : null,
    defaultDate: type === 'date' ? normalizeDate(field.defaultDate) : null,
    options: choice ? (field.options ?? []) : [],
    defaultOption: choice ? field.defaultOption || null : null,
    targetDefinition: type === 'relationship' ? (idOf(field.targetDefinition) ?? null) : null,
    hasMany: type === 'relationship' || type === 'upload' ? Boolean(field.hasMany) : false,
    minRows: repeated ? (field.minRows ?? null) : null,
    maxRows: repeated ? (field.maxRows ?? null) : null,
  }
}

async function normalizeFields(
  fields: unknown,
  req: PayloadRequest,
  types: Set<FieldType>,
  depth = 0,
  sectionsOnly = false,
): Promise<DefinitionField[]> {
  if (!Array.isArray(fields)) throw new APIError('Fields must be an array.', 400)
  if (fields.length > maxDefinitionRows) {
    throw new APIError(`Add at most ${maxDefinitionRows} fields per section.`, 400)
  }
  const current = new Set<string>()
  const normalized = []
  for (const input of fields as DefinitionField[]) {
    if (
      !input ||
      typeof input.key !== 'string' ||
      !keyPattern.test(input.key) ||
      current.has(input.key)
    ) {
      throw new APIError('Provide a unique lowercase key for every field in a section.', 400)
    }
    if (!types.has(input.fieldType) || !fitsDepth(input.fieldType, depth)) {
      throw new APIError(`Choose a supported field type for ${input.key} at this level.`, 400)
    }
    if (sectionsOnly && input.fieldType !== 'group') {
      throw new APIError('Use a Group for each tab or block.', 400)
    }
    if (input.label != null && !isStorageText(input.label)) {
      throw new APIError(`${input.key}: Label is invalid.`, 400)
    }
    const field = {
      ...input,
      label: input.label?.trim() ? input.label : toWords(input.key.replaceAll('_', '-')),
    }
    if (field.required != null && typeof field.required !== 'boolean') {
      throw new APIError(`${field.label}: Required must be true or false.`, 400)
    }
    if (field.description != null && !isStorageText(field.description)) {
      throw new APIError(`${field.label}: Description is invalid.`, 400)
    }
    await assertSettings(field, req)
    if (structureTypes.includes(field.fieldType)) {
      if (!Array.isArray(field.fields) || field.fields.length === 0) {
        throw new APIError(`${field.label}: Add at least one nested field.`, 400)
      }
      field.fields = await normalizeFields(
        field.fields,
        req,
        types,
        depth + 1,
        hasSections(field.fieldType),
      )
    } else {
      field.fields = depth < definitionDepth ? [] : undefined
    }
    current.add(field.key)
    normalized.push(normalizeSettings(field))
  }
  return normalized
}

function collectTargets(fields: DefinitionField[], targetIDs: Map<string, ID>) {
  for (const field of fields) {
    if (field.fieldType === 'relationship') {
      const id = idOf(field.targetDefinition)
      if (id !== undefined) targetIDs.set(String(id), id)
    }
    if (field.fields?.length) collectTargets(field.fields, targetIDs)
  }
}

async function hasEntries(req: PayloadRequest, entrySlug: CollectionSlug, id: ID) {
  const { totalDocs } = await req.payload.count({
    collection: entrySlug,
    overrideAccess: true,
    req,
    where: { definition: { equals: id } },
  })
  return totalDocs > 0
}

function fieldConflict(field: DefinitionField, reason: string): never {
  throw new APIError(`${field.label} (${field.key}): ${reason}`, 409)
}

async function assertSafeFieldChanges(
  req: PayloadRequest,
  entrySlug: CollectionSlug,
  id: ID,
  previous: DefinitionField[],
  current: DefinitionField[],
  synchronized: boolean,
) {
  if (!(await hasEntries(req, entrySlug, id))) return
  const byKey = new Map(current.map((field) => [field.key, field]))
  const changed = previous.filter((field) => !preservesField(field, byKey.get(field.key)))
  for (const field of changed) {
    const next = byKey.get(field.key)
    if (
      field.required ||
      structureTypes.includes(field.fieldType) ||
      (next &&
        (next.required ||
          structureTypes.includes(next.fieldType) ||
          next.fieldType === field.fieldType))
    ) {
      throw new APIError(
        'Field keys, types and relationship settings cannot change while the collection has entries.',
        409,
      )
    }
  }
  if (!changed.length) return
  if (!synchronized) {
    throw new APIError(
      'Field keys, types and relationship settings cannot change while the collection has entries.',
      409,
    )
  }

  // Read complete value rows: independent array predicates cannot prove that a
  // key and every populated column belong to the same row on both adapters.
  // Keyset pagination bounds each read and uses the caller's transaction, while
  // overrideAccess prevents a manager's read filter from hiding populated entries.
  let after: ID | undefined
  while (true) {
    const { docs } = await req.payload.find({
      collection: entrySlug,
      req,
      overrideAccess: true,
      depth: 0,
      select: { values: true },
      limit: 100,
      pagination: false,
      sort: 'id',
      where: {
        definition: { equals: id },
        ...(after === undefined ? {} : { id: { greater_than: after } }),
      },
    })
    for (const doc of docs) {
      const rows = ('values' in doc && Array.isArray(doc.values) ? doc.values : []) as ({
        fieldKey: string
      } & Record<string, unknown>)[]
      for (const field of changed) {
        if (rows.some((row) => row.fieldKey === field.key && hasStoredValue(row))) {
          fieldConflict(
            field,
            'Clear its values in every entry before removing or changing its type.',
          )
        }
      }
    }
    if (docs.length < 100) return
    after = docs[docs.length - 1].id
  }
}

function fieldDefinitions(
  options: (typeof fieldTypeOptions)[number][],
  definitionSlug: CollectionSlug,
  scoped: boolean,
  storage: StorageNames,
  depth = 0,
): Field[] {
  const fields: Field[] = [
    { name: 'key', type: 'text', required: true, maxLength: 50 },
    {
      name: 'label',
      type: 'text',
      admin: { placeholder: 'Generated from the key' },
    },
    {
      name: 'fieldType',
      type: 'select',
      label: 'Type',
      options: options.filter(({ value }) => fitsDepth(value, depth)),
      required: true,
      ...(depth > 0
        ? {
            admin: {
              components: { Field: 'payload-dynamic/react#DefinitionFieldType' },
            },
          }
        : {}),
    },
    { name: 'required', type: 'checkbox' },
    { name: 'description', type: 'textarea' },
    {
      name: 'minLength',
      type: 'number',
      label: 'Minimum length',
      min: 0,
      admin: { condition: onlyFor(...textTypes), step: 1 },
    },
    {
      name: 'maxLength',
      type: 'number',
      label: 'Maximum length',
      min: 0,
      admin: { condition: onlyFor(...textTypes), step: 1 },
    },
    { name: 'defaultText', type: 'textarea', admin: { condition: onlyFor(...textTypes) } },
    {
      name: 'min',
      type: 'number',
      label: 'Minimum',
      admin: { condition: onlyFor('number') },
    },
    {
      name: 'max',
      type: 'number',
      label: 'Maximum',
      admin: { condition: onlyFor('number') },
    },
    { name: 'defaultNumber', type: 'number', admin: { condition: onlyFor('number') } },
    { name: 'defaultChecked', type: 'checkbox', admin: { condition: onlyFor('checkbox') } },
    {
      name: 'defaultDate',
      type: 'date',
      admin: { condition: onlyFor('date'), date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'options',
      type: 'array',
      maxRows: maxDefinitionRows,
      admin: { condition: onlyFor('select', 'radio') },
      fields: [
        { name: 'label', type: 'text', required: true },
        { name: 'value', type: 'text', required: true, maxLength: 100 },
      ],
    },
    {
      name: 'defaultOption',
      type: 'text',
      maxLength: 100,
      admin: {
        condition: onlyFor('select', 'radio'),
        description: 'Enter one of the option values.',
      },
    },
    {
      name: 'targetDefinition',
      type: 'relationship',
      label: 'Target collection',
      relationTo: definitionSlug,
      filterOptions: scoped
        ? ({ data }) => {
            const id = referenceID(data?.workspace)
            return id === undefined ? true : { workspace: { equals: id } }
          }
        : undefined,
      admin: { condition: onlyFor('relationship') },
    },
    {
      name: 'minRows',
      type: 'number',
      label: 'Minimum rows',
      min: 0,
      max: maxDefinitionRows,
      admin: { condition: onlyFor('array', 'blocks'), step: 1 },
    },
    {
      name: 'maxRows',
      type: 'number',
      label: 'Maximum rows',
      min: 1,
      max: maxDefinitionRows,
      admin: { condition: onlyFor('array', 'blocks'), step: 1 },
    },
    {
      name: 'hasMany',
      type: 'checkbox',
      label: 'Allow multiple values',
      admin: { condition: onlyFor('relationship', 'upload') },
    },
  ]
  if (depth < definitionDepth) {
    fields.push({
      name: 'fields',
      type: 'array',
      dbName: storage.nestedDefinitions(depth + 1),
      labels: { singular: 'Nested field', plural: 'Nested fields' },
      maxRows: maxDefinitionRows,
      admin: { condition: onlyFor(...structureTypes) },
      fields: fieldDefinitions(options, definitionSlug, scoped, storage, depth + 1),
    })
  }
  return fields
}

const validateWorkspace: typeof validations.relationship = (value, options) =>
  validations.relationship(
    value,
    options.overrideAccess ? { ...options, filterOptions: () => true } : options,
  )

export function definitionCollection({
  access,
  canManage,
  definitionSlug,
  entrySlug,
  labels,
  postgres,
  storage,
  uploadCollection,
  workspace,
}: CollectionSlugs & {
  access?: PayloadDynamicAccess
  canManage: Access
  labels?: CollectionConfig['labels']
  postgres: boolean
  storage: StorageNames
  uploadCollection?: string
  workspace?: PayloadDynamicWorkspace
}): CollectionConfig {
  const options = availableFieldTypes(postgres).filter(
    ({ value }) => value !== 'upload' || uploadCollection,
  )
  const types = new Set(options.map(({ value }) => value))

  const workspaceFields: Field[] = workspace
    ? [
        {
          name: 'workspace',
          type: 'relationship' as const,
          relationTo: workspace.collection,
          required: true,
          filterOptions: async ({ req }: { req: PayloadRequest }) => {
            const ids = await workspace.allowedIDs(req)
            return ids.length ? { id: { in: [...ids] } } : false
          },
          validate: validateWorkspace,
          admin: { allowCreate: false, description: 'Fixed after the collection is created.' },
        },
      ]
    : []

  return {
    slug: definitionSlug,
    // Keep the SQL table when the public slug changes.
    dbName: storage.definitions,
    labels: { singular: labels?.singular ?? 'Collection', plural: labels?.plural ?? 'Collections' },
    admin: {
      useAsTitle: 'title',
      components: {
        edit: {
          beforeDocumentControls: [
            {
              path: 'payload-dynamic/react#DefinitionEntriesLink',
              clientProps: { entrySlug },
            },
          ],
        },
      },
    },
    access: dynamicAccess(
      canManage,
      access,
      workspace && {
        path: 'workspace',
        workspace,
        canCreate: ({ data }, ids) => withinWorkspace(data?.workspace, ids),
      },
    ),
    ...(workspace && { indexes: [{ fields: ['workspace', 'slug'], unique: true }] }),
    fields: [
      { name: 'title', type: 'text', required: true },
      {
        name: 'slug',
        type: 'text',
        required: true,
        unique: !workspace,
        maxLength: 50,
        ...(workspace && {
          hooks: {
            beforeDuplicate: [
              ({ value }) =>
                `${String(value).slice(0, 32)}-copy-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
            ],
          },
        }),
        admin: {
          description:
            'Use lowercase letters, numbers, hyphens or underscores. Fixed after creation.',
        },
      },
      ...workspaceFields,
      {
        name: 'fields',
        type: 'array',
        required: true,
        maxRows: maxDefinitionRows,
        fields: fieldDefinitions(options, definitionSlug, Boolean(workspace), storage),
      },
    ],
    hooks: {
      ...(workspace && { beforeOperation: [inheritDuplicateScope('workspace')] }),
      beforeValidate: [
        async ({ data, operation, originalDoc, req }) => {
          if (!data) return data
          if (data.title !== undefined && !isNonEmptyText(data.title)) {
            throw new APIError('Enter a title for the collection.', 400)
          }
          if (data.slug !== undefined) {
            if (typeof data.slug !== 'string' || !keyPattern.test(data.slug)) {
              throw new APIError(
                'Use a lowercase slug with letters, numbers, hyphens or underscores.',
                400,
              )
            }
            if (operation === 'update' && originalDoc && data.slug !== originalDoc.slug) {
              throw new APIError('The slug is fixed after the collection is created.', 409)
            }
          }
          if (workspace && data.workspace !== undefined && operation === 'update' && originalDoc) {
            const previous = referenceID(originalDoc.workspace)
            if (String(referenceID(data.workspace)) !== String(previous)) {
              throw new APIError('The workspace is fixed after the collection is created.', 409)
            }
          }
          if (data.fields === undefined) return data
          const fields = await normalizeFields(data.fields, req, types)

          if (operation === 'update' && originalDoc) {
            const synchronized = await lockDefinition(req, storage.definitions, originalDoc.id)
            if (synchronized) {
              const latest = await req.payload.findByID({
                collection: definitionSlug,
                id: originalDoc.id,
                req,
                depth: 0,
                overrideAccess: true,
                showHiddenFields: true,
              })
              const latestFields =
                'fields' in latest && Array.isArray(latest.fields) ? latest.fields : []
              if (JSON.stringify(latestFields) !== JSON.stringify(originalDoc.fields ?? [])) {
                throw new APIError(
                  'The collection definition changed. Reload it before saving.',
                  409,
                )
              }
            }
            if (!preservesFields((originalDoc.fields ?? []) as DefinitionField[], fields)) {
              await assertSafeFieldChanges(
                req,
                entrySlug,
                originalDoc.id,
                (originalDoc.fields ?? []) as DefinitionField[],
                fields,
                synchronized,
              )
            }
          }
          return { ...data, fields }
        },
      ],
      beforeChange: [
        async ({ data, originalDoc, req }) => {
          const targetIDs = new Map<string, ID>()
          collectTargets((data.fields ?? []) as DefinitionField[], targetIDs)
          if (targetIDs.size > 0) {
            const workspaceID = referenceID(data.workspace ?? originalDoc?.workspace)
            if (workspace && workspaceID === undefined) {
              throw new APIError('Choose a workspace for the collection.', 400)
            }
            const { totalDocs } = await req.payload.count({
              collection: definitionSlug,
              overrideAccess: true,
              req,
              where: {
                id: { in: [...targetIDs.values()] },
                ...(workspace && { workspace: { equals: workspaceID } }),
              },
            })
            if (totalDocs !== targetIDs.size) {
              throw new APIError(
                workspace
                  ? 'A target collection does not exist in this workspace.'
                  : 'A target collection does not exist.',
                400,
              )
            }
          }
          return data
        },
      ],
      beforeDelete: [
        async ({ id, req }) => {
          if (await hasEntries(req, entrySlug, id)) {
            throw new APIError('Delete the entries before deleting their collection.', 409)
          }
          const { totalDocs } = await req.payload.count({
            collection: definitionSlug,
            overrideAccess: true,
            req,
            where: {
              id: { not_equals: id },
              or: Array.from({ length: definitionDepth + 1 }, (_, depth) => ({
                [`${'fields.'.repeat(depth + 1)}targetDefinition`]: { equals: id },
              })),
            },
          })
          if (totalDocs)
            throw new APIError('Another collection still links to this collection.', 409)
        },
      ],
    },
  }
}
