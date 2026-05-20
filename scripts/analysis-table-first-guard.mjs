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

assert(
  pkg.scripts?.['test:analysis-table-first'] === 'node scripts/analysis-table-first-guard.mjs',
  'package.json exposes test:analysis-table-first',
);

assert(
  !analysis.includes('const [skuData, chartData] = await Promise.all'),
  'Analysis table request does not wait on chart Promise.all',
);

assert(
  analysis.includes('const skuData = await apiClient.fetchAnalysisSkus(query)'),
  'Analysis loads SKU table data first',
);

assert(
  analysis.includes('setDataState({') &&
    analysis.includes('rows: skuData.skus || []') &&
    analysis.includes('chartData: null'),
  'Analysis paints table rows before chart data is available',
);

assert(
  analysis.includes('void apiClient.fetchAnalysisDailySales(query)') &&
    analysis.includes('setDataState((current) => ({') &&
    analysis.includes('...current,') &&
    analysis.includes('chartData,'),
  'Analysis chart request hydrates chart data after table paint',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
