import type { SaveLocationInput } from "../../../../../../packages/contracts/src/locations/contracts.ts";
import type { LocationRecord } from "../domain/location.ts";

export interface LocationRepository {
  list(): Promise<LocationRecord[]>;
  getDefault(): Promise<LocationRecord | null>;
  create(input: SaveLocationInput): Promise<number>;
  update(locationId: number, input: SaveLocationInput): Promise<void>;
  delete(locationId: number): Promise<void>;
  clearDefault(): Promise<void>;
  setDefault(locationId: number): Promise<void>;
}

