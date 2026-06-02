# PrepShip Security Readiness Checklist

This document is a PrepShip security readiness checklist for external sales, customer diligence, and future audit preparation. It covers SOC 2-aligned controls/readiness work only.

PrepShip is not SOC 2 compliant until a qualified third-party auditor completes the report.

## SOC 2-Aligned Framing

SOC 2 Type I reviews whether controls are suitably designed at a point in time. SOC 2 Type II reviews whether those controls operated over an audit period. PrepShip can describe this work as security readiness, SOC 2-aligned control preparation, or preparing for a SOC 2 audit. Sales, onboarding, and support materials must not claim compliance or certification before the auditor report exists.

Final readiness status language:

| Status | Meaning | Allowed external wording |
|---|---|---|
| Blocked | Required technical guard, policy, owner, or evidence is missing. | "Security work is in progress." |
| Conditional | Required guard exists, but business evidence or audit artifacts still need collection. | "SOC 2-aligned controls/readiness work is underway." |
| Ready for auditor | Technical gates pass and evidence is collected for auditor review. | "PrepShip is preparing for SOC 2 review." |

## PrepShip Security Checklist Before External Sales

| Area | Required control | Evidence to collect | Owner | Gate |
|---|---|---|---|---|
| multi-tenant/client/store data isolation | Client A cannot view/query/update Client B orders. browser filters are not authorization; every API must enforce server-side tenant/client/store data isolation. | API guard output, RBAC matrix, negative tenant test logs. | Engineering | `npm run test:client-store-scope` |
| auth/RBAC/MFA | Internal users, admins, warehouse users, and client users have role-scoped access. MFA must be enabled for production admin and vendor accounts. | MFA enabled screenshots, access review, role matrix. | Engineering/Ops | `npm run test:auth-coverage`, `npm run test:rbac-permissions` |
| portal vs internal admin permission boundary | Client portal read-only access is separate from PrepShip internal ops/admin capability. | Portal/internal boundary guard output and role review. | Engineering | `npm run test:field-level-rbac`, `npm run test:field-level-rbac-extended` |
| label/postage safety | Duplicate active label attempts are blocked or explicitly recovered. Tests must never buy postage or create real labels unless a human approves a live certification run. | Print queue ownership guard, label/shipment scope review, dry-run evidence. | Engineering/Ops | `npm run test:label-shipment-scope-review`, `npm run test:print-queue-ownership` |
| marketplace/source confirmation lifecycle | Local shipped state is not proof of marketplace/source confirmation. ShipStation, eBay, Walmart, and Shopify confirmation outbox/retry state must be auditable. | Confirmation test reports, outbox audit output, recovery logs. | Engineering/Ops | Shipping certification suite |
| secrets management | No API keys/tokens in repo or docs. Secrets live in approved environment stores with rotation ownership. | Secret rotation records, secret scanning evidence. | Engineering/Ops | `npm run test:secrets-governance` |
| PII/data privacy/redaction | No full customer addresses in logs/reports. Customer names, phones, addresses, label URLs, and tracking context are redacted where not needed. | Redaction audit output and privacy plan. | Engineering/Ops | `npm run test:privacy-compliance`, `npm run test:raw-error-response-audit` |
| audit logging | Admin/user-management actions audited, including role changes, sensitive overrides, shipment recovery, and security-impacting settings. | Audit logging guard output and sampled event IDs. | Engineering | `npm run test:audit-logging` |
| secure API design | APIs reject cross-client access, raw error leaks, unsafe CORS, and browser-only authorization assumptions. | API guard outputs and route review. | Engineering | `npm run test:marketplace-order-auth-cors` |
| database/RLS/backups/restore | Production database access is least-privilege, backups are configured, restore is tested, and destructive changes are change-controlled. | Backup/restore expectations, backup restore test result, access review. | Engineering/Ops | Manual evidence plus database review |
| dependency/supply-chain security | Lockfiles, CI checks, dependency review, and deployment branch controls are maintained. | GitHub branch protection screenshots/settings export, dependency audit output. | Engineering | Build/typecheck plus GitHub evidence |
| webhook security | Store, carrier, and marketplace webhooks validate signatures/tokens, reject stale/replayed events, and log safe diagnostics. | Webhook route review, replay test notes. | Engineering | Connector/security review |
| incident response | Security incidents have owner, severity, notification path, customer impact process, and postmortem template. | Incident response policy, drill record. | Ops/Leadership | Manual evidence |
| monitoring/availability | Production API, worker, sync, marketplace confirmation, print queue, and rate services are monitored with actionable alerts. | Monitoring dashboard screenshots, alert routing, incident drill. | Engineering/Ops | Observability guards |
| SOC 2 evidence readiness | Evidence is collected, dated, owner-assigned, and mapped to the security checklist before auditor engagement. | Evidence folder index, owner sign-off. | Leadership/Ops | `npm run test:security-readiness` |

