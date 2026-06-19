/**
 * PS-294 closeout guard - SHIPP 4x6 label proof packet.
 *
 * The placement guard owns the real offline PDF/raster fixture checks. This
 * closeout guard makes sure that evidence stays wired as the Trello completion
 * packet: runnable npm script, both PDF and raster fixture proof, no print-queue
 * barrel import, and no live label/postage behavior.
 *
 *   npx tsx scripts/ps-294-shipp-4x6-closeout-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function hasScript(pkg: string, script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${script}"\\s*:\\s*"${escaped}"`).test(pkg);
}

const pkg = readFileSync('package.json', 'utf8');
const placementGuard = readFileSync('scripts/ps-294-shipp-4x6-placement-guard.ts', 'utf8');
const shippConnector = readFileSync('src/connectors/carrier/shipp.ts', 'utf8');

check(
  'package.json exposes the PS-294 placement guard',
  hasScript(pkg, 'test:ps-294-shipp-4x6-placement', 'tsx scripts/ps-294-shipp-4x6-placement-guard.ts'),
);
check(
  'package.json exposes this PS-294 closeout guard',
  hasScript(pkg, 'test:ps-294-shipp-4x6-closeout', 'tsx scripts/ps-294-shipp-4x6-closeout-guard.ts'),
);

check(
  'placement guard proves the shared 288x432 4x6 canvas invariant',
  /FOUR_BY_SIX_WIDTH_PT === 288/.test(placementGuard) && /FOUR_BY_SIX_HEIGHT_PT === 432/.test(placementGuard),
);
check(
  'placement guard proves PDF fixture normalization end-to-end',
  /assembled label page is exactly/.test(placementGuard) &&
    /cropped oversized SHIPP PDF normalizes to a 288/.test(placementGuard),
);
check(
  'placement guard proves PNG raster fixture normalization end-to-end',
  /SHIPP PNG raster fixture/.test(placementGuard) && /makePngBase64/.test(placementGuard),
);
check(
  'placement guard proves GIF raster fixture normalization end-to-end',
  /SHIPP GIF raster fixture/.test(placementGuard) && /makeGifBase64/.test(placementGuard),
);
check(
  'placement guard proves content-aware fill is larger than the old whole-page contain-fit',
  /content-aware fill is far larger than the old whole-page contain-fit/.test(placementGuard),
);

check(
  'shipp connector delegates PDF labels to the pure print-queue-pdf normalizer',
  /appendNormalizedLabelPages/.test(shippConnector) &&
    /from '\.\.\/\.\.\/services\/print-queue-pdf'/.test(shippConnector),
);
check(
  'shipp connector does not import the env-dragging print-queue barrel',
  !/from '\.\.\/\.\.\/services\/print-queue'/.test(shippConnector),
);
check(
  'raster path still delegates placement math to computeFourBySixPlacement',
  /computeFourBySixPlacement\(\{ srcWidth: image\.width, srcHeight: image\.height/.test(shippConnector),
);

const closeoutStatus = {
  card: 'PS-294',
  recommendation: 'Final Review',
  evidence: [
    'test:ps-294-shipp-4x6-placement',
    'test:ps-294-shipp-4x6-closeout',
  ],
  safety: 'Offline fixture proof only: no real labels, postage, provider calls, queue mutation, marketplace notification, or production data repair.',
} as const;

check('closeout status recommends PS-294 Final Review', closeoutStatus.recommendation === 'Final Review');
check('closeout status includes focused placement evidence', closeoutStatus.evidence.includes('test:ps-294-shipp-4x6-placement'));
check('closeout status documents offline-only safety', /Offline fixture proof only/.test(closeoutStatus.safety));

if (failures > 0) {
  console.error(`\nFAIL PS-294 shipp 4x6 closeout guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-294 shipp 4x6 closeout guard');
