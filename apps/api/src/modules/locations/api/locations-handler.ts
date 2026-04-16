import type { SaveLocationInput } from "../../../../../../packages/contracts/src/locations/contracts.js";
import type { LocationServices } from "../application/location-services.js";

export class LocationsHttpHandler {
  private readonly services: LocationServices;

  constructor(services: LocationServices) {
    this.services = services;
  }

  handleList() {
    return this.services.list();
  }

  handleCreate(body: SaveLocationInput) {
    return this.services.create(body);
  }

  handleUpdate(locationId: number, body: SaveLocationInput) {
    return this.services.update(locationId, body);
  }

  handleDelete(locationId: number) {
    return this.services.delete(locationId);
  }

  handleSetDefault(locationId: number) {
    return this.services.setDefault(locationId);
  }
}

