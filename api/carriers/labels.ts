// @ts-nocheck
// PS-209 (first safe slice, 2026-06-13): DEPRECATED — RETIRED AS A PURCHASE PATH.
//
// This Vercel function was the pre-PS-202 direct-carrier label purchase owner
// (its own JWT verify, connector calls, shipment persistence, deduction and
// outbox kick — a complete SECOND owner next to v4 createLabelV2). PS-202
// moved every frontend/job purchase to v4 POST /labels, but vercel.json's
// rewrite exclusions kept THIS module reachable in production: any stale tab
// or script could still buy postage through a parallel pipeline.
//
// It is now a no-import 410 so no purchase capability exists in this module
// at all (the audit is docs/engineering/ps-209-shipping-architecture-audit.md).
// v4 POST /labels (src/services/labels.ts createLabelV2) is the ONLY label
// purchase owner — selected-rate proof, PS-204 account binding, PS-186 test
// authority, shared persistence/deduction/confirmation tail.
//
// Full deletion of the api/ tree remains PS-200 S5/S8, gated on DJ's live
// order test. Guard: test:ps-209-label-owner-slice.

export default async function handler(req: any, res: any) {
  res.setHeader('Allow', 'POST');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    ok: false,
    code: 'LEGACY_LABEL_ENDPOINT_RETIRED',
    error:
      'This legacy label endpoint is retired and cannot purchase postage. ' +
      'Refresh PrepShip — label purchases go through the v4 /labels API.',
  });
}
