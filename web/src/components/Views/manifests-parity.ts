// @ts-nocheck
import type { GenerateManifestInput } from '@prepshipv2/contracts/manifests/contracts'

export interface ManifestFormState {
  startDate: string
  endDate: string
  carrierId: string
}

export function formatManifestDateInput(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getManifestDefaultForm(now = new Date()): ManifestFormState {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const start = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000))

  return {
    startDate: formatManifestDateInput(start),
    endDate: formatManifestDateInput(now),
    carrierId: '',
  }
}

export function validateManifestForm(form: ManifestFormState) {
  if (!form.startDate || !form.endDate) {
    return '⚠️ Select start and end dates'
  }

  return null
}

export function buildManifestPayload(form: ManifestFormState): GenerateManifestInput {
  return {
    startDate: form.startDate,
    endDate: form.endDate,
    ...(form.carrierId ? { carrierId: form.carrierId } : {}),
  }
}

export function buildManifestFilename(startDate: string, endDate: string) {
  return `manifest_${startDate}_${endDate}.csv`
}

export function getManifestGenerateButtonLabel(isLoading: boolean) {
  return isLoading ? '⏳ Generating…' : '⬇️ Download CSV'
}

export function getManifestStatusText(isLoading: boolean) {
  return isLoading ? 'Generating manifest…' : ''
}
