'use client'

import {
  ArrayField,
  Button,
  CodeField,
  RadioGroupField,
  RenderFields,
  SelectInput,
  Tabs,
  TextareaField,
  TextField,
  useConfig,
  useEditDepth,
  useField,
  useFieldPath,
  useForm,
  useFormFields,
  useRowLabel,
} from '@payloadcms/ui'
import type { ArrayFieldClientProps, TextareaFieldClientProps, TextFieldClientProps } from 'payload'
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CollectionBreadcrumb } from './CollectionBreadcrumb'
import type { DefinitionField } from './definitions'
import { defaultValue, hasStoredValue, referenceID, valueColumn } from './entry-values'

type Definition = { fields: DefinitionField[]; title: string }
type LoadResult = ({ id: string } & Definition) | { id: string; error: true }

const DefinitionFields = createContext<ReadonlyMap<string, DefinitionField> | undefined>(undefined)
const NestedDefinition = createContext<{ field: DefinitionField; fieldPath: string } | undefined>(
  undefined,
)

function useValueDefinition(fallbackPath: string) {
  const path = useFieldPath() ?? fallbackPath
  const definitions = useContext(DefinitionFields)
  const rowPath = path.slice(0, path.lastIndexOf('.'))
  const key = useFormFields(([state]) => state[`${rowPath}.fieldKey`]?.value)
  const fieldPath = useFormFields(([state]) => state[`${rowPath}.fieldPath`]?.value)
  return {
    definition: definitions?.get(String(key)),
    fieldPath: typeof fieldPath === 'string' && fieldPath ? fieldPath : String(key),
    path,
  }
}

function addMissingValues({
  addFieldRow,
  fields,
  existing,
  path,
  prefix,
  schemaPath,
}: {
  addFieldRow: ReturnType<typeof useForm>['addFieldRow']
  fields: DefinitionField[]
  existing: { fieldKey: string }[]
  path: string
  prefix?: string
  schemaPath: string
}) {
  const keys = new Set(existing.map(({ fieldKey }) => fieldKey))
  const missing = fields.filter(({ key }) => !keys.has(key))
  for (const [index, field] of missing.entries()) {
    const initial = defaultValue(field)
    addFieldRow({
      path,
      schemaPath,
      rowIndex: existing.length + index,
      subFieldState: {
        fieldKey: { value: field.key, valid: true },
        fieldLabel: { value: field.label, valid: true },
        fieldType: { value: field.fieldType, valid: true },
        fieldMany: { value: Boolean(field.hasMany), valid: true },
        ...(prefix ? { fieldPath: { value: `${prefix}.${field.key}`, valid: true } } : {}),
        ...(initial == null ? {} : { [valueColumn(field)]: { value: initial, valid: true } }),
      },
    })
  }
}

export function ValueRowLabel() {
  const { data } = useRowLabel<{ fieldLabel?: string }>()
  return data?.fieldLabel || 'Field value'
}

export function ChoiceField(props: TextFieldClientProps) {
  const { field, readOnly } = props
  const { definition, path } = useValueDefinition(props.path)
  const { disabled, setValue, showError, value } = useField<string | null>({
    potentiallyStalePath: path,
  })
  if (definition?.fieldType !== 'select' && definition?.fieldType !== 'radio') return null

  const options = definition.options ?? []
  const visibleOptions =
    value && !options.some((option) => option.value === value)
      ? [...options, { label: value, value }]
      : options
  if (definition.fieldType === 'radio') {
    return (
      <div>
        <RadioGroupField
          field={{
            ...field,
            admin: { description: definition.description ?? undefined },
            label: definition.label,
            options: visibleOptions,
            required: Boolean(definition.required),
            type: 'radio',
          }}
          path={path}
          readOnly={readOnly || disabled}
        />
        {!definition.required && value && !readOnly && !disabled && (
          <Button buttonStyle="ghost" onClick={() => setValue(null)}>
            Clear selection
          </Button>
        )}
      </div>
    )
  }
  return (
    <SelectInput
      description={definition?.description ?? undefined}
      isClearable={!definition?.required}
      label={definition.label}
      name={field.name}
      onChange={(option) => setValue(option && !Array.isArray(option) ? option.value : null)}
      options={visibleOptions}
      path={path}
      readOnly={readOnly || disabled}
      required={Boolean(definition?.required)}
      showError={showError}
      value={value ?? undefined}
    />
  )
}

