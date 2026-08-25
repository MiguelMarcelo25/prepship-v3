# PS-497 Slice 1 (M1) — production APPLY runbook for `0104_ps497_fulfillment_occurrences`

**Status:** Hermes PASS 95% / GATED. This runbook is executed **only after DJ gives explicit written
authorization** naming the exact SHA + environment (Section 0). Nothing here re-enables inventory
deduction — that is Slice 2, separately gated, and needs a fresh `unlock shipped data`.

This applies an **additive, expand-only** migration: a new `fulfillment_occurrences` table + 3 indexes,
nullable projection columns on `order_lifecycle_events` / `fulfillment_line_claims`, two PARTIAL claim
uniqueness indexes built `CONCURRENTLY`, and two NOT-VALID→VALIDATE CHECKs. No writer/consumer changes;
no backfill; no order/shipment mutation.

---

## 0. Authorization + artifact identity (DJ fills this in)

```
Authorized by:      DJ __________________________   Date/time: __________
Environment:        production
Repository:         drprepperusa-org/prepship-v4
Reviewed SHA:       4a6f18966778b2bd81978dfd74945ed0cedbde00   (immutable; detached checkout)
Migration:          drizzle/0104_ps497_fulfillment_occurrences.sql
Migration digest:   bf8038d264d736785d7913b4443c2445ad93296f846d61f71ee106f1e85246d2  (LF-normalized SHA-256)
Runner:             scripts/apply-ps-497-fulfillment-occurrences.ts
Operator:           __________________________
Governance path:    APPLY reviewed SHA while prod schema is TEMPORARILY AHEAD of stable
                    (stable @ 3666cf66; M1 artifact integrated to stable later). DJ-approved.
```

This authorization does **not** cover: Slice 2, deduction re-enablement, locked-service changes,
writer/consumer cutover, Drizzle/readiness deployment, claim replay/drain/supersession, inventory
movement, order/shipment mutation, reverse-duplicate repair, or recovery of the ~4,057 historical claims.

---

## 1. Immutable checkout (detached at the exact SHA)

```bash
git fetch origin
git checkout --detach 4a6f18966778b2bd81978dfd74945ed0cedbde00
git rev-parse HEAD          # MUST print 4a6f18966778b2bd81978dfd74945ed0cedbde00
git status --porcelain      # MUST be empty (no local edits)
npm ci --ignore-scripts
```
Confirm the migration digest matches the pin before doing anything else:
```bash
node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('drizzle/0104_ps497_fulfillment_occurrences.sql','utf8').replace(/\r\n/g,'\n'),'utf8').digest('hex'))"
# MUST print: bf8038d264d736785d7913b4443c2445ad93296f846d61f71ee106f1e85246d2
```
Set `DATABASE_URL` to the production database (a session/transaction-capable connection). **Do not** paste
the connection string into any shared ticket — redact it in all evidence.

---

## 2. Read-only PREFLIGHT (no writes)

### 2a. Production identity + version
```sql
select current_setting('server_version_num') as server_version_num,
       current_database()                     as db,
       current_user                           as role,
       current_setting('search_path')         as search_path;
```
Record `server_version_num` (expect a PostgreSQL 17.x major; CI proved 170011). Confirm the DB/cluster is
the intended production target. **STOP** if the major is not 17.x or the target is wrong.

### 2b. Backup / PITR health
- Confirm automated backup / PITR is healthy and record the latest recovery point covering the apply window.
- Confirm the operator knows the forward-recovery procedure.
- A fresh full backup is not strictly required if verified PITR is healthy, but "we assume backups work"
  is **not** sufficient. **Rollback is forward-only** — never delete/rewrite claim rows to undo.

### 2c. Reverse-duplicate pre-audit — MUST return 0 rows
```sql
select original_claim_id, count(*)
from public.fulfillment_line_claims
where direction = 'reverse' and original_claim_id is not null
group by original_claim_id
having count(*) > 1;
```
**Required result: 0 rows.** If any rows return: **HOLD.** Do not delete/merge/renumber/supersede/rewrite
them under this authorization. Produce a read-only discrepancy packet, get separate DJ approval for a
governed forward-only correction, then repeat the preflight. (The runner also runs this pre-audit and
aborts on duplicates — this manual check is to decide the window before starting.)

