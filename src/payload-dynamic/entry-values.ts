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

export const allValueColumns = [
  ...new Set(Object.values(valueColumns)),
  'relationshipValues',
  'uploadValues',
]

export function valueColumn({ fieldType, hasMany }: DefinitionField) {
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
