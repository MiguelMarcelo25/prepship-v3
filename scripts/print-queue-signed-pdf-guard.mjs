import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[PS-065 guard] ${message}`);
    process.exit(1);
  }
}

const routeSource = read('src/routes/print-queue.ts');
const authSource = read('src/middleware/auth.ts');
const apiClientSource = read('web/src/lib/v2-apiClient.ts');
const ordersViewSource = read('web/src/components/Views/OrdersView.tsx');
const packageJson = JSON.parse(read('package.json'));

assert(
  routeSource.includes('createHmac') &&
    routeSource.includes('signPrintQueuePdfToken') &&
    routeSource.includes('verifyPrintQueuePdfToken'),
  'print queue route signs and verifies short-lived PDF tokens',
);
assert(
  routeSource.indexOf("app.get('/print/view/:jobId'") < routeSource.indexOf("app.use('*', requireInternalPermission('print_queue:write'))"),
  'signed PDF view route is registered before internal auth middleware so Chrome can open it',
);
assert(
  authSource.includes("'/print-queue/print/view/'") &&
    authSource.includes('Signed Print Queue PDF'),
  'global auth middleware bypasses only the signed Print Queue PDF view route',
);
assert(
  routeSource.includes("app.get('/print/signed-url/:jobId'") &&
    routeSource.includes("canViewMergeJob(job, scope)") &&
    routeSource.includes('expires_at'),
  'authenticated route mints signed PDF URLs only after job visibility is checked',
);
assert(
  routeSource.includes("content-type': 'application/pdf'") &&
    routeSource.includes('content-disposition') &&
    routeSource.includes('attachment') &&
    routeSource.includes('inline') &&
    routeSource.includes('content-length') &&
    routeSource.includes('cache-control') &&
    routeSource.includes('private, max-age=') &&
    routeSource.includes('SIGNED_PDF_CACHE_SECONDS'),
  'signed PDF responses include PDF type, disposition, length, and private cache headers',
);
assert(
  routeSource.includes('sanitizePdfFilename') &&
    routeSource.includes("endsWith('.pdf')") &&
    routeSource.includes('isUuidOnlyFilename'),
  'PDF filenames are sanitized, .pdf suffixed, and not UUID-only',
);
assert(
  routeSource.includes('PDF_LINK_EXPIRED') &&
    routeSource.includes('PDF_LINK_INVALID'),
  'expired and invalid signed PDF tokens return clear error codes',
);

assert(
  apiClientSource.includes('fetchQueuePrintJobSignedUrl') &&
    apiClientSource.includes('/print-queue/print/signed-url/') &&
    apiClientSource.includes('openQueuePrintJobPdf') &&
    apiClientSource.includes("'inline' | 'attachment'") &&
    apiClientSource.includes("options?.disposition ?? 'inline'") &&
    // openQueuePrintJobPdf calls fetchQueuePrintJobSignedUrl(jobId, <disposition>).
    // The call was reshaped to multiline, so match across line breaks while still
    // pinning jobId as the first arg and the inline-default disposition.
    /fetchQueuePrintJobSignedUrl\(\s*jobId,\s*options\?\.disposition \?\? 'inline'\s*\)/.test(apiClientSource),
  'frontend API client supports signed inline and attachment PDF URLs',
);
assert(
  !/fetchQueuePrintJobPdfUrl[\s\S]{0,500}URL\.revokeObjectURL\(url\), 30_000\)/m.test(apiClientSource),
  'print queue PDF viewer flow no longer depends on a 30-second blob URL revoke',
);
assert(
  ordersViewSource.includes('openQueuePrintJobPdf(job.job_id') &&
    !ordersViewSource.includes('fetchQueuePrintJobPdfUrl(job.job_id)'),
  'Orders view opens print queue PDFs through the stable signed URL helper',
);
assert(
  packageJson.scripts?.['test:print-queue-signed-pdf'] ===
    'node scripts/print-queue-signed-pdf-guard.mjs',
  'package exposes PS-065 signed PDF guard',
);

console.log('PS-065 signed PDF guard passed');
