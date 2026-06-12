// PS-200 S6: relocated to src/lib/safe-error.ts (the v4 tree owns shared
// code; the legacy Vercel functions consume it through this compatibility
// re-export until S8 deletes the api/ directory).
export {
  INTERNAL_SERVER_ERROR,
  errorMessage,
  logServerError,
  sendInternalServerError,
} from '../../src/lib/safe-error.js';
