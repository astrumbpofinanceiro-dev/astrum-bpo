/** Leitura de lançamentos com visibilidade por papel, escopo e Modo Cego. */
import type pg from "pg";
import { can, type Access, type Resource } from "../identity-access/authorize";

const SQL = `
  SELECT id, 'OPERATION' AS kind, business_unit_id, NULL::uuid AS financial_account_id, created_by_user_id,
         review_status, operation_date AS date, gross_amount AS amount, description, entry_type,
         operation_type, tag_id, category_id
    FROM economic_operations WHERE tenant_id = $1 AND deleted_at IS NULL
     AND ($2::uuid IS NULL OR created_by_user_id = $2) AND ($3::uuid IS NULL OR business_unit_id = $3)
     AND ($4::uuid IS NULL OR id = $4)
  UNION ALL
  SELECT id, 'CASH', business_unit_id, financial_account_id, created_by_user_id,
         review_status, transaction_date, amount, COALESCE(description, direction), entry_type,
         NULL::varchar, NULL::uuid, NULL::uuid
    FROM cash_transactions WHERE tenant_id = $1 AND deleted_at IS NULL
     AND ($2::uuid IS NULL OR created_by_user_id = $2) AND ($3::uuid IS NULL OR business_unit_id = $3)
     AND ($4::uuid IS NULL OR id = $4)
  ORDER BY date DESC, id LIMIT 500`;

export function entryResource(row: Record<string, string | null>): Resource {
  return {
    businessUnitId: row.business_unit_id,
    financialAccountId: row.kind === "CASH" ? row.financial_account_id : undefined,
    ownerUserId: row.created_by_user_id!,
    status: row.review_status!,
  };
}

export async function listEntries(
  c: pg.PoolClient, access: Access, filter: { businessUnitId?: string; id?: string } = {},
) {
  const ownOnly = access.roles.every((r) => r === "CLIENT_EMPLOYEE") ? access.userId : null;
  const { rows } = await c.query(SQL, [access.tenantId, ownOnly, filter.businessUnitId ?? null, filter.id ?? null]);
  return rows.filter((row) => can(access, "entries.view", entryResource(row)));
}
