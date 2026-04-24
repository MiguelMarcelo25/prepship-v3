const LOCAL_API_BASE = 'http://localhost:3000';
const PRODUCTION_API_BASE = 'https://prepshipv4-api.onrender.com';

const configuredApiBase = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
const isProductionBuild = import.meta.env.MODE !== 'development';
const appOrigin =
  typeof globalThis.location?.origin === 'string'
    ? globalThis.location.origin
    : '';
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
      : LOCAL_API_BASE;

export const API_BASE = resolvedApiBase.replace(/\/+$/, '');
