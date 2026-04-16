import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.ts";
import type { SaveLocationInput } from "../../../../../../packages/contracts/src/locations/contracts.ts";
import type { LocationRepository } from "../application/location-repository.ts";
import type { LocationRecord } from "../domain/location.ts";

export class PgLocationRepository implements LocationRepository {
  constructor(private readonly sql: PgClient) {}

  async list(): Promise<LocationRecord[]> {
    const rows = await this.sql`
      SELECT * FROM locations ORDER BY isDefault DESC, name ASC
    `;
    return rows as LocationRecord[];
  }

  async getDefault(): Promise<LocationRecord | null> {
    const rows = await this.sql`
      SELECT * FROM locations
      WHERE isDefault = 1 AND active = 1
      ORDER BY locationId
      LIMIT 1
    `;
    return (rows[0] as LocationRecord) ?? null;
  }

  async create(input: SaveLocationInput): Promise<number> {
    const now = Date.now();
    const [row] = await this.sql`
      INSERT INTO locations (name, company, street1, street2, city, state, postalCode, country, phone, isDefault, active, createdAt, updatedAt)
      VALUES (
        ${input.name},
        ${input.company ?? ""},
        ${input.street1 ?? ""},
        ${input.street2 ?? ""},
        ${input.city ?? ""},
        ${input.state ?? ""},
        ${input.postalCode ?? ""},
        ${input.country ?? "US"},
        ${input.phone ?? ""},
        ${input.isDefault ? 1 : 0},
        1,
        ${now},
        ${now}
      )
      RETURNING locationId
    `;
    return Number((row as { locationId: number }).locationId);
  }

  async update(locationId: number, input: SaveLocationInput): Promise<void> {
    await this.sql`
      UPDATE locations
      SET name = ${input.name},
          company = ${input.company ?? ""},
          street1 = ${input.street1 ?? ""},
          street2 = ${input.street2 ?? ""},
          city = ${input.city ?? ""},
          state = ${input.state ?? ""},
          postalCode = ${input.postalCode ?? ""},
          country = ${input.country ?? "US"},
          phone = ${input.phone ?? ""},
          isDefault = ${input.isDefault ? 1 : 0},
          updatedAt = ${Date.now()}
      WHERE locationId = ${locationId}
    `;
  }

  async delete(locationId: number): Promise<void> {
    await this.sql`DELETE FROM locations WHERE locationId = ${locationId}`;
  }

  async clearDefault(): Promise<void> {
    await this.sql`UPDATE locations SET isDefault = 0`;
  }

  async setDefault(locationId: number): Promise<void> {
    await this.sql`
      UPDATE locations SET isDefault = 1, updatedAt = ${Date.now()}
      WHERE locationId = ${locationId}
    `;
  }
}
