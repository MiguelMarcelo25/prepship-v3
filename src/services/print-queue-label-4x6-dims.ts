// PS-287 (display/PDF-rendering only): the standard 4×6 label dimensions @72dpi
// (the Print Queue print-canvas target) and its aspect, in ONE leaf module with
// no imports so the artwork helpers can share them without a circular import.
//
// Pure constants — no pdf-lib, no DB, no carrier IO, no label bytes, no postage,
// no shipped/cancelled order or shipment data is touched.

export const LABEL_4X6_W = 288;
export const LABEL_4X6_H = 432;
export const LABEL_4X6_ASPECT = LABEL_4X6_W / LABEL_4X6_H; // 2:3
