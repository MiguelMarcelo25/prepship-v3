import assert from 'node:assert/strict'
import test from 'node:test'

import type { CarrierAccountDto, ClearAndRefetchResultDto } from '../src/types/api.ts'
import type { MarkupsMap } from '../src/types/markups.ts'
import {
  buildSettingsMarkupRows,
  buildSettingsRefetchStatus,
  formatSettingsMarkupPreview,
  getSettingsAccountLabel,
  getSettingsMarkupEmptyMessage,
  getSettingsMarkupSavedToastMessage,
  parseSettingsMarkupInput,
} from '../src/components/Views/settings-parity.ts'

function makeAccount(overrides: Partial<CarrierAccountDto> = {}): CarrierAccountDto {
  return {
    carrierId: 'stamps_com',
    carrierCode: 'stamps_com',
    shippingProviderId: 101,
    nickname: 'Primary USPS',
    clientId: null,
    code: 'stamps_com',
    _label: 'USPS - Primary',
    ...overrides,
  }
}

test('buildSettingsMarkupRows mirrors the settings account rows and filters voucher accounts', () => {
  const markups: MarkupsMap = {
    101: { type: 'pct', value: 8 },
    202: { type: 'flat', value: 1.25 },
  }

  const rows = buildSettingsMarkupRows([
    makeAccount(),
    makeAccount({ shippingProviderId: 202, carrierCode: 'ups', code: 'ups', _label: '', nickname: 'UPS Ground Account' }),
    makeAccount({ shippingProviderId: 999, code: 'voucher-generic', _label: 'Voucher Generic' }),
  ], markups, { 202: '' })

  assert.deepEqual(rows, [
    {
      shippingProviderId: 101,
      label: 'USPS - Primary',
      type: 'pct',
      value: 8,
      inputValue: '8',
      preview: '+8%',
    },
    {
      shippingProviderId: 202,
      label: 'UPS Ground Account',
      type: 'flat',
      value: 1.25,
      inputValue: '',
      preview: '+$0.00',
    },
  ])
})

test('settings markup helpers preserve the web labels, preview copy, and blank-input parsing', () => {
  assert.equal(getSettingsAccountLabel(makeAccount({ _label: '', nickname: '', code: 'fedex' })), 'fedex')
  assert.equal(formatSettingsMarkupPreview('flat', '1.5'), '+$1.50')
  assert.equal(formatSettingsMarkupPreview('pct', ''), '+0%')
  assert.equal(parseSettingsMarkupInput('  '), 0)
  assert.equal(parseSettingsMarkupInput('2.75'), 2.75)
  assert.equal(getSettingsMarkupEmptyMessage(), 'Open Rate Browser once to load accounts.')
  assert.equal(getSettingsMarkupSavedToastMessage(), '✅ Markup saved — rates refreshed')
})

test('buildSettingsRefetchStatus matches the web cache-management status copy', () => {
  const result: ClearAndRefetchResultDto = {
    ok: true,
    message: 'Cache cleared successfully',
    ordersQueued: 12,
  }

  assert.deepEqual(buildSettingsRefetchStatus({ kind: 'idle' }), {
    visible: false,
    text: '',
    color: 'var(--text3)',
  })

  assert.deepEqual(buildSettingsRefetchStatus({ kind: 'loading' }), {
    visible: true,
    text: '⏳ Clearing cache and refetching rates...',
    color: 'var(--text3)',
  })

  assert.deepEqual(buildSettingsRefetchStatus({ kind: 'success', result }), {
    visible: true,
    text: '✅ Cache cleared successfully (12 orders queued)',
    color: 'var(--green)',
  })

  assert.deepEqual(buildSettingsRefetchStatus({ kind: 'error', message: 'boom' }), {
    visible: true,
    text: '❌ Error: boom',
    color: 'var(--red)',
  })
})
