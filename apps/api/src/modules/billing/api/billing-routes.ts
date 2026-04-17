import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import { jsonResponse } from "../../../common/http/json.js";
import { getErrorMessage, jsonRoute, route, type RouteDef } from "../../../app/router.js";
import type { BillingHttpHandler } from "./billing-handler.js";

function parseClientId(rawClientId: string): number {
  return Number.parseInt(rawClientId, 10);
}

function inputErrorStatus(error: unknown): number {
  return error instanceof InputValidationError ? 400 : 500;
}

function inputErrorStatusWithMessages(messages: string[]) {
  return (error: unknown): number =>
    error instanceof InputValidationError || (error instanceof Error && messages.includes(error.message)) ? 400 : 500;
}

function renderBillingInvoiceHtml(invoice: NonNullable<Awaited<ReturnType<BillingHttpHandler["handleInvoice"]>>>) {
  const fmt = (value: number) => `$${(Number(value) || 0).toFixed(2)}`;
  const generated = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const rows = invoice.details.map((detail) => `
      <tr>
        <td>${detail.shipDate?.slice(0, 10) ?? ""}</td>
        <td class="mono">${detail.orderNumber || detail.orderId}</td>
        <td class="sku">${detail.skus || "—"}</td>
        <td class="num">${detail.baseQty}</td>
        <td class="num">${fmt(detail.pickpackAmt)}</td>
        <td class="num">${detail.addlQty > 0 ? `${detail.addlQty} (${fmt(detail.additionalAmt)})` : "—"}</td>
        <td class="num">${detail.shippingAmt > 0 ? fmt(detail.shippingAmt) : "—"}</td>
        <td class="num">${detail.storageAmt > 0 ? fmt(detail.storageAmt) : "—"}</td>
        <td class="num bold">${fmt(detail.rowTotal)}</td>
      </tr>
    `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Invoice — ${invoice.clientName} — ${invoice.from} to ${invoice.to}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #111; background: #fff; padding: 40px 48px; max-width: 1100px; margin: 0 auto; }
    .print-tip { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 10px 16px; margin-bottom: 24px; font-size: 12px; color: #1d4ed8; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 2px solid #e5e7eb; }
    .brand h1 { font-size: 22px; font-weight: 800; color: #111; letter-spacing: -.3px; }
    .brand .sub { font-size: 11px; color: #9ca3af; margin-top: 3px; }
    .meta { text-align: right; }
    .meta .client-name { font-size: 18px; font-weight: 700; color: #111; }
    .meta .date-range { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .meta .gen-date { font-size: 10px; color: #9ca3af; margin-top: 2px; }
    .summary-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 20px; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; }
    .card .cl { font-size: 10px; color: #9ca3af; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 3px; }
    .card .cv { font-size: 16px; font-weight: 700; color: #111; }
    .grand-total { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .grand-total .gtl { font-size: 13px; font-weight: 600; color: #166534; }
    .grand-total .gtv { font-size: 24px; font-weight: 800; color: #166534; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead th { background: #f9fafb; border: 1px solid #e5e7eb; padding: 7px 10px; font-weight: 700; color: #374151; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; }
    thead th.num { text-align: right; }
    tbody td { border: 1px solid #e5e7eb; padding: 6px 10px; color: #374151; vertical-align: middle; }
    tbody tr:nth-child(even) { background: #fafafa; }
    td.num { text-align: right; }
    td.mono { font-family: monospace; font-size: 11px; color: #2563eb; }
    td.sku { font-family: monospace; font-size: 10px; color: #6b7280; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td.bold { font-weight: 700; }
    tfoot td { border: 1px solid #d1d5db; padding: 8px 10px; font-weight: 700; background: #f3f4f6; }
    tfoot td.num { text-align: right; }
    .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 10px; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="print-tip">To save as PDF: press <strong>Ctrl+P</strong> or <strong>⌘P</strong>, then choose <strong>Save as PDF</strong>.</div>
  <div class="header">
    <div class="brand">
      <h1>Invoice</h1>
      <div class="sub">DR Prepper 3PL Services · 14924 S Figueroa St, Gardena CA 90248</div>
    </div>
    <div class="meta">
      <div class="client-name">Bill To: ${invoice.clientName}</div>
      <div class="date-range">Period: ${invoice.from} → ${invoice.to}</div>
      <div class="gen-date">Generated ${generated}</div>
    </div>
  </div>
  <div class="summary-grid">
    <div class="card"><div class="cl">Orders</div><div class="cv">${invoice.summary.orderCount}</div></div>
    <div class="card"><div class="cl">Pick &amp; Pack</div><div class="cv">${fmt(invoice.summary.pickPackTotal)}</div></div>
    <div class="card"><div class="cl">Add'l Units</div><div class="cv">${fmt(invoice.summary.additionalTotal)}</div></div>
    <div class="card"><div class="cl">Packages</div><div class="cv">${invoice.summary.packageTotal > 0 ? fmt(invoice.summary.packageTotal) : "—"}</div></div>
    <div class="card"><div class="cl">Shipping</div><div class="cv">${fmt(invoice.summary.shippingTotal)}</div></div>
    <div class="card"><div class="cl">Storage</div><div class="cv">${invoice.summary.storageTotal > 0 ? fmt(invoice.summary.storageTotal) : "—"}</div></div>
  </div>
  <div class="grand-total">
    <div class="gtl">Total Amount Due — ${invoice.from} → ${invoice.to}</div>
    <div class="gtv">${fmt(invoice.summary.grandTotal)}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Ship Date</th>
        <th>Order #</th>
        <th>SKU(s)</th>
        <th class="num">Base Qty</th>
        <th class="num">Pick &amp; Pack</th>
        <th class="num">Add'l Units</th>
        <th class="num">Shipping</th>
        <th class="num">Storage</th>
        <th class="num">Row Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">Totals — ${invoice.summary.orderCount} orders</td>
        <td class="num">${fmt(invoice.summary.pickPackTotal)}</td>
        <td class="num">${fmt(invoice.summary.additionalTotal)}</td>
        <td class="num">${fmt(invoice.summary.shippingTotal)}</td>
        <td class="num">${invoice.summary.storageTotal > 0 ? fmt(invoice.summary.storageTotal) : "—"}</td>
        <td class="num" style="font-size:14px">${fmt(invoice.summary.grandTotal)}</td>
      </tr>
    </tfoot>
  </table>
  <div class="footer">PrepShip · Invoice generated ${generated} · Not a formal tax document · ${invoice.summary.orderCount} orders · ${invoice.from} → ${invoice.to}</div>
</body>
</html>`;
}

export function createBillingRoutes(handler: BillingHttpHandler): RouteDef[] {
  const getGenerateErrorStatus = inputErrorStatusWithMessages(["from and to required", "from and to must be YYYY-MM-DD"]);
  const getDetailsErrorStatus = inputErrorStatusWithMessages(["from, to, clientId required", "from and to must be YYYY-MM-DD"]);
  const getPackagePricesErrorStatus = inputErrorStatusWithMessages(["clientId required"]);
  const getUpdatePackagePricesErrorStatus = inputErrorStatusWithMessages(["clientId and prices[] required"]);
  const getSetDefaultPackagePricesErrorStatus = inputErrorStatusWithMessages(["packageId and price required"]);

  return [
    jsonRoute("GET", "/api/billing/config", () => handler.handleConfig(), { getErrorStatus: inputErrorStatus }),
    jsonRoute(
      "PUT",
      "/api/billing/config/:clientId(int)",
      async ({ params, readJson }) => handler.handleUpdateConfig(parseClientId(params.clientId ?? "0"), await readJson()),
      { getErrorStatus: inputErrorStatus },
    ),
    jsonRoute("POST", "/api/billing/generate", async ({ readJson }) => handler.handleGenerate(await readJson()), {
      getErrorStatus: getGenerateErrorStatus,
    }),
    jsonRoute("GET", "/api/billing/summary", ({ url }) => handler.handleSummary(url), {
      getErrorStatus: getGenerateErrorStatus,
    }),
    jsonRoute("GET", "/api/billing/details", ({ url }) => handler.handleDetails(url), {
      getErrorStatus: getDetailsErrorStatus,
    }),
    jsonRoute("GET", "/api/billing/package-prices", ({ url }) => handler.handlePackagePrices(url), {
      getErrorStatus: getPackagePricesErrorStatus,
    }),
    jsonRoute("PUT", "/api/billing/package-prices", async ({ readJson }) => handler.handleUpdatePackagePrices(await readJson()), {
      getErrorStatus: getUpdatePackagePricesErrorStatus,
    }),
    jsonRoute(
      "POST",
      "/api/billing/package-prices/set-default",
      async ({ readJson }) => handler.handleSetDefaultPackagePrices(await readJson()),
      { getErrorStatus: getSetDefaultPackagePricesErrorStatus },
    ),
    route("GET", "/api/billing/invoice", async ({ url }) => {
      const getInvoiceErrorStatus = inputErrorStatusWithMessages(["from, to, clientId required", "from and to must be YYYY-MM-DD"]);

      try {
        const invoice = await handler.handleInvoice(url);
        if (!invoice) {
          return new Response("<p>Client not found</p>", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
        }

        return new Response(renderBillingInvoiceHtml(invoice), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch (error) {
        return new Response(`<p style="font-family:sans-serif;padding:40px;color:red">${getErrorMessage(error)}</p>`, {
          status: getInvoiceErrorStatus(error),
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    }),
    jsonRoute("POST", "/api/billing/fetch-ref-rates", () => handler.handleFetchRefRates(), {
      getErrorStatus: inputErrorStatus,
    }),
    route("GET", "/api/billing/fetch-ref-rates/status", () => jsonResponse(200, handler.handleFetchRefRatesStatus())),
    jsonRoute("POST", "/api/billing/backfill-ref-rates", async ({ readJson }) => handler.handleBackfillRefRates(await readJson()), {
      getErrorStatus: inputErrorStatus,
    }),
  ];
}