export function CodeValueField(props: TextareaFieldClientProps) {
  const { definition, path } = useValueDefinition(props.path)
  if (definition?.fieldType !== 'code') return <TextareaField {...props} path={path} />

  return (
    <CodeField
      field={{
        type: 'code',
        name: props.field.name,
        label: definition.label,
        required: Boolean(definition.required),
        admin: { description: definition.description ?? undefined },
      }}
      path={path}
      permissions={props.permissions}
      readOnly={props.readOnly}
    />
  )
}

export function TextValueField(props: TextFieldClientProps) {
  const { definition, path } = useValueDefinition(props.path)
  if (definition?.fieldType !== 'slug') return <TextField {...props} path={path} />
  return (
    <TextField
      {...props}
      path={path}
      field={{
        ...props.field,
        label: definition.label,
        required: Boolean(definition.required),
        admin: {
          ...props.field.admin,
          description: definition.description ?? 'Formatted as a slug on save.',
        },
      }}
    />
  )
}

export function BlockTypeField(props: TextFieldClientProps) {
  const { field, readOnly } = props
  const path = useFieldPath() ?? props.path
  const nested = useContext(NestedDefinition)
  const { disabled, setValue, showError, value } = useField<string>({ potentiallyStalePath: path })
  if (nested?.field.fieldType !== 'blocks') return null

  return (
    <SelectInput
      label="Block type"
      name={field.name}
      onChange={(option) => {
        if (option && !Array.isArray(option)) setValue(option.value)
      }}
      options={(nested.field.fields ?? []).map(({ key, label }) => ({ label, value: key }))}
      path={path}
      readOnly={readOnly || disabled || Boolean(value)}
      required
      showError={showError}
      value={value}
    />
  )
}

export function NestedEntryRowLabel() {
  const nested = useContext(NestedDefinition)
  const { data, rowNumber } = useRowLabel<{ blockKey?: string }>()
  const block = nested?.field.fields?.find(({ key }) => key === data?.blockKey)
  return block?.label || `${nested?.field.fieldType === 'blocks' ? 'Block' : 'Row'} ${rowNumber}`
}

export function NestedValueField(props: ArrayFieldClientProps) {
  const { definition, fieldPath, path } = useValueDefinition(props.path)
  const { addFieldRow, getDataByPath } = useForm()
  const { disabled, rows } = useField({ hasRows: true, potentiallyStalePath: path })
  const type = definition?.fieldType
  const isFixed = type === 'group' || type === 'tabs'
  const { readOnly, schemaPath = path } = props

  useEffect(() => {
    if (isFixed && !readOnly && !getDataByPath<unknown[]>(path)?.length) {
      addFieldRow({ path, schemaPath, rowIndex: 0 })
    }
  }, [addFieldRow, getDataByPath, isFixed, path, readOnly, schemaPath])

  if (!definition || (!isFixed && type !== 'array' && type !== 'blocks')) return null
  return (
    <NestedDefinition.Provider value={{ field: definition, fieldPath }}>
      {isFixed ? (
        rows?.[0] && !rows[0].isLoading ? (
          <RenderFields
            fields={props.field.fields.filter((field) => 'name' in field && field.name === 'items')}
            parentIndexPath=""
            parentPath={`${path}.0`}
            parentSchemaPath={schemaPath}
            permissions={props.permissions === true ? true : (props.permissions?.fields ?? {})}
            readOnly={readOnly || disabled}
          />
        ) : null
      ) : (
        <ArrayField
          {...props}
          path={path}
          field={{
            ...props.field,
            label: definition.label,
            labels:
              type === 'blocks'
                ? { singular: 'Block', plural: 'Blocks' }
                : { singular: 'Row', plural: 'Rows' },
            minRows: definition.minRows ?? undefined,
            maxRows: definition.maxRows ?? props.field.maxRows,
            required: Boolean(definition.required),
            admin: {
              ...props.field.admin,
              description: definition.description ?? undefined,
              initCollapsed: props.field.admin?.initCollapsed,
              isSortable: props.field.admin?.isSortable,
            },
          }}
        />
      )}
    </NestedDefinition.Provider>
  )
}

