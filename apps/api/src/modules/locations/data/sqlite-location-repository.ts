import type { DatabaseSync } from "node:sqlite";
import type { SaveLocationInput } from "../../../../../../packages/contracts/src/locations/contracts.js";
import type { LocationRepository } from "../application/location-repository.js";
import type { LocationRecord } from "../domain/location.js";

export class SqliteLocationRepository implements LocationRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async list(): Promise<LocationRecord[]> {
    return this.db.prepare("SELECT * FROM locations ORDER BY isDefault DESC, name ASC").all() as LocationRecord[];
  }

  async getDefault(): Promise<LocationRecord | null> {
    const row = this.db.prepare(
      "SELECT * FROM locations WHERE isDefault = 1 AND active = 1 ORDER BY locationId LIMIT 1"
    ).get() as LocationRecord | undefined;
    return row ?? null;
  }

  async create(input: SaveLocationInput): Promise<number> {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO locations (name, company, street1, street2, city, state, postalCode, country, phone, isDefault, active, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.name,
      input.company ?? "",
      input.street1 ?? "",
      input.street2 ?? "",
      input.city ?? "",
      input.state ?? "",
      input.postalCode ?? "",
      input.country ?? "US",
      input.phone ?? "",
      input.isDefault ? 1 : 0,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  async update(locationId: number, input: SaveLocationInput): Promise<void> {
    this.db.prepare(`
      UPDATE locations
      SET name = ?, company = ?, street1 = ?, street2 = ?, city = ?, state = ?,
          postalCode = ?, country = ?, phone = ?, isDefault = ?, updatedAt = ?
      WHERE locationId = ?
    `).run(
      input.name,
      input.company ?? "",
      input.street1 ?? "",
      input.street2 ?? "",
      input.city ?? "",
      input.state ?? "",
      input.postalCode ?? "",
      input.country ?? "US",
      input.phone ?? "",
      input.isDefault ? 1 : 0,
      Date.now(),
      locationId,
    );
  }

  async delete(locationId: number): Promise<void> {
    this.db.prepare("DELETE FROM locations WHERE locationId = ?").run(locationId);
  }

  async clearDefault(): Promise<void> {
    this.db.prepare("UPDATE locations SET isDefault = 0").run();
  }

  async setDefault(locationId: number): Promise<void> {
    this.db.prepare("UPDATE locations SET isDefault = 1, updatedAt = ? WHERE locationId = ?").run(Date.now(), locationId);
  }
}

