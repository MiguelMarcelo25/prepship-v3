import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const serve = args.has('--serve');
const json = args.has('--json');
const runsArg = process.argv.find((arg) => arg.startsWith('--runs='));
const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const runs = Math.max(1, Number.parseInt(runsArg?.split('=')[1] ?? '5', 10) || 5);
const url = urlArg?.slice('--url='.length) || 'http://127.0.0.1:4173/';
const reportDir = path.join(root, 'reports');
const reportPath = path.join(reportDir, 'web-performance-current.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUrl(targetUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(targetUrl, { cache: 'no-store' });
      if (res.ok) return;
    } catch {
      // Keep waiting for the preview server.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${targetUrl}`);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Math.round(value);
}

async function measureOnce(browser, targetUrl) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 768 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__prepshipPerf = { fcp: null, lcp: null, cls: 0 };
    try {
      new PerformanceObserver((entryList) => {
        const first = entryList.getEntries()[0];
        if (first) window.__prepshipPerf.fcp = first.startTime;
      }).observe({ type: 'paint', buffered: true });
      new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        const last = entries[entries.length - 1];
        if (last) window.__prepshipPerf.lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (!entry.hadRecentInput) window.__prepshipPerf.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Older browser builds may not support every observer type.
    }
  });

  const response = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  assert(response?.ok(), `Navigation failed: HTTP ${response?.status() ?? 'unknown'}`);
  await page.waitForSelector('#root', { timeout: 15_000 });
  await page.waitForTimeout(1_000);

  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const scripts = resources.filter((entry) => entry.initiatorType === 'script');
    const stylesheets = resources.filter((entry) => entry.initiatorType === 'link' || entry.name.endsWith('.css'));
    const transferBytes = resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0);
    const encodedBytes = resources.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0);
    return {
      title: document.title,
      domContentLoadedMs: nav.domContentLoadedEventEnd,
      loadEventMs: nav.loadEventEnd,
      responseEndMs: nav.responseEnd,
      fcpMs: window.__prepshipPerf?.fcp ?? null,
      lcpMs: window.__prepshipPerf?.lcp ?? null,
      cls: window.__prepshipPerf?.cls ?? 0,
      transferBytes,
      encodedBytes,
      scriptCount: scripts.length,
      stylesheetCount: stylesheets.length,
    };
  });

  await context.close();
  return metrics;
}

let previewProcess = null;
try {
  if (serve) {
    const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    const previewCommand = process.execPath;
    const previewArgs = [viteBin, 'preview', '--host', '127.0.0.1', '--port', '4173'];
    previewProcess = spawn(previewCommand, previewArgs, {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForUrl(url);
  }

  const browser = await chromium.launch();
  const samples = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      samples.push(await measureOnce(browser, url));
    }
  } finally {
    await browser.close();
  }

  const numericKeys = [
    'domContentLoadedMs',
    'loadEventMs',
    'responseEndMs',
    'fcpMs',
    'lcpMs',
    'cls',
    'transferBytes',
    'encodedBytes',
    'scriptCount',
    'stylesheetCount',
  ];
  const summary = { url, runs, measuredAt: new Date().toISOString(), title: samples[0]?.title ?? null };
  for (const key of numericKeys) {
    const values = samples
      .map((sample) => sample[key])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (!values.length) continue;
    summary[key] = {
      avg: key === 'cls' ? Number(average(values).toFixed(3)) : round(average(values)),
      p50: key === 'cls' ? Number(percentile(values, 50).toFixed(3)) : round(percentile(values, 50)),
      p95: key === 'cls' ? Number(percentile(values, 95).toFixed(3)) : round(percentile(values, 95)),
    };
  }

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ summary, samples }, null, 2)}\n`);

  if (json) {
    console.log(JSON.stringify({ summary, reportPath }, null, 2));
  } else {
    console.log('\nPrepShip web performance measurement');
    console.log(`URL: ${summary.url}`);
    console.log(`Runs: ${summary.runs}`);
    console.log(`Report: ${path.relative(root, reportPath)}`);
    for (const key of ['fcpMs', 'lcpMs', 'domContentLoadedMs', 'loadEventMs', 'transferBytes', 'encodedBytes']) {
      if (!summary[key]) continue;
      console.log(`${key}: avg=${summary[key].avg} p50=${summary[key].p50} p95=${summary[key].p95}`);
    }
  }
} finally {
  if (previewProcess) previewProcess.kill();
}