## PrepShip-Specific Security Rules

- Client A cannot view/query/update Client B orders, labels, billing, inventory, manifests, print queue rows, carrier accounts, or marketplace confirmation state.
- browser filters are not authorization. Every privileged route must independently enforce tenant/client/store data isolation.
- Duplicate active label attempts must not create duplicate postage, duplicate marketplace notifications, or silent local shipped states.
- Tests must never buy postage or create real labels during routine certification. Live label tests require explicit human approval and a recorded order scope.
- Local shipped state is not proof of marketplace/source confirmation. ShipStation, eBay, Walmart, Shopify, and source-store notification outcomes must have separate evidence.
- No API keys/tokens in repo or docs, including examples, screenshots, reports, console output, and generated markdown.
- No full customer addresses in logs/reports. Use order IDs, client IDs, store IDs, and redacted customer context instead.
- Admin/user-management actions audited means role changes, client assignments, login/logout, security setting changes, and emergency overrides are captured.
- Backup/restore expectations include backup schedule, retention, restore owner, last restore date, result, and open follow-up items.

## SOC 2 Evidence Readiness

| Evidence item | Minimum acceptable proof | Status |
|---|---|---|
| MFA enabled screenshots | Dated screenshots or admin exports for GitHub, Vercel, Render, Supabase, Google Workspace, ShipStation, EasyPost, Stripe, and source store admin accounts. | Needed |
| GitHub branch protection screenshots/settings export | Protected branch rules, required checks, review requirements, and force-push restrictions. | Needed |
| backup restore test result | Dated restore exercise with data set, expected result, actual result, owner, and follow-up items. | Needed |
| secret rotation records | Last rotation date, owner, storage location, impacted services, and verification note. | Needed |
| access review | List of internal users, client users, vendor admins, stale accounts removed, and approver sign-off. | Needed |
| incident drill | Scenario, timeline, assigned roles, customer communication decision, and lessons learned. | Needed |
| vendor review | Security page/SOC report/DPA status for each vendor that touches customer, order, label, billing, or operational data. | Needed |
| privacy/redaction review | Proof that logs, reports, timing diagnostics, PDF URLs, and browser-visible errors do not expose sensitive data. | Needed |

## Vendor/security inventory template

| Vendor | PrepShip use | Data touched | Security evidence needed | Owner | Review cadence |
|---|---|---|---|---|---|
| GitHub | Source control and CI references | Code, issues, security history | Branch protection, MFA, access review, dependency review | Engineering | Quarterly |
| Vercel | Web hosting/deployment | App runtime, env vars, logs | Deployment access, env var controls, audit trail | Engineering/Ops | Quarterly |
| Render | API/worker hosting | API runtime, env vars, logs | Service access, deploy logs, env var controls, worker monitoring | Engineering/Ops | Quarterly |
| Supabase | Database/auth/storage integration | Customer/order/account data | Access controls, backup policy, restore test, audit logs | Engineering/Ops | Quarterly |
| ShipStation | Carrier/order/shipment orchestration | Shipment, label, order, carrier data | Account access, marketplace notification behavior, rate/label controls | Ops | Quarterly |
| EasyPost | Carrier rating/labels | Shipment and label data | Account access, API key rotation, label safety controls | Ops | Quarterly |
| Walmart | Marketplace/source store | Orders, buyer shipment status | Store access, confirmation audit trail, webhook security | Ops | Quarterly |
| eBay | Marketplace/source store | Orders, buyer shipment status | Store access, confirmation audit trail, API credentials | Ops | Quarterly |
| Shopify | Store connector/source store | Orders, fulfillment status | Store access, confirmation audit trail, webhook security | Ops | Quarterly |
| Stripe | Payments/billing | Billing and payment metadata | PCI boundary statement, access review, key rotation | Leadership/Ops | Quarterly |
| Sentry | Error monitoring | Error events and safe diagnostics | PII scrubbing settings, access review, retention | Engineering | Quarterly |
| Google Workspace | Email/docs/admin identity | Docs, email, users | MFA, admin access review, shared drive permissions | Leadership/Ops | Quarterly |
| Discord | Internal operations alerts/chat | Operational messages | Channel access review, no sensitive payload policy | Ops | Quarterly |
| Trello | Ticket/work tracking | Task details and screenshots | Board access review, no secrets/PII policy | Leadership/Ops | Quarterly |

## Gate Use

Run the security readiness gate before customer-facing security claims:

```bash
npm run test:security-readiness
```

The gate must pass locally and in build review before PS-066 is marked complete. A passing guard means the checklist artifact, package wiring, and existing technical security guards are present and runnable. It does not mean PrepShip has completed SOC 2 Type I or SOC 2 Type II.

Routine gate runs must not mutate production data, print labels, buy postage, send marketplace confirmations, or alter shipped/cancelled order history.
