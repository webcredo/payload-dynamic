'use client'

import { SelectField, useFieldPath, useFormFields } from '@payloadcms/ui'
import type { SelectFieldClientProps } from 'payload'

export function DefinitionFieldType(props: SelectFieldClientProps) {
  const path = useFieldPath() ?? props.path
  const parent = path.split('.').slice(0, -3).join('.')
  const parentType = useFormFields(([state]) => state[`${parent}.fieldType`]?.value)

  if (parentType !== 'blocks' && parentType !== 'tabs')
    return <SelectField {...props} path={path} />
  const options = props.field.options.filter((option) =>
    typeof option === 'string' ? option === 'group' : option.value === 'group',
  )
  return <SelectField {...props} field={{ ...props.field, options }} path={path} />
}
