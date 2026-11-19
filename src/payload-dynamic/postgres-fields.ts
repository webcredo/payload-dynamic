import { editorConfigFactory, getEnabledNodes, lexicalEditor } from '@payloadcms/richtext-lexical'
import {
  LineBreakNode,
  ParagraphNode,
  TabNode,
  TextNode,
} from '@payloadcms/richtext-lexical/lexical'
import { hasText } from '@payloadcms/richtext-lexical/shared'
import { APIError, type Field, type RichTextFieldValidation, validations } from 'payload'

const validateRichText: RichTextFieldValidation = async (value, field) => {
  if (value != null) {
    const enabledNodes = getEnabledNodes({ editorConfig: editorConfigFactory.fromField({ field }) })
    const nodeClasses = [
      TextNode,
      LineBreakNode,
      TabNode,
      ParagraphNode,
      ...enabledNodes.map((node) => (typeof node === 'function' ? node : node.replace)),
    ]
    // The configured server nodes can come from a separate Lexical bundle in Next.js.
    const prototypes = new Map(nodeClasses.map((node) => [node.getType(), node.prototype]))

    function isRegistered(node: unknown, atRoot = false): boolean {
      if (
        !isRecord(node) ||
        typeof node.type !== 'string' ||
        node.type === 'root' ||
        '$slots' in node
      ) {
        return false
      }
      const prototype = prototypes.get(node.type)
      if (!prototype) return false
      const isElement = 'getChildren' in prototype
      if (atRoot && !isElement && !('decorate' in prototype)) return false
      return (
        node.children === undefined ||
        (isElement &&
          Array.isArray(node.children) &&
          node.children.every((child) => isRegistered(child)))
      )
    }

    const children = lexicalChildren(value)
    if (!children?.length || !children.every((node) => isRegistered(node, true))) {
      return field.req.t('validation:invalidInput')
    }
  }
  return validations.richText(value, field)
}

export function postgresValueFields(): Field[] {
  return [
    {
      name: 'jsonValue',
      type: 'json',
      label: 'JSON value',
      // Dynamic values are already typed JSON. Payload also tries to parse strings as editor text.
      validate: (value, options) => validations.json(value, { ...options, jsonError: undefined }),
      admin: {
        condition: (_, row) => row.fieldType === 'json',
        components: { Field: 'payload-dynamic/react#PostgresJSONField' },
      },
    },
    {
      name: 'richTextValue',
      type: 'richText',
      label: 'Rich text value',
      editor: lexicalEditor(),
      validate: validateRichText,
      admin: { condition: (_, row) => row.fieldType === 'richText' },
    },
  ]
}

type JSONValue = boolean | number | string | null | JSONValue[] | { [key: string]: JSONValue }

function isPostgresString(value: string) {
  return !/[\0\p{Surrogate}]/u.test(value)
}

function isPostgresJSON(value: unknown, ancestors = new Set<object>()): value is JSONValue {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return isPostgresString(value)
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false

  ancestors.add(value)
  const prototype = Object.getPrototypeOf(value)
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => isPostgresJSON(item, ancestors))
    : (prototype === Object.prototype || prototype === null) &&
      Object.entries(value).every(
        ([key, item]) => isPostgresString(key) && isPostgresJSON(item, ancestors),
      )
  ancestors.delete(value)
  return valid
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function lexicalChildren(value: unknown): unknown[] | undefined {
  if (!isRecord(value) || 'jsonContent' in value) return
  const { root } = value
  if (
    isRecord(root) &&
    root.type === 'root' &&
    !('$slots' in root) &&
    Array.isArray(root.children)
  ) {
    return root.children
  }
}

function isLexicalNode(node: unknown): boolean {
  return (
    isRecord(node) &&
    typeof node.type === 'string' &&
    (node.type !== 'text' || typeof node.text === 'string') &&
    (node.children === undefined ||
      (Array.isArray(node.children) && node.children.every(isLexicalNode)))
  )
}

export function normalizePostgresValue(
  fieldType: 'json' | 'richText',
  value: unknown,
  { label, required }: { label: string; required?: boolean },
): unknown {
  if (value == null) {
    if (required) throw new APIError(`${label} is required.`, 400)
    return null
  }
  if (!isPostgresJSON(value)) throw new APIError(`${label}: Enter valid JSON.`, 400)
  if (fieldType === 'richText') {
    const children = lexicalChildren(value)
    if (!children?.length || !children.every(isLexicalNode)) {
      throw new APIError(`${label}: Enter a valid Lexical editor state.`, 400)
    }
    if (required && !hasText(value as unknown as Parameters<typeof hasText>[0])) {
      throw new APIError(`${label} is required.`, 400)
    }
  }
  return value
}
