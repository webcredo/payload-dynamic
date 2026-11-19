'use client'

import {
  CodeEditorLazy,
  FieldDescription,
  FieldError,
  FieldLabel,
  useField,
  useFieldPath,
  useForm,
  useFormFields,
  useTranslation,
} from '@payloadcms/ui'
import type { JSONFieldClientProps } from 'payload'
import { useState } from 'react'
import { invalidJSONDraftKey } from './entry-values'

function format(value: unknown) {
  return value == null ? '' : JSON.stringify(value, null, 2)
}

function validateNumber(_: string, value: unknown) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError('JSON numbers must be finite.')
  }
  return value
}

export function PostgresJSONField(props: JSONFieldClientProps) {
  const path = useFieldPath() ?? props.path
  const markerPath = `${path.slice(0, path.lastIndexOf('.'))}.${invalidJSONDraftKey}`
  const { field } = props
  const { t } = useTranslation()
  const { dispatchFields, setModified } = useForm()
  const { disabled, showError, value } = useField<unknown>({ potentiallyStalePath: path })
  const invalid = useFormFields(([state]) => state[markerPath]?.value === true)
  const [draft, setDraft] = useState<{ input: string; formattedValue: string }>()
  const formattedValue = format(value)
  const readOnly = props.readOnly || disabled

  function update(source = '') {
    if (readOnly) return
    let parsed: unknown
    try {
      parsed = source ? JSON.parse(source, validateNumber) : null
    } catch {
      // Preserve the last typed value and send only a transient error indicator on Save.
      setDraft({ input: source, formattedValue })
      dispatchFields({ type: 'UPDATE', path: markerPath, value: true, valid: true })
      setModified(true)
      return
    }
    setDraft({ input: source, formattedValue: format(parsed) })
    dispatchFields({ type: 'REMOVE', path: markerPath })
    dispatchFields({ type: 'UPDATE', path, value: parsed, valid: true, errorMessage: undefined })
    setModified(true)
  }

  return (
    <div className={`field-type json-field${invalid || showError ? ' error' : ''}`}>
      <FieldLabel as="span" label={field.label} path={path} required={field.required} />
      <div className="json-field__wrap">
        <FieldError
          message={invalid ? t('validation:invalidInput') : undefined}
          path={path}
          showError={invalid || showError}
        />
        <CodeEditorLazy
          defaultLanguage="json"
          onChange={update}
          options={{
            ariaLabel: typeof field.label === 'string' ? field.label : field.name,
          }}
          readOnly={readOnly}
          value={draft?.formattedValue === formattedValue ? draft.input : formattedValue}
          wrapperProps={{ id: `field-${path.replace(/\./g, '__')}` }}
        />
      </div>
      <FieldDescription description={field.admin?.description} path={path} />
    </div>
  )
}
