import type {
  Access,
  CollectionBeforeOperationHook,
  CollectionConfig,
  CollectionSlug,
  PayloadRequest,
} from 'payload'
import { type ID, referenceID } from './entry-values'

export type PayloadDynamicAccess = Partial<Record<'read' | 'update' | 'delete', Access>> & {
  create?: (...args: Parameters<Access>) => boolean | Promise<boolean>
}

export type PayloadDynamicWorkspace = {
  /** An existing Payload collection such as teams, organizations, or workspaces. */
  collection: CollectionSlug
  /** Resolve the workspace IDs the request is allowed to use. */
  allowedIDs: (req: PayloadRequest) => readonly ID[] | Promise<readonly ID[]>
}

type WorkspaceScope = {
  path: string
  workspace: PayloadDynamicWorkspace
  canCreate: (args: Parameters<Access>[0], ids: readonly ID[]) => boolean | Promise<boolean>
}

export function dynamicAccess(
  canManage: Access,
  overrides: PayloadDynamicAccess = {},
  scope?: WorkspaceScope,
): NonNullable<CollectionConfig['access']> {
  const createOverride = overrides.create
  const createPolicy: Access = createOverride
    ? async (args) => (await createOverride(args)) === true
    : canManage
  const constrain = (policy: Access): Access => {
    if (!scope) return policy
    return async (args) => {
      const result = await policy(args)
      if (!result) return false
      const ids = await scope.workspace.allowedIDs(args.req)
      if (!ids.length) return false
      const filter = { [scope.path]: { in: [...ids] } }
      return result === true ? filter : { and: [result, filter] }
    }
  }

  const create: Access = scope
    ? async (args) => {
        // Native Payload create access is a boolean gate. A Where is not a create policy.
        if ((await createPolicy(args)) !== true) return false
        const ids = await scope.workspace.allowedIDs(args.req)
        return ids.length > 0 && (args.data === undefined || (await scope.canCreate(args, ids)))
      }
    : createPolicy
  const update = constrain(overrides.update ?? canManage)
  return {
    create,
    read: constrain(overrides.read ?? canManage),
    update,
    delete: constrain(overrides.delete ?? canManage),
    ...((scope || createOverride || overrides.update) && {
      validate: (args) => (args.id === undefined ? create(args) : update(args)),
    }),
  }
}

export function withinWorkspace(value: unknown, ids: readonly ID[]) {
  const id = referenceID(value)
  return id !== undefined && ids.some((allowed) => String(allowed) === String(id))
}

export const inheritDuplicateScope =
  (field: 'workspace' | 'definition'): CollectionBeforeOperationHook =>
  async ({ args, operation, overrideAccess, req, collection }) => {
    if (operation !== 'create' || overrideAccess) return
    const sourceID = referenceID(args.duplicateFromID)
    const data = args.data as Record<string, unknown> | undefined
    if (sourceID === undefined || data?.[field] !== undefined) return

    // Payload fills inherited fields after checking create access. Supply its
    // source scope early using the same caller's read access.
    const source = await req.payload.findByID({
      collection: collection.slug,
      id: sourceID,
      depth: 0,
      disableErrors: true,
      overrideAccess: false,
      req,
      select: { [field]: true },
    })
    const id = source ? referenceID(Reflect.get(source, field)) : undefined
    if (id !== undefined) args.data = { ...args.data, [field]: id }
  }
