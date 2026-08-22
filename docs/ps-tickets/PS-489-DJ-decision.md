# PS-489 — one decision needed from DJ

**The question:** when an order ships outside PrepShip, how should PrepShip record it?

Nothing can be built until this is answered. Everything else on PS-489 is already done.

---

## Why it matters right now

**5,678 order lines currently bill $0 for shipping.** They split into two different problems.
Only the first is PS-489:

| | PS-489 (externally shipped) | Different, uncharacterized |
|---|---:|---:|
| Lines billing $0 shipping | **3,493** | **2,185** |
| …of those, with no shipment record | 3,477 | 2,178 |
| Manual overrides papering over it | **$5,206.33** / 124 rows | $1,565.33 / 170 rows |

Other PS-489 figures: 3,709 externally-shipped orders have no shipment record at all (150 of
them international); 232 of those have not been billed yet, so the 3,493 will grow when they are.

**Billing rows already invoiced: 0.** This is the important one. Nothing has been invoiced,
so this is still a clean regeneration. Once an invoice is finalized, correcting it becomes an
adjustment against frozen history. The window is open now and will not stay open.

### About the second column

Those 2,185 lines are **not** part of this decision and must not be used to justify it. What is
measured: 2,142 are orders marked `shipped` that are *not* flagged as externally shipped, and 43
are cancelled; 2,178 have no shipment record. What is **not** established is why. They could be
the same root cause with the external flag never set, or something else entirely. Nobody has
looked. Deciding PS-489 does not fix them, and they need their own investigation.

## What is already fixed (no decision needed)

1. An "awkward parcel" flag was being read as "someone else shipped this." Corrected — measured
   across all 73,541 orders, nothing reclassifies.
2. Shipping cost from the provider was being deleted on save. Now kept, so every new order carries
   the evidence needed to bill it. Old orders cannot be recovered — that data is gone.
3. The root cause is proven: orders already shipped when PrepShip first sees them are created with
   no shipment record, and nothing ever creates one afterwards. Billing then finds no cost and
   writes the $0 exception line.

Executable contract at commit `3c6591d3`: **7 terms satisfied, 1 still red.** The red one is the
decision below. Two of the seven are still text-matching checks rather than executed behaviour,
and are marked as such in the file — they must be converted when the fix lands.

## The choice

### Option A — give these orders a real shipment record *(recommended)*

This is what the ticket's own acceptance criteria and DJ's 2026-08-11 ruling already say.

- **How it works:** an externally fulfilled order gets a canonical shipment/lifecycle record, and
  the provider's cost attaches to that record.
- **Why it fits:** shipping is already recorded per shipment everywhere else — purchases, voids,
  service class, and the Analysis reporting corrected this week. An order-level cost would be a
  second, different way of recording the same fact.
- **Cost of choosing it:** it adds a new writer to the shipments table, which has protections
  around it, and it interacts with two recent pieces of work (PS-508/PS-509) that deliberately
  exclude these orders today. Those need reconciling — real work, but understood work.

### Option B — record the cost against the order instead

- **How it works:** no shipment record. A separate record holds the cost and feeds the same
  backend that owns customer shipping money.
- **What it costs:** the ticket's acceptance criteria AC-2 and AC-3, and the 2026-08-11 ruling,
  would have to be formally withdrawn. It also creates a second definition of shipping money
  sitting beside the per-shipment one — the exact problem behind a bug fixed this week, where one
  screen showed $25.00 and another showed $5.00 for the same order.

## What stays true either way

- **An unknown shipping cost is never silently billed as $0.** It keeps showing as a visible
  exception until someone resolves it. That rule does not change.
- **No back-filling of history.** Orders ingested before the retention fix have no recoverable
  cost evidence — measured: 0 of 143 shipment-less international orders retain either cost field.
  Nothing will be invented for them.
- Customer shipping money stays owned by one backend service. Billing consumes it; it never
  decides it.

## Recommendation

**Option A.** It keeps one definition of shipping money, matches how every other surface already
works, and requires withdrawing nothing that was previously decided. Option B is only right if the
intention is to deliberately supersede AC-2/AC-3 — which is DJ's call to make explicitly, not
something to arrive at by accident.

## Deliberately NOT being asked here

- **The 939 inventory claims** (PS-497) are separate and **not** ready for a decision. They were
  previously described as safe to close; that is **withdrawn** — measurement showed none had been
  processed.
- **The 2026-07-22 +$1,000 inventory adjustment** is an evidence lookup, not an architecture
  decision, and does not block this one.
- **The 2,185 non-PS-489 zero-shipping lines** described above. Separate investigation.

---

*Every figure is from read-only production queries at 2026-08-22, against `prepshipv4-stable`
commit `3c6591d3`. Population SQL is in `scripts/ps-489-external-fulfillment-preview.ts` and
`docs/ps-tickets/PS-497-recovery-manifest.md`; the two-population split above was measured
separately and its SQL is reproduced in this ticket's PR. No postage, labels, or purchases of any
kind were involved.*
