type InvoiceXlsxAlignment = {
  horizontal: 'left';
  vertical: 'top';
  wrapText: false;
};

type InvoiceXlsxCell = {
  value?: unknown;
  alignment?: unknown;
};

type InvoiceXlsxRow = {
  height?: number;
  alignment?: unknown;
  eachCell?: (
    options: { includeEmpty?: boolean },
    callback: (cell: InvoiceXlsxCell, colNumber?: number) => void,
  ) => void;
};

type InvoiceXlsxColumn = {
  key?: string | number;
  header?: unknown;
  width?: number;
  alignment?: unknown;
  eachCell?: (
    options: { includeEmpty?: boolean },
    callback: (cell: InvoiceXlsxCell, rowNumber?: number) => void,
  ) => void;
};

export type InvoiceXlsxWorksheet = {
  columns?: unknown;
  eachRow?: unknown;
};

export const INVOICE_XLSX_LEFT_ALIGNMENT: InvoiceXlsxAlignment = {
  horizontal: 'left',
  vertical: 'top',
  wrapText: false,
};

const DEFAULT_COLUMN_BOUNDS = { min: 10, max: 42 };

export const INVOICE_XLSX_COLUMN_WIDTH_BOUNDS: Record<string, { min: number; max: number }> = {
  shipDate: { min: 12, max: 16 },
  orderNumber: { min: 12, max: 24 },
  skus: { min: 28, max: 80 },
  boxSize: { min: 18, max: 34 },
  boxCost: { min: 10, max: 14 },
  qty: { min: 8, max: 10 },
  pickPackFee: { min: 16, max: 20 },
  additional: { min: 16, max: 20 },
  shipping: { min: 12, max: 16 },
  storage: { min: 12, max: 16 },
  total: { min: 12, max: 16 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function invoiceXlsxCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  if (typeof record.text === 'string') return record.text;
  if (record.result !== undefined) return invoiceXlsxCellText(record.result);
  if (typeof record.formula === 'string') return `=${record.formula}`;
  if (typeof record.hyperlink === 'string') return String(record.text ?? record.hyperlink);
  return '';
}

export function invoiceXlsxCellDisplayLines(value: unknown): string[] {
  const text = invoiceXlsxCellText(value);
  return text.length ? text.split(/\r\n|\r|\n/) : [''];
}

export function invoiceXlsxCellDisplayWidth(value: unknown): number {
  return Math.max(...invoiceXlsxCellDisplayLines(value).map((line) => line.length), 0);
}

export function applyInvoiceXlsxReadableLayout(worksheet: InvoiceXlsxWorksheet): void {
  const columns = Array.isArray(worksheet.columns) ? (worksheet.columns as InvoiceXlsxColumn[]) : [];
  const eachRow =
    typeof worksheet.eachRow === 'function'
      ? (worksheet.eachRow as (
          options: { includeEmpty?: boolean },
          callback: (row: InvoiceXlsxRow, rowNumber?: number) => void,
        ) => void)
      : null;

  columns.forEach((column) => {
    const key = String(column.key ?? '');
    const bounds = INVOICE_XLSX_COLUMN_WIDTH_BOUNDS[key] ?? DEFAULT_COLUMN_BOUNDS;
    let displayWidth = invoiceXlsxCellDisplayWidth(column.header);

    column.alignment = INVOICE_XLSX_LEFT_ALIGNMENT;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      cell.alignment = INVOICE_XLSX_LEFT_ALIGNMENT;
      displayWidth = Math.max(displayWidth, invoiceXlsxCellDisplayWidth(cell.value));
    });

    column.width = clamp(displayWidth + 2, bounds.min, bounds.max);
  });

  eachRow?.({ includeEmpty: false }, (row) => {
    let maxLineCount = 1;
    row.alignment = INVOICE_XLSX_LEFT_ALIGNMENT;
    row.eachCell?.({ includeEmpty: true }, (cell, colNumber) => {
      cell.alignment = INVOICE_XLSX_LEFT_ALIGNMENT;
      const columnWidth = colNumber ? Number(columns[colNumber - 1]?.width ?? DEFAULT_COLUMN_BOUNDS.min) : DEFAULT_COLUMN_BOUNDS.min;
      const lines = invoiceXlsxCellDisplayLines(cell.value);
      for (const line of lines) {
        maxLineCount = Math.max(maxLineCount, Math.ceil(line.length / Math.max(1, columnWidth - 1)));
      }
      maxLineCount = Math.max(maxLineCount, lines.length);
    });
    if (maxLineCount > 1) {
      row.height = Math.min(120, Math.max(row.height ?? 15, maxLineCount * 15 + 3));
    }
  });
}
