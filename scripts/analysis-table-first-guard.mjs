import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const analysisPath = path.join(root, 'web/src/components/Views/AnalysisView.tsx');
const packagePath = path.join(root, 'package.json');

const analysis = fs.readFileSync(analysisPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function indexOfOrEnd(needle) {
  const index = analysis.indexOf(needle);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

assert(
  pkg.scripts?.['test:analysis-table-first'] === 'node scripts/analysis-table-first-guard.mjs',
  'package.json exposes test:analysis-table-first',
);

assert(
  analysis.includes("import { useQuery } from '@tanstack/react-query'") &&
    !analysis.includes('const [dataState, setDataState]') &&
    !analysis.includes('const loadAnalysis = async'),
  'Analysis GET lifecycle is owned by React Query, not the old orchestrator state',
);

assert(
  analysis.includes("queryFn: () => api.get<V4ClientFullRow[]>('/clients?activeOnly=true')") &&
    analysis.includes('queryFn: () => apiClient.fetchAnalysisSkus(analysisQuery)') &&
    analysis.includes('queryFn: () => apiClient.fetchAnalysisDailySales(analysisQuery)') &&
    analysis.includes('return apiClient.fetchInventorySkuOrders(skuDrawerRequest.invSkuId, {'),
  'all four Analysis GET call literals stay inline in per-endpoint queries',
);

const skuQueryBlock = analysis.slice(
  indexOfOrEnd('const analysisSkusQuery = useQuery'),
  indexOfOrEnd('const analysisSkusSettled = !analysisSkusQuery.isPending'),
);
assert(
  skuQueryBlock.length > 0 && !skuQueryBlock.includes('enabled:'),
  'Analysis SKU table query is ungated on the critical first-paint path',
);

assert(
  analysis.includes('const analysisSkusSettled = !analysisSkusQuery.isPending') &&
    analysis.includes('scheduleAnalysisNonCriticalWork(runNonCriticalAnalysisWork)') &&
    analysis.includes('enabled: dailySalesReady'),
  'Analysis chart query waits for table settlement and the browser-idle gate',
);

assert(
  analysis.includes('const analysisRows = analysisSkusQuery.data?.skus ?? EMPTY_ANALYSIS_ROWS') &&
    analysis.includes('const chartData = dailySalesQuery.data ?? null') &&
    analysis.includes('const skuDrawer = skuDrawerQuery.data ?? null'),
  'Analysis panels render query-owned endpoint data without duplicate response state',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
