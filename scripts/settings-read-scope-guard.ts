import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALLOWED_SETTINGS,
  isAllowedSettingKey,
  MARKUP_SETTING_LIKE_PATTERN,
} from '../src/services/user-setting-policy';

for (const key of ALLOWED_SETTINGS) {
  assert.equal(isAllowedSettingKey(key), true, `${key} must remain user-readable`);
}
assert.equal(isAllowedSettingKey('markup.123'), true);
assert.equal(MARKUP_SETTING_LIKE_PATTERN, 'markup._%');

for (const key of [
  'rate_browse_workflow.latest',
  'rate_backfill_best_rates.last_run',
  'print_queue.pdf_merge.last_run',
  'shipping_automation_rules',
]) {
  assert.equal(isAllowedSettingKey(key), false, `${key} must remain internal`);
}

const settingsService = readFileSync('src/services/settings.ts', 'utf8');
assert.match(settingsService, /export async function listUserSettings/);
assert.match(settingsService, /inArray\(settings\.key, \[\.\.\.ALLOWED_SETTINGS\]\)/);
assert.match(settingsService, /like\(settings\.key, MARKUP_SETTING_LIKE_PATTERN\)/);

const settingsRoute = readFileSync('src/routes/settings.ts', 'utf8');
assert.match(settingsRoute, /app\.get\('\/markups'[\s\S]*?listMarkupSettings\(\)/);
assert.match(settingsRoute, /app\.get\('\/:key'[\s\S]*?!isAllowedSettingKey\(key\)/);
assert.doesNotMatch(settingsRoute, /db\.select\(\)\.from\(settings\)\.orderBy/);

const markupsContext = readFileSync('web/src/contexts/MarkupsContext.tsx', 'utf8');
assert.match(markupsContext, /api\.get<any>\('\/settings\/markups'\)/);
assert.doesNotMatch(markupsContext, /api\.get<any>\('\/settings'\)/);

console.log('PASS settings read scope guard');
