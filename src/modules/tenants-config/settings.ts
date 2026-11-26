/** Configurações com vigência (v3.1 §5.4). Somente chaves conhecidas. */
import type pg from "pg";
import { z } from "zod";
import { conflict, invalid } from "../../shared/errors";
import { businessDate } from "../../shared/dates/business-date";

const amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);

export const SETTINGS = {
  ENABLE_COST_CENTERS: z.boolean(),
  ENABLE_TAGS: z.boolean(),
  CLIENT_MANUAL_ENTRY_ENABLED: z.boolean(),
  MANUAL_RECEIPT_THRESHOLD: amount,
  /** Severidade da pendência de lançamento sem comprovante acima do limite. Padrão: WARNING. */
  MANUAL_RECEIPT_SEVERITY: z.enum(["WARNING", "BLOCKING_OPERATIONAL"]),
  /** D11: segunda aprovação, desligada por padrão. */
  DUAL_APPROVAL_ENABLED: z.boolean(),
  /** Valor a partir do qual estorno é "relevante". Ausente = todo estorno. */
  DUAL_APPROVAL_THRESHOLD: amount,
  /** Tolerância de centavos (Doc 3 §2.3). Ausente = 0,05. */
  RECONCILIATION_TOLERANCE: amount,
  /** Limites do BPO ao que o Master Cliente pode conceder. Ausente = nada além do básico. */
  CLIENT_GRANT_LIMITS: z.strictObject({
    canGrantReports: z.boolean(),
    canGrantBankBalances: z.boolean(),
    canDisableBlindMode: z.boolean(),
    maxEntryAmount: amount.nullable(),
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type GrantLimits = z.infer<(typeof SETTINGS)["CLIENT_GRANT_LIMITS"]>;

export const DEFAULT_GRANT_LIMITS: GrantLimits = {
  canGrantReports: false, canGrantBankBalances: false, canDisableBlindMode: false, maxEntryAmount: null,
};

export const settingInput = z.strictObject({
  key: z.enum(Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]]),
  value: z.unknown(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable().default(null),
});

export async function createSettingVersion(
  client: pg.PoolClient, tenantId: string, userId: string, raw: z.input<typeof settingInput>,
) {
  const input = settingInput.parse(raw);
  const value = SETTINGS[input.key].safeParse(input.value);
  if (!value.success) throw invalid("INVALID_SETTING_VALUE");
  let from: string, to: string | null;
  try {
    from = businessDate(input.effectiveFrom);
    to = input.effectiveTo === null ? null : businessDate(input.effectiveTo);
  } catch {
    throw invalid("INVALID_DATE");
  }
  if (to !== null && to < from) throw invalid("INVALID_DATE_RANGE");

  // Serializa versões concorrentes da mesma chave.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenantId}:${input.key}`]);
  const latest = (await client.query(
    `SELECT id, version, effective_from, effective_to FROM client_settings
      WHERE tenant_id = $1 AND setting_key = $2 ORDER BY version DESC LIMIT 1`, [tenantId, input.key])).rows[0];
  // Sem vigência retroativa: não muda a regra que valia em períodos anteriores.
  if (latest && from < latest.effective_from) throw conflict("RETROACTIVE_SETTING");
  if (latest && from > latest.effective_from && (latest.effective_to === null || latest.effective_to >= from)) {
    await client.query("UPDATE client_settings SET effective_to = $2::date - 1 WHERE id = $1", [latest.id, from]);
  }
  return (await client.query(
    `INSERT INTO client_settings (tenant_id, setting_key, setting_value, effective_from, effective_to, version, updated_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, setting_key, setting_value, effective_from, effective_to, version`,
    [tenantId, input.key, JSON.stringify(value.data), from, to, (latest?.version ?? 0) + 1, userId])).rows[0];
}

/** Valor vigente na data: maior versão que cobre o dia. null = não configurado. */
export async function resolveSetting<K extends SettingKey>(
  client: pg.PoolClient, tenantId: string, key: K, date: string,
): Promise<z.infer<(typeof SETTINGS)[K]> | null> {
  const row = (await client.query(
    `SELECT setting_value FROM client_settings
      WHERE tenant_id = $1 AND setting_key = $2 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3)
      ORDER BY version DESC LIMIT 1`, [tenantId, key, date])).rows[0];
  return row ? (SETTINGS[key].parse(row.setting_value) as z.infer<(typeof SETTINGS)[K]>) : null;
}

/** "Hoje" como data de negócio no fuso de operação. */
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
