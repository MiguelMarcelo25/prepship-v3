import type { GenerateManifestInput } from "../../../../../../../packages/contracts/src/manifests/contracts.js";
import type { ManifestShipmentRecord } from "../domain/manifest.js";

export interface ManifestRepository {
  listShipments(input: GenerateManifestInput): Promise<ManifestShipmentRecord[]>;
}
