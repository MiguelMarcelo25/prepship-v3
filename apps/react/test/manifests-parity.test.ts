import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiError, apiClient } from '../src/api/client.ts'
import {
  buildManifestFilename,
  buildManifestPayload,
  getManifestDefaultForm,
  getManifestGenerateButtonLabel,
  getManifestStatusText,
  validateManifestForm,
} from '../src/components/Views/manifests-parity.ts'

test('manifest defaults mirror the web last-30-days modal reset behavior', () => {
  assert.deepEqual(
    getManifestDefaultForm(new Date('2026-03-22T12:00:00.000Z')),
    {
      startDate: '2026-02-19',
      endDate: '2026-03-22',
      carrierId: '',
    },
  )
})

test('manifest payload builder omits empty carrier filters and preserves selected carriers', () => {
  assert.deepEqual(
    buildManifestPayload({
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      carrierId: '',
    }),
    {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    },
  )

  assert.deepEqual(
    buildManifestPayload({
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      carrierId: 'ups',
    }),
    {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      carrierId: 'ups',
    },
  )
})

test('manifest helpers preserve the web copy for validation, button text, status text, and filenames', () => {
  assert.equal(
    validateManifestForm({
      startDate: '',
      endDate: '2026-03-31',
      carrierId: '',
    }),
    '⚠️ Select start and end dates',
  )

  assert.equal(getManifestGenerateButtonLabel(false), '⬇️ Download CSV')
  assert.equal(getManifestGenerateButtonLabel(true), '⏳ Generating…')
  assert.equal(getManifestStatusText(true), 'Generating manifest…')
  assert.equal(getManifestStatusText(false), '')
  assert.equal(buildManifestFilename('2026-03-01', '2026-03-31'), 'manifest_2026-03-01_2026-03-31.csv')
})

test('api client posts manifest requests and returns the blob plus content-disposition filename', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, '/api/manifests/generate')
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        startDate: '2026-03-01',
        endDate: '2026-03-31',
        carrierId: 'fedex',
      })

      return new Response(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename="manifest_custom.csv"',
          'content-type': 'text/csv',
        },
      })
    }

    const result = await apiClient.downloadManifest({
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      carrierId: 'fedex',
    })

    assert.equal(result.filename, 'manifest_custom.csv')
    assert.equal(await result.blob.text(), 'a,b\n1,2\n')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client surfaces manifest API errors using the response body message', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'No shipments found' }), {
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: {
        'content-type': 'application/json',
      },
    })

    await assert.rejects(
      apiClient.downloadManifest({
        startDate: '2026-03-01',
        endDate: '2026-03-31',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.message, 'No shipments found')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
