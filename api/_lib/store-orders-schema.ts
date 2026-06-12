// PS-200 S6: relocated to src/services/store-orders-schema.ts (single schema
// owner lives in the v4 tree; legacy Vercel pullers consume it through this
// compatibility re-export until S8 deletes the api/ directory).
export {
  assertStoreOrdersSchemaReady,
  getRequiredStoreOrderRelations,
} from '../../src/services/store-orders-schema.js';
