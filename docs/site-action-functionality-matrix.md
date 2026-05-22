# Site Action Functionality Matrix

All money-moving, marketplace, billing, destructive, shipped/cancelled, and live-order actions are mocked or sandboxed in automated tests. No real postage or live marketplace notification is allowed from this matrix.

| Page/view | Button/action label | Selector/test id | User role/recipient | Intended user outcome | Backend/API dependency | Expected success state | Expected error state | Loading required | Risk level | Test mode | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Orders | Print Label | role button `Print Label` | operator | create label and open PDF | `/labels` | popup resolves and row refreshes | clear toast/popup error | yes | money-moving | Playwright mocked | covered |
| Orders | Reprint Label | role button `Reprint Label` | operator | open existing label PDF | `/labels/:id/pdf` or label URL | PDF open attempted | popup explains failure | yes | external side effect | Playwright mocked | covered |
| Orders | Send to Queue | role button `Send to Queue` | operator | add eligible order to print queue | `/print-queue` | queue count updates | visible error | yes | money-moving | Playwright mocked | covered |
| Orders | batch print | selection toolbar | operator | print selected eligible labels | `/labels/batch` / `/print-queue` | selected labels processed | ineligible rows refused | yes | money-moving | Playwright mocked | covered |
| Orders | order detail drawer actions | order row/drawer buttons | operator | inspect and act on selected order | `/orders/:id` | drawer opens with actions | detail error shown | yes | mixed | Playwright mocked | covered |
| Print Queue | Print Queue | queue panel print button | operator | print queued entries | `/print-queue/merge` | merged PDF opened | entry-level errors shown | yes | money-moving | Playwright mocked | covered |
| Inventory | inventory receive/restock | receive/restock buttons | operator | open stock movement dialog and save fixture change | `/inventory` | mocked row updates | validation or API error | yes | safe local mutation | Playwright mocked | covered |
| Packages | package add/edit | add/edit package buttons | operator | open package form and validate/save fixture | `/packages` | mocked package row updates | validation or API error | yes | safe local mutation | Playwright mocked | covered |
| Clients | client selection/filter | client filter controls | operator/admin | narrow visible client data | `/clients` | scoped data changes | scope error visible | yes | read-only | Playwright mocked | covered |
| Billing | invoice view/download | billing buttons if present | admin | view/download mocked invoice | `/billing` | mocked document action | financial error visible | yes | external side effect | mocked/manual | partial |
| Settings | carrier verify | verify/test connection | admin | validate saved integration without exposing secrets | `/api/carriers/verify` | safe success message | redacted error | yes | external side effect | mocked | partial |
| Auth | logout | logout button | any authenticated user | end session | Supabase/auth client | logged-out state | auth error visible | yes | safe local mutation | Playwright mocked | covered |
| Maintenance | error-state action | retry/refresh controls | any user | recover from maintenance/error page | app shell | retry visible | actionable error | yes | read-only | Playwright mocked | covered |
