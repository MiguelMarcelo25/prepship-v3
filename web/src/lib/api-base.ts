const PRODUCTION_API_BASE = 'https://prepshipv4-api-l5xc.onrender.com';
const DEV_API_PORT = 3000;

const configuredApiBase = (
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.VITE_API_BASE_URL as string | undefined)
)?.trim();
const isProductionBuild = import.meta.env.MODE !== 'development';
const appHostname =
  typeof globalThis.location?.hostname === 'string'
    ? globalThis.location.hostname
    : 'localhost';
const appProtocol =
  typeof globalThis.location?.protocol === 'string'
    ? globalThis.location.protocol
    : 'http:';
const appOrigin =
  typeof globalThis.location?.origin === 'string'
    ? globalThis.location.origin
    : '';

// In dev, derive API base from the page hostname so the app works whether you
// load it via localhost, 127.0.0.1, or a LAN IP (e.g. 192.168.1.x:5173 from a
// phone). Otherwise calls like `fetch('http://localhost:3000/...')` from the
// LAN device hit the *device itself*, not the dev machine.
const localApiBase = `${appProtocol}//${appHostname}:${DEV_API_PORT}`;

const configuredIsLocal =
  configuredApiBase != null &&
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(configuredApiBase);
const configuredIsAppOrigin =
  configuredApiBase != null &&
  appOrigin !== '' &&
  configuredApiBase.replace(/\/+$/, '') === appOrigin.replace(/\/+$/, '');

const resolvedApiBase =
  configuredApiBase &&
  !(isProductionBuild && configuredIsLocal) &&
  !(isProductionBuild && configuredIsAppOrigin)
    ? configuredApiBase
    : isProductionBuild
      ? PRODUCTION_API_BASE
      : localApiBase;

export const API_BASE = resolvedApiBase.replace(/\/+$/, '');
