import { route, query } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { tagReport } from "../../../../../modules/closing-reporting/reports";
import { month } from "../../../../../modules/closing-reporting/closing";

/** ?month=AAAA-MM filtra a competência; sem o parâmetro, acumula tudo (valor total do contrato). */
export const GET = route(async ({ principal, deps, params, request }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "finance.view" }, (c, a) => {
    const m = query(request, "month");
    return tagReport(c, a.tenantId, m ? month.parse(m) : undefined);
  }));