### 2d. Confirm 0104 is not already present / not partially applied
```sql
select to_regclass('public.fulfillment_occurrences') as occ_table;   -- expect NULL on a fresh prod
```
If non-NULL, the dry-run (Section 3) will report the exact catalog state; **STOP** and investigate any
partially-applied or malformed object rather than proceeding.

---

## 3. DRY RUN (the exact audited runner, no `--apply`)

Start capturing stdout **and** stderr to a file now (Section 6), preserving the real exit code.
```bash
npm run migrate:ps-497-fulfillment-occurrences
```
Require, in the output:
- `migration digest verified: bf8038d264…`
- `session application_name=ps-497-migration-0104`
- `session timeouts lock_timeout=… statement_timeout=…` (bounded)
- `current={...}` catalog inspection (all false on a fresh prod)
- `reverse_duplicates=0`
- `claims=<N> by_status=<…>` snapshot
- `DRY RUN: pass --apply --confirm=…`
- **no mutation**, clean exit (code 0)

**STOP** if the dry run reports any unexpected partially-applied or malformed object, a digest mismatch,
or a wrong application_name. **Never** manually bypass an exact-catalog mismatch.

---

## 4. APPLY (in a quiet, low-write window)

Pick a low-traffic window. Confirm before running: no claim repair/replay/backlog-drain/manual claim
edits in progress; no long-running transaction holding relevant snapshots/locks; healthy disk/temp
headroom; replication lag within the approved threshold; an operator watching the whole run (the two
`CREATE INDEX CONCURRENTLY` builds run on the multi-million-row claim table).

```bash
npm run migrate:ps-497-fulfillment-occurrences -- --apply --confirm=apply-ps-497-fulfillment-occurrences-0104
```
Optional bounded-timeout overrides (defaults: lock 5s / txn stmt 60s / concurrent stmt 1h; all validated):
`PS497_LOCK_TIMEOUT`, `PS497_TXN_STATEMENT_TIMEOUT`, `PS497_CONCURRENT_STATEMENT_TIMEOUT` (e.g. `10s`, `5min`, `2h`).

Require in the output:
- `applied={"occurrences_table":true,"columns_ok":true,"indexes_ok":true,"checks_ok":true,"pk_ok":true,"seq_ok":true,"fks_ok":true}`
- `preexisting_claims_unchanged=true preexisting_rows=<N> total_rows=<M>`
- `exact_catalog_verified=true quantity_state_check_intact=true`
- `orders_shipments_untouched=true no_backfill_performed=true`
- clean exit (code 0)

**Conservative-red handling:** if it fails with *"a pre-existing claim … was mutated or removed during
the apply,"* that means a concurrent writer changed a pre-apply claim — **not** schema corruption. The
schema DDL still applied. Do **not** auto-repair the claim. Preserve the transcript, inspect the
concurrent writer + catalog, and **re-run the runner in a quiet window** (a re-run reports
`already_applied=true` once the schema is in place).

---

## 5. Post-apply READBACK (all must be green to call M1 operationally complete)

Run these from an independent read-only session. (The runner already verified all of this during apply;
this is the independent confirmation.)

