// Single source of truth for "is this user an admin?" Used by routes that
// gate admin-only operations (e.g. order assignment) and the order list
// filter (admins see every order; non-admins see only orders assigned to
// their Supabase user UUID).
//
// Edit this list — or back it with a settings table later — to add admins.
const ADMIN_EMAILS = new Set<string>([
  'admin@drprepper.com',
]);

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export function listAdminEmails(): string[] {
  return [...ADMIN_EMAILS];
}
