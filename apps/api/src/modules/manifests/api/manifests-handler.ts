import type { GenerateManifestInput } from "../../../../../../../packages/contracts/src/manifests/contracts.ts";
import type { ManifestServices } from "../application/manifest-services.ts";

export class ManifestsHttpHandler {
  private readonly services: ManifestServices;

  constructor(services: ManifestServices) {
    this.services = services;
  }

  async handleGenerate(body: GenerateManifestInput) {
    return await this.services.generate(body);
  }
}
