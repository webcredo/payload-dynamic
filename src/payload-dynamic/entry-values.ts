import type { DefinitionField, FieldType } from './definitions'

export type ID = number | string

export const invalidJSONDraftKey = 'jsonEditorInvalid'

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
  return allValueColumns.some((column) => {
    const value = row[column]
    if (column === exceptColumn || value == null) return false
    if (column === 'jsonValue' || column === 'richTextValue') return true
    return value !== '' && (!Array.isArray(value) || value.length > 0)
  })
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
