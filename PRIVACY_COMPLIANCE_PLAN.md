# PrepShip Privacy And Compliance Plan

## Executive Summary

This Phase 12 deliverable defines PrepShip's privacy and compliance checklist for customer/order data, label artifacts, credentials, logs, and vendor access. The goal is to make PII handling explicit before enterprise signoff, without changing runtime behavior in this batch.

This is a planning/control batch only. It does not change database data, API behavior, label flows, shipped/cancelled logic, or access permissions.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| PII inventory is not formalized | Customer names, addresses, phone numbers, emails, order IDs, and label PDFs may be handled inconsistently | Documented PII inventory with location, access, retention, and masking policy | PII inventory review signoff |
| Label PDFs and exports need retention policy | PII-bearing artifacts can be kept longer or exposed more broadly than intended | Artifact access and retention rules | Artifact access/retention smoke test |
| Access logs and provider logs may contain sensitive data | Debugging can accidentally leak PII or credentials | Log redaction and retention policy | Log sample review |
| Vendor/support access is not fully documented | Third-party or support access may be broader than needed | Vendor access list and least-privilege policy | Access review checklist |

## High-Risk Issues

| Area | Current State | Risk If Unchanged | Required Fix |
|---|---|---|---|
| Customer addresses | Required for orders, labels, and manifests | Address data can leak through logs, exports, screenshots, or overly broad roles | Field-level policy and log masking |
| Label PDFs | Signed mock URLs exist; production labels are PII-bearing | Label access may not have retention/access audit policy | Label artifact policy and audit events |
| Credentials | Secret redaction and governance are started | Tokens/keys can leak through logs or overbroad access | Credential redaction, rotation, and access review |
| Billing exports | Billing data includes client financial details | Unauthorized users can see margins/costs/invoices | Billing field-level and export policy |
| Support access | Support/read-only role is scoped but not fully enforced everywhere | Support could see or mutate sensitive records | RBAC/client-scope completion and audit logs |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Screenshots | Support screenshots can include PII | Add support screenshot redaction guidance |
| Data deletion/export | Client data export/delete requests need a process | Add data subject/client request runbook |
| Retention | Order/label/invoice retention needs business approval | Define retention schedule by data class |
| Least privilege | Platform/admin access needs periodic review | Add quarterly access review checklist |
| Incident response | Privacy incident handling needs owner and evidence handling | Link to suspicious-access/security runbook |

## Data Class Matrix

| Data Class | Examples | Storage / Surface | Who Can Access | Retention / Deletion Need | Required Control | Test |
|---|---|---|---|---|---|---|
| Customer PII | name, address, phone, email | orders, labels, manifests, exports, UI | scoped operational roles only | retention schedule and export/delete process | client/store scope, field masking, audit logs | client user cannot see other client PII |
| Order identifiers | order number, external id, marketplace id | orders, dashboard, analysis, exports | scoped operational roles | business retention policy | scope filtering and safe exports | scoped query excludes other clients |
| Label artifacts | label PDFs, mock signed URLs, tracking labels | provider URLs, print queue, downloads | authorized warehouse/operator roles | retention and signed URL expiry | signed/expiring URLs and access audit | expired URL cannot be reused |
| Billing data | invoices, line items, margins, package costs | billing APIs, exports, UI | admin/operator/accounting roles | invoice retention policy | field-level role policy and export audit | warehouse/client denied margins |
| Credentials/secrets | ShipStation, carrier, store, OAuth, Supabase | env, clients, credential tables | backend services and credential admins | rotation and revocation policy | redaction, audit, last-used tracking | API response has no secrets |
| Logs/telemetry | request logs, provider errors, frontend errors | Render, Vercel, Supabase, observability tools | platform/admin owners | log retention schedule | no secrets/full addresses/tokens in logs | log sample scan |
| User/admin metadata | emails, roles, permissions, sessions | Supabase auth, users APIs, audit logs | admin/user-management roles | account deletion/disable policy | RBAC and audit events | non-admin denied user list |
| Generated reports | reconciliation CSVs, billing exports, analysis exports | downloads, storage, browser | role/client-scoped users | export expiration and audit | signed export URLs and owner scoping | export access requires scope |

## Recommended Patches

- [ ] Create a formal PII inventory from the Data Class Matrix.
- [ ] Define retention and deletion policy for orders, labels, exports, logs, billing outputs, and reconciliation reports.
- [ ] Add field-level policy for costs, margins, credentials, and label artifacts.
- [ ] Add log redaction checklist for tokens, credentials, full addresses, provider payloads, and label URLs.
- [ ] Add support screenshot/redaction guidance.
- [ ] Add quarterly access review checklist for GitHub, Vercel, Render, Supabase, ShipStation, and carrier accounts.
- [ ] Link privacy incident response to the suspicious-access/security runbook.

## Test Plan

- `npm run test:privacy-compliance`
- Future implementation tests:
  - scoped user cannot access another client's PII
  - warehouse/client user cannot see billing margins/costs
  - API responses do not contain raw credential fields
  - exported report access is signed, scoped, and expiring
  - log sample scan finds no raw tokens or full provider credential payloads

## Deployment / Rollback Notes

- This matrix is planning-only and safe to deploy with documentation and guard changes.
- Runtime privacy controls should be additive and tested by role/scope.
- Field-level redaction should be staged carefully so operational workflows still show required data to authorized roles.
- Retention/deletion policies require business approval before automation deletes data.
- Rollback should restore prior access behavior only if a privacy control blocks authorized operational work.

## Recommended Implementation Order

1. Review this matrix with DJ/OpenClaw and approve data-class owners.
2. Approve retention/deletion policy by data class.
3. Add log redaction and export-access checks.
4. Add field-level cost/margin/label artifact policy.
5. Add quarterly access review checklist.
6. Add privacy incident response steps to the suspicious-access runbook.
