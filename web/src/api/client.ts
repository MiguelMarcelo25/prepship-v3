// v2-compat shim — re-exports the apiClient adapter T1 built at
// web/src/lib/v2-apiClient.ts so v2's OrdersView imports resolve.
export { apiClient } from '../lib/v2-apiClient'

// v2 throws ApiError from failed api calls. v4's lib/api throws plain Error.
// We export a compatible class so `instanceof ApiError` checks in v2 code
// compile (but won't actually match; that's fine — callers also catch Error).
export class ApiError extends Error {
  status: number
  statusText: string
  constructor(status: number, statusText: string, message?: string) {
    super(message ?? `API Error: ${status} ${statusText}`)
    this.name = 'ApiError'
    this.status = status
    this.statusText = statusText
  }
}