export function EntryValueArray(props: ArrayFieldClientProps) {
  const nested = useContext(NestedDefinition)
  const { addFieldRow, getDataByPath } = useForm()
  const path = useFieldPath() ?? props.path
  const { readOnly, schemaPath = path } = props
  const rowPath = path.slice(0, path.lastIndexOf('.'))
  const blockKey = useFormFields(([state]) => state[`${rowPath}.blockKey`]?.value)
  const { disabled, rows } = useField({ hasRows: true, potentiallyStalePath: path })
  const isBlocks = nested?.field.fieldType === 'blocks'
  const isTabs = nested?.field.fieldType === 'tabs'
  const block = isBlocks ? nested.field.fields?.find(({ key }) => key === blockKey) : undefined
  const fields = isBlocks ? block?.fields : nested?.field.fields
  const prefix = block ? `${nested?.fieldPath}.${block.key}` : nested?.fieldPath
  const definitions = useMemo(() => new Map(fields?.map((field) => [field.key, field])), [fields])
  const [activeTab, setActiveTab] = useState<string>()
  const tab = (activeTab && definitions.get(activeTab)) || fields?.[0]
  const tabsID = useId()

  useEffect(() => {
    if (!fields || !prefix || readOnly || disabled) return
    addMissingValues({
      addFieldRow,
      fields,
      existing: getDataByPath(path) ?? [],
      path,
      prefix,
      schemaPath,
    })
  }, [addFieldRow, disabled, fields, getDataByPath, path, prefix, readOnly, schemaPath])

  if (!fields) return null
  return (
    <DefinitionFields.Provider value={definitions}>
      {isTabs && tab && (
        <Tabs
          onChange={setActiveTab}
          tabs={fields.map(({ key, label }) => ({
            id: `${tabsID}-tab-${key}`,
            label,
            panelID: `${tabsID}-panel-${key}`,
            value: key,
          }))}
          value={tab.key}
        />
      )}
      {rows?.map((row, index) => {
        if (row.isLoading) return null
        const itemPath = `${path}.${index}`
        return (
          <NestedItem
            key={row.id}
            path={itemPath}
            props={props}
            tab={isTabs ? tab?.key : undefined}
            tabsID={tabsID}
          />
        )
      })}
    </DefinitionFields.Provider>
  )
}

function NestedItem({
  path,
  props,
  tab,
  tabsID,
}: {
  path: string
  props: ArrayFieldClientProps
  tab?: string
  tabsID: string
}) {
  const key = useFormFields(([state]) => state[`${path}.fieldKey`]?.value)
  const definition = useContext(DefinitionFields)?.get(String(key))
  if (!definition) return null

  const column = valueColumn(definition)
  const inputs = (
    <RenderFields
      fields={props.field.fields.filter((field) => 'name' in field && field.name === column)}
      parentIndexPath=""
      parentPath={path}
      parentSchemaPath={props.schemaPath ?? props.path}
      permissions={props.permissions === true ? true : (props.permissions?.fields ?? {})}
      readOnly={props.readOnly}
    />
  )
  return tab ? (
    <div
      aria-labelledby={`${tabsID}-tab-${definition.key}`}
      hidden={tab !== definition.key}
      id={`${tabsID}-panel-${definition.key}`}
      role="tabpanel"
    >
      {inputs}
    </div>
  ) : (
    <div>
      <strong>{definition.label}</strong>
      {inputs}
    </div>
  )
}

