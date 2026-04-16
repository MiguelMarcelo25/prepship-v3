import type { GenerateManifestInput } from "../../../../../../../packages/contracts/src/manifests/contracts.ts";
import type { ManifestShipmentRecord } from "../domain/manifest.ts";

export interface ManifestRepository {
  listShipments(input: GenerateManifestInput): Promise<ManifestShipmentRecord[]>;
}
