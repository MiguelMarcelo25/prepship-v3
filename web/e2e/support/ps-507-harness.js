/**
 * PS-507 — the reusable harness for persistence-proving browser tests.
 *
 * Consumed by PS-499 Step 12 first, then PS-488 M3.
 *
 * THE RULE THIS HARNESS EXISTS TO ENFORCE: nothing on the persistence path under test
 * may be mocked. The rest of web/e2e intercepts every request with `page.route` and
 * seeds a fake `access_token`, which proves rendering and nothing about what was
 * committed. Here the browser carries a REAL HS256 bearer, the app calls the REAL API,
 * the API writes to a REAL PostgreSQL, and the assertion reads that database back.
 *
 * `page.route` is still legitimate for things NOT under test — a carrier quote, a
 * marketplace callback — but never for the request whose persistence is the claim.
 *
 * Requires the stack from scripts/ps-507-qa-stack.mjs:
 *   NODE_ENV=test node scripts/ps-507-qa-stack.mjs -- npx playwright test <spec>
 */

/** Fail loudly and specifically rather than letting a spec run against nothing. */
export function qaEnv() {
  const required = ['PS507_RUN_ID', 'PS507_API_URL', 'PS507_WEB_URL', 'PS507_JWT_SECRET', 'PS507_QUERY_URL', 'PS507_QUERY_TOKEN'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `PS-507 harness: missing ${missing.join(', ')}.\n` +
        'Run the spec through the stack:\n' +
        '  NODE_ENV=test node scripts/ps-507-qa-stack.mjs -- npx playwright test <spec>',
    );
  }
  return {
    runId: process.env.PS507_RUN_ID,
    apiUrl: process.env.PS507_API_URL,
    webUrl: process.env.PS507_WEB_URL,
    jwtSecret: process.env.PS507_JWT_SECRET,
    queryUrl: process.env.PS507_QUERY_URL,
    queryToken: process.env.PS507_QUERY_TOKEN,
  };
}

/** Read-back against the disposable database. This is what makes a claim evidence. */
export async function qaQuery(sql, params = []) {
  const { queryUrl, queryToken } = qaEnv();
  const res = await fetch(queryUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ps507-token': queryToken },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`PS-507 query failed (${res.status}): ${body.error}`);
  return body.rows;
}

/**
 * Assert a row that MUST exist, with a message naming what was actually found.
 *
 * A bare `expect(rows.length).toBe(1)` on a persistence check reports "expected 1, got 0"
 * and leaves the reader guessing whether the write failed, landed under different values,
 * or landed twice. This says which.
 */
export async function expectExactlyOneRow(sql, params, label) {
  const rows = await qaQuery(sql, params);
  if (rows.length !== 1) {
    throw new Error(
      `PS-507: expected exactly one ${label}, found ${rows.length}.\n` +
        `  query : ${sql.replace(/\s+/g, ' ').trim().slice(0, 160)}\n` +
        `  params: ${JSON.stringify(params)}\n` +
        `  rows  : ${JSON.stringify(rows).slice(0, 400)}`,
    );
  }
  return rows[0];
}

/**
 * Assert a FORBIDDEN row is absent — the sidecar/duplicate half of the card's boundary
 * proof. Absence is the harder claim and the one a UI screenshot can never make.
 */
export async function expectNoRows(sql, params, label) {
  const rows = await qaQuery(sql, params);
  if (rows.length !== 0) {
    throw new Error(
      `PS-507: expected NO ${label}, found ${rows.length}. A forbidden write occurred.\n` +
        `  params: ${JSON.stringify(params)}\n` +
        `  rows  : ${JSON.stringify(rows).slice(0, 400)}`,
    );
  }
}

/** The project ref the app derives its localStorage auth key from (VITE_SUPABASE_URL). */
const QA_PROJECT_REF = 'qaqaqaqaqaqaqaqaqaqa';

/**
 * Put a REAL bearer in the browser, so the app's own fetches authenticate for real.
 *
 * The rest of the suite seeds a placeholder like 'ps466-offline-token' and then mocks
 * every response, so the token is never verified by anything. This one is signed with
 * the run's SUPABASE_JWT_SECRET and is validated by the real middleware — a wrong secret
 * produces a genuine 401 rather than a passing test.
 */
export async function signInAsQaUser(page, { sub = 'ps507-qa-user', email = 'qa@example.test', role = 'admin', permissions = [] } = {}) {
  const { jwtSecret } = qaEnv();
  const { mintQaToken } = await import('../../../scripts/ps-507-qa-stack.mjs');
  const accessToken = mintQaToken({ secret: jwtSecret, sub, email, role, permissions });

  await page.addInitScript(([ref, token, userId, userEmail]) => {
    window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify({
      access_token: token,
      refresh_token: 'ps507-no-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: userId, aud: 'authenticated', role: 'authenticated', email: userEmail },
    }));
  }, [QA_PROJECT_REF, accessToken, sub, email]);

  return accessToken;
}

/**
 * Call the QA API directly with a real bearer.
 *
 * For arranging preconditions and for asserting the API's own answer next to the
 * database's. Same token path the browser uses.
 */
export async function qaApiFetch(path, { token, method = 'GET', body, headers = {}, permissions = [] } = {}) {
  const { apiUrl, jwtSecret } = qaEnv();
  const { mintQaToken } = await import('../../../scripts/ps-507-qa-stack.mjs');
  const bearer = token ?? mintQaToken({ secret: jwtSecret, sub: 'ps507-qa-user', email: 'qa@example.test', permissions });
  return fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
