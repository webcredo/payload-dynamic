import type { DefinitionField, FieldType } from './definitions'

export type ID = number | string

export const invalidJSONDraftKey = 'jsonEditorInvalid'
export const valuePresenceOptions = ['absent', 'null', 'value'] as const

export function referenceID(value: unknown): ID | undefined {
  if (value && typeof value === 'object' && 'id' in value) value = value.id
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && value.trim()) return value
}

export function normalizeDate(value: unknown) {
  if (value instanceof Date) return Number.isFinite(value.valueOf()) ? value.toISOString() : null
  if (typeof value !== 'string') return null
  const day = value.match(/^\d{4}-\d{2}-\d{2}(?=T|$)/)?.[0]
  if (!day || !Number.isFinite(Date.parse(value))) return null
  const dateAtMidnight = new Date(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(dateAtMidnight.valueOf()) || !dateAtMidnight.toISOString().startsWith(day)) {
    return null
  }
  return new Date(value).toISOString()
}

const valueColumns = {
  text: 'textValue',
  textarea: 'textareaValue',
  code: 'textareaValue',
  slug: 'textValue',
  email: 'emailValue',
  number: 'numberValue',
  checkbox: 'checkboxValue',
  date: 'dateValue',
  select: 'selectValue',
  radio: 'selectValue',
  relationship: 'relationshipValue',
  upload: 'uploadValue',
  array: 'rows',
  group: 'rows',
  blocks: 'rows',
  tabs: 'rows',
  json: 'jsonValue',
  richText: 'richTextValue',
} satisfies Record<FieldType, string>

const allValueColumns = [
  ...new Set(Object.values(valueColumns)),
  'relationshipValues',
  'uploadValues',
]

// Match normalization's empty scalar/reference values, without treating false,
// zero, JSON strings/collections, or nested rows as absent.
export function hasStoredValue(row: Record<string, unknown>, exceptColumn?: string) {
  if (row[invalidJSONDraftKey] === true) return true
  const presentColumn =
    row.valuePresence === 'value' &&
    typeof row.fieldType === 'string' &&
    Object.hasOwn(valueColumns, row.fieldType)
      ? valueColumn({ fieldType: row.fieldType as FieldType, hasMany: Boolean(row.fieldMany) })
      : undefined
  return allValueColumns.some((column) => {
    const value = row[column]
    if (column === exceptColumn) return false
    if (column === presentColumn) return true
    if (value == null) return false
    if (column === 'jsonValue' || column === 'richTextValue') return true
    return value !== '' && (!Array.isArray(value) || value.length > 0)
  })
}

export function isSingletonStructure(fieldType: FieldType) {
  return fieldType === 'group' || fieldType === 'tabs'
}

export function reconcileSiblingRowKeys(
  rows: { id?: string; key?: string | null }[],
  previousOwners: ReadonlyMap<string, string>,
) {
  const originals = new Map<string, { index: number; id: string }>()
  const updates = new Map<number, string | null>()
  const previousKeys = new Map([...previousOwners].map(([key, id]) => [id, key]))
  for (const [index, { id, key: incoming }] of rows.entries()) {
    if (!id) continue
    const key = previousKeys.get(id) || incoming || id
    if (incoming && key !== incoming) updates.set(index, key)
    const existing = originals.get(key)
    if (existing === undefined) {
      originals.set(key, { index, id })
    } else if (previousOwners.get(key) === id) {
      originals.set(key, { index, id })
      updates.set(existing.index, null)
    } else {
      updates.set(index, null)
    }
  }
  return {
    updates,
    owners: new Map([...originals].map(([key, { id }]) => [key, id])),
  }
}

export function submittedValue(
  row: Record<string, unknown> | undefined,
  field: DefinitionField,
  column: string,
) {
  const value = row?.[column]
  const presence = row?.valuePresence
  const storesRows =
    column === 'rows' || column === 'relationshipValues' || column === 'uploadValues'
  // Drizzle can return cleared arrays as [], even when the original write was null
  // or omitted. JSON arrays are stored as values, including when empty.
  if (value == null || (storesRows && Array.isArray(value) && value.length === 0)) {
    if (presence === 'absent') return undefined
    if (presence === 'null' || (column === 'rows' && isSingletonStructure(field.fieldType))) {
      return value === undefined && presence !== 'null' ? undefined : null
    }
  }
  return value
}

export function valueColumn({
  fieldType,
  hasMany,
}: Pick<DefinitionField, 'fieldType' | 'hasMany'>) {
  if (hasMany && fieldType === 'relationship') return 'relationshipValues'
  if (hasMany && fieldType === 'upload') return 'uploadValues'
  return valueColumns[fieldType]
}

export function defaultValue(field: DefinitionField) {
  switch (field.fieldType) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'code':
    case 'slug':
      return field.defaultText
    case 'number':
      return field.defaultNumber
    case 'checkbox':
      return field.defaultChecked
    case 'date':
      return field.defaultDate
    case 'select':
    case 'radio':
      return field.defaultOption
  }
}