```sql
-- (1) table exists in public
select to_regclass('public.fulfillment_occurrences') is not null as occ_table;

-- (2)(3) columns: exact type / nullability / default (id must be the canonical sequence default)
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public'
  and ( (table_name='order_lifecycle_events' and column_name='occurrence_id')
     or (table_name='fulfillment_line_claims' and column_name in ('occurrence_id','canonical_line_identity','supply'))
     or (table_name='fulfillment_occurrences') )
order by 1,2;
--   fulfillment_occurrences.id default MUST be nextval('fulfillment_occurrences_id_seq'::regclass)
--   created_at/updated_at default MUST be now(); order_id/occurrence_key/discriminator_kind/first_seen_source/effective_at NOT NULL

-- (4) sequence ownership
select pg_get_serial_sequence('public.fulfillment_occurrences','id') as owned_seq;   -- expect public.fulfillment_occurrences_id_seq

-- (5) PK on the owning table
select conname, pg_get_constraintdef(oid) as def
from pg_constraint where conrelid='public.fulfillment_occurrences'::regclass and contype='p';   -- fulfillment_occurrences_pkey = PRIMARY KEY (id)

-- (6) five indexes: exact def + valid
select c.relname, pg_get_indexdef(i.indexrelid) as def, i.indisvalid
from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
 ('fulfillment_occurrences_key_unq','fulfillment_occurrences_order_idx','fulfillment_occurrences_shipment_unq',
  'fulfillment_line_claims_occ_line_dir_unq','fulfillment_line_claims_reverse_original_unq')
order by 1;   -- all indisvalid=true

-- (7) CHECKs (new + preserved 0090): exact def + validated
select conname, pg_get_constraintdef(oid) as def, convalidated
from pg_constraint
where conrelid in ('public.fulfillment_line_claims'::regclass,'public.fulfillment_occurrences'::regclass)
  and conname in ('fulfillment_line_claims_supply_chk','fulfillment_line_claims_occ_identity_present_chk',
                  'fulfillment_occurrences_kind_chk','fulfillment_line_claims_quantity_state_check')
order by 1;   -- all convalidated=true

-- (8) four FKs: source/ref schema+table+col, actions, match, key len, validated
select r.relname tbl, a.attname col, ns.nspname refschema, cr.relname ref, ca.attname refcol,
       con.confupdtype upd, con.confdeltype del, con.confmatchtype mt, array_length(con.conkey,1) keylen, con.convalidated validated
from pg_constraint con
join pg_class r on r.oid=con.conrelid join pg_namespace n on n.oid=r.relnamespace
join pg_class cr on cr.oid=con.confrelid join pg_namespace ns on ns.oid=cr.relnamespace
join pg_attribute a on a.attrelid=con.conrelid and a.attnum=con.conkey[1]
join pg_attribute ca on ca.attrelid=con.confrelid and ca.attnum=con.confkey[1]
where con.contype='f' and n.nspname='public'
  and ( (r.relname='order_lifecycle_events' and a.attname='occurrence_id')
     or (r.relname='fulfillment_line_claims' and a.attname='occurrence_id')
     or (r.relname='fulfillment_occurrences' and a.attname in ('order_id','superseded_by_occurrence_id')) )
order by 1,2;   -- all: refschema=public, upd='a', del='a', mt='s', keylen=1, validated=true

-- (13) no leaked runner session
select count(*) from pg_stat_activity where application_name='ps-497-migration-0104';   -- expect 0
```
Also confirm from the runner's own apply output: **(9)** the frozen pre-existing claim checksum/count is
unchanged (`preexisting_claims_unchanged=true`), **(10)** total claim count did not decrease, **(11)** no
backfill (`no_backfill_performed=true`), **(12)** orders/shipments untouched (`orders_shipments_untouched=true`),
and **(14)** the retained transcript's command exited 0.

Only when **all** of the above are green → **Operational status: COMPLETE** for M1.

---

## 6. Evidence capture (start BEFORE the dry run)

Capture with both streams + the real exit code, e.g.:
```bash
( npm run migrate:ps-497-fulfillment-occurrences 2>&1; echo "EXIT=${PIPESTATUS[0]}" ) | tee ps497-0104-dryrun.log
( npm run migrate:ps-497-fulfillment-occurrences -- --apply --confirm=apply-ps-497-fulfillment-occurrences-0104 2>&1; echo "EXIT=${PIPESTATUS[0]}" ) | tee ps497-0104-apply.log
```
Retain: exact command boundaries · operator + authorizer · nonsecret run id · start/end timestamps ·
exact SHA + digest · dry-run output · apply output · catalog readback · protected-row readback ·
post-exit session check · artifact checksums. **Redact** credentials/connection strings/hosts/roles
(`[REDACTED]`).

---

## 7. STOP conditions (halt without improvising if ANY occur)

digest mismatch · wrong SHA / moving checkout · prod identity or version mismatch · reverse duplicates ·
catalog mismatch · unexpected existing `0104` objects · backup/PITR uncertainty · unhealthy replication or
low disk · lock/statement timeout · an invalid index that does not recover cleanly on re-run ·
protected-row checksum drift · a leaked runner session · transcript capture failure.

---

## 8. After a green readback (developer follow-on — NOT part of this apply)
The separately-audited **post-apply commit** is authored + deployed next: `fulfillment-occurrences.ts`
Drizzle object + `order-lifecycle.ts` column mapping/indexes + `runtime-schema-readiness.ts` enrollment.
It must **not** reach a production deployment path until this `0104` readback is green (otherwise the
readiness gate fails the boot before the columns exist, and Drizzle mappings 500 select-all paths). Then
Slice 2 (behavioral cutover) begins under a **fresh `unlock shipped data`**; historical recovery is last.
