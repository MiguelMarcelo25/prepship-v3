// PS-083 — Rate Browser scoped-carrier cache (module-level, session-lived).
//
// The Rate Browser sidebar caches the resolved carrier list per order scope so
// reopening the modal for the same client/store is instant. That cache lives
// for the whole browser session, which means a carrier the operator UN-assigns
// in Settings would otherwise keep showing here until a full reload.
//
// Extracted into its own module so BOTH the Rate Browser (which reads/writes it)
// and the Settings carrier-assignment flow (which must INVALIDATE it after an
// assign/unassign) can touch the same Map without importing the heavy modal.
//
// `RbCarrierAccountDto` is imported type-only, so there is no runtime import
// cycle with RateBrowserModal.
import type { RbCarrierAccountDto } from './RateBrowserModal';

const scopedCarrierAccountsCache = new Map<string, RbCarrierAccountDto[]>();

export function getScopedCarrierAccounts(scopeKey: string): RbCarrierAccountDto[] | undefined {
  return scopedCarrierAccountsCache.get(scopeKey);
}

export function hasScopedCarrierAccounts(scopeKey: string): boolean {
  return scopedCarrierAccountsCache.has(scopeKey);
}

export function setScopedCarrierAccounts(scopeKey: string, accounts: RbCarrierAccountDto[]): void {
  scopedCarrierAccountsCache.set(scopeKey, accounts);
}

/**
 * Drop every cached scope. Call after a carrier assignment changes (assign,
 * unassign, delete, reconnect) so the next Rate Browser open re-fetches and
 * a now-unassigned carrier (e.g. SHIPP) does not resurrect from cache.
 */
export function clearScopedCarrierAccountsCache(): void {
  scopedCarrierAccountsCache.clear();
}
