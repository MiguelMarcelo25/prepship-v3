// PS-317: the "Export CSV" action, pulled out of OrdersView. Asks the backend for the export blob
// (scoped to the current tab + date range) and downloads it. Backend owns the export query.
import { useState } from 'react';
import { apiClient } from '../../../api/client';
import { californiaDateInputValue } from '../../../lib/ca-time';

export function useCsvExport(deps: {
  currentStatus: string;
  dateRange: { start?: string | null; end?: string | null };
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [csvExporting, setCsvExporting] = useState(false);

  async function handleExportCsv() {
    if (csvExporting) return;
    setCsvExporting(true);
    try {
      const { blob, filename } = await apiClient.downloadOrdersExport({
        orderStatus: deps.currentStatus,
        pageSize: 5000,
        dateFrom: deps.dateRange.start || undefined,
        dateTo: deps.dateRange.end || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `orders-${deps.currentStatus}-${californiaDateInputValue()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      deps.showToast('CSV export downloaded', 'success');
    } catch (err) {
      console.error('[Export CSV] failed', err);
      deps.showToast('Export failed: ' + (err instanceof Error ? err.message : 'unknown error'), 'error');
    } finally {
      setCsvExporting(false);
    }
  }

  return { csvExporting, handleExportCsv };
}
