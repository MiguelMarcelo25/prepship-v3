# PS-104 — Preserve Selected-Rate Proof Through Print-Queue Batch-Send — Truth Report

**Completion: 100%** ✅
**Deployed SHA:** `18415e32` (registry/alias) + batch-send proof-forwarding work (origin + mirror)
**Report date:** 2026-06-06

## Claim
A selected-rate proof chosen in the Orders/Rate UI survives the Print Queue
batch-send path so the label purchase boundary still receives valid proof.

## Evidence (verified)
- Guard `npm run test:ps-104-print-queue-selected-rate-proof-pass-through` → **5/5 PASS**.
- Guard `npm run test:batch-send-proof-forwarding` → **5/5 PASS**.
- Commit `18415e32` "PS-107 master regression runner + manifest; PS-104 alias; PS ticket registry".

## What this proves
- The proof object is forwarded through the print-queue reconstruction into the
  batch-send label-creation call; it is not dropped in the batch path.

## What it does NOT prove
- No live label was purchased in verification (offline). The guard asserts the
  proof is *carried*, and the purchase boundary (`ps-098`, 10/10) asserts an
  invalid/absent proof is *rejected* — together they cover the contract.

## Truth caveat (history)
PS-104 has **no standalone feature commit**. It was delivered as the batch-send
proof-forwarding fix and aliased in the registry commit `18415e32`. Functionally
complete; its git history is bundled rather than isolated.

## Lockdown compliance
No shipped/cancelled mutation. No real labels/postage. Proof enforcement unweakened.