export function EntryFields({
  definitionSlug,
  entrySlug,
  ...array
}: ArrayFieldClientProps & { definitionSlug: string; entrySlug: string }) {
  const { config } = useConfig()
  const editDepth = useEditDepth()
  const { addFieldRow, dispatchFields, getDataByPath, removeFieldRow, setModified } = useForm()
  const definition = useFormFields(([state]) => referenceID(state.definition?.value))
  const id = definition === undefined ? undefined : String(definition)
  const selected = useRef<string | undefined>(undefined)
  const [result, setResult] = useState<LoadResult>()
  const [attempt, setAttempt] = useState(0)
  const { path, readOnly, schemaPath = path } = array
  const api = config.routes.api

  useEffect(() => {
    if (selected.current !== undefined && selected.current !== id && !readOnly) {
      const rows: unknown[] = getDataByPath(path) ?? []
      for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
        removeFieldRow({ path, rowIndex })
      }
    }
    selected.current = id
    if (id === undefined) return

    const controller = new AbortController()
    async function load(current: string) {
      try {
        const response = await fetch(
          `${api}/${definitionSlug}/${encodeURIComponent(current)}?depth=0`,
          {
            cache: attempt ? 'reload' : 'default',
            signal: controller.signal,
          },
        )
        if (!response.ok) throw new Error('Collection definition could not be loaded.')
        const schema: Definition = await response.json()
        const currentID = referenceID(getDataByPath('definition'))
        if (controller.signal.aborted || currentID === undefined || current !== String(currentID))
          return

        if (!readOnly) {
          const existing =
            getDataByPath<({ fieldKey: string } & Record<string, unknown>)[]>(path) ?? []
          const byKey = new Map(schema.fields.map((field) => [field.key, field]))
          for (let rowIndex = existing.length - 1; rowIndex >= 0; rowIndex--) {
            const row = existing[rowIndex]
            if (!byKey.has(row.fieldKey) && !hasStoredValue(row)) {
              removeFieldRow({ path, rowIndex })
            }
          }
          const retained = existing.filter((row) => byKey.has(row.fieldKey) || hasStoredValue(row))
          let metadataChanged = false
          for (const [index, row] of retained.entries()) {
            const field = byKey.get(row.fieldKey)
            if (!field || hasStoredValue(row)) continue
            // Empty rows survive a type change in SQL. Refresh their metadata so
            // native input conditions render the new type when opening the form.
            for (const [name, value] of Object.entries({
              fieldType: field.fieldType,
              fieldLabel: field.label,
              fieldMany: Boolean(field.hasMany),
            })) {
              if (row[name] === value) continue
              metadataChanged = true
              dispatchFields({
                type: 'UPDATE',
                path: `${path}.${index}.${name}`,
                value,
                valid: true,
              })
            }
          }
          if (metadataChanged) setModified(true)
          addMissingValues({
            addFieldRow,
            fields: schema.fields,
            existing: retained,
            path,
            schemaPath,
          })
        }
        setResult({ id: current, fields: schema.fields, title: schema.title })
      } catch {
        if (!controller.signal.aborted) setResult({ id: current, error: true })
      }
    }
    void load(id)
    return () => controller.abort()
  }, [
    addFieldRow,
    api,
    attempt,
    definitionSlug,
    dispatchFields,
    getDataByPath,
    id,
    path,
    readOnly,
    removeFieldRow,
    schemaPath,
    setModified,
  ])

  const current = result?.id === id ? result : undefined
  const fields = current && 'fields' in current ? current.fields : undefined
  const definitions = useMemo(
    () => (fields ? new Map(fields.map((field) => [field.key, field])) : undefined),
    [fields],
  )
  if (id === undefined) return null
  return (
    <DefinitionFields.Provider value={definitions}>
      {editDepth <= 1 && (
        <CollectionBreadcrumb
          definitionID={id}
          entrySlug={entrySlug}
          title={current && 'title' in current ? current.title : undefined}
        />
      )}
      {current && 'error' in current && (
        <div role="status">
          Could not load the collection fields.
          <Button buttonStyle="secondary" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      <ArrayField
        {...array}
        field={{ ...array.field, maxRows: fields?.length ?? array.field.maxRows }}
      />
    </DefinitionFields.Provider>
  )
}
