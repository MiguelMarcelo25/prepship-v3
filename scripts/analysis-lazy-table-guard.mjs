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
  pkg.scripts?.['test:analysis-lazy-table'] === 'node scripts/analysis-lazy-table-guard.mjs',
  'package.json exposes test:analysis-lazy-table',
);

assert(
  analysis.includes("import { lazy, Suspense"),
  'AnalysisView imports lazy and Suspense from React',
);

assert(
  !analysis.includes("import { AnalysisDataTable } from './AnalysisDataTable'"),
  'AnalysisDataTable is not eagerly imported into AnalysisView',
);

assert(
  analysis.includes("const AnalysisDataTable = lazy(() => import('./AnalysisDataTable').then((module) => ({ default: module.AnalysisDataTable })))"),
  'AnalysisDataTable is split into an on-demand lazy chunk',
);

assert(
  analysis.includes('<Suspense fallback={') && analysis.includes('<AnalysisDataTable'),
  'AnalysisDataTable renders inside Suspense with a fallback',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
