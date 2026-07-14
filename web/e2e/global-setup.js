const APP_URL = 'http://127.0.0.1:5177'
const SUPABASE_MODULE_PATH = '/src/lib/supabase.ts'
const EXPECTED_SUPABASE_URL = 'https://fdkseckgfuvdczzqmnac.supabase.co'

export default async function globalSetup() {
  const response = await fetch(`${APP_URL}${SUPABASE_MODULE_PATH}`)
  const body = await response.text()

  if (!response.ok || !body.includes(EXPECTED_SUPABASE_URL)) {
    throw new Error(
      'Port 5177 is serving an app with the wrong VITE_SUPABASE_URL — ' +
        'kill the stray dev server and re-run so playwright.config.js boots its own.',
    )
  }
}
