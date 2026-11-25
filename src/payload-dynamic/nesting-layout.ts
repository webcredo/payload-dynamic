export const defaultNestingDepth = 2

type Aliases = {
  fields: string
  targetDefinition: string
  rows: string
  items: string
  relationshipValue: string
  uploadValue: string
}

const legacy: Aliases = {
  fields: 'fields',
  targetDefinition: 'targetDefinition',
  rows: 'rows',
  items: 'items',
  relationshipValue: 'relationshipValue',
  uploadValue: 'uploadValue',
}

const compact: Aliases = {
  fields: 'f',
  targetDefinition: 't',
  rows: 'r',
  items: 'i',
  relationshipValue: 'l',
  uploadValue: 'u',
}

export function nestingAliases(maxNestingDepth: number) {
  return maxNestingDepth > defaultNestingDepth ? compact : legacy
}

export function storageValueColumn(column: string, names: Aliases) {
  switch (column) {
    case 'rows':
    case 'relationshipValue':
    case 'uploadValue':
      return names[column]
    default:
      return column
  }
}

type Rename = { from: string; to: string; nested?: readonly Rename[] }

function mapRows(value: unknown, renames: readonly Rename[]): unknown {
  if (!Array.isArray(value)) return value
  return value.map((row: unknown) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
    const result: Record<string, unknown> = { ...row }
    for (const { from, to, nested } of renames) {
      if (!Object.hasOwn(result, from)) continue
      const field = result[from]
      delete result[from]
      result[to] = nested ? mapRows(field, nested) : field
    }
    return result
  })
}

function mapDefinitionFields(fields: unknown, from: Aliases, to: Aliases) {
  if (from === to) return fields
  const nested: Rename[] = [{ from: from.targetDefinition, to: to.targetDefinition }]
  nested.push({ from: from.fields, to: to.fields, nested })
  return mapRows(fields, nested)
}

function mapEntryValues(values: unknown, from: Aliases, to: Aliases) {
  if (from === to) return values
  const nested: Rename[] = [
    { from: from.relationshipValue, to: to.relationshipValue },
    { from: from.uploadValue, to: to.uploadValue },
  ]
  nested.push({
    from: from.rows,
    to: to.rows,
    nested: [{ from: from.items, to: to.items, nested }],
  })
  return mapRows(values, nested)
}

export function encodePayloadDynamicDefinitionFields(fields: unknown, maxNestingDepth: number) {
  return mapDefinitionFields(fields, legacy, nestingAliases(maxNestingDepth))
}

export function decodePayloadDynamicDefinitionFields(fields: unknown, maxNestingDepth: number) {
  return mapDefinitionFields(fields, nestingAliases(maxNestingDepth), legacy)
}

export function encodePayloadDynamicEntryValues(values: unknown, maxNestingDepth: number) {
  return mapEntryValues(values, legacy, nestingAliases(maxNestingDepth))
}

export function decodePayloadDynamicEntryValues(values: unknown, maxNestingDepth: number) {
  return mapEntryValues(values, nestingAliases(maxNestingDepth), legacy)
}
