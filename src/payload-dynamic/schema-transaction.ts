import { type DrizzleAdapter, operatorMap, type TransactionPg } from '@payloadcms/drizzle'
import type { PayloadRequest } from 'payload'
import type { ID } from './entry-values'

// Both writers take the same definition lock before reading schema/value state.
// Keep it inside Payload's transaction; never open a separate connection/lock or
// change the host's transaction configuration. SQLite uses BEGIN IMMEDIATE.
export async function lockDefinition(
  req: PayloadRequest,
  tableName: string,
  id: ID,
): Promise<boolean> {
  if (req.payload.db.name !== 'postgres' && req.payload.db.name !== 'sqlite') return false
  const transactionID = await req.transactionID
  if (transactionID == null) return false
  const adapter = req.payload.db as DrizzleAdapter
  const tx = adapter.sessions[String(transactionID)]?.db
  if (!tx) return false
  if (adapter.name === 'postgres') {
    const table = adapter.tables[tableName]
    await (tx as TransactionPg)
      .update(table)
      .set({ updatedAt: table.updatedAt })
      .where(operatorMap.equals(table.id, id))
  }
  return true
}
