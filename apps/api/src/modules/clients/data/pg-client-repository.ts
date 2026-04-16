import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.js";
import type { CreateClientInput, UpdateClientInput } from "../../../../../../packages/contracts/src/clients/contracts.js";
import type { InitStoreDto } from "../../../../../../packages/contracts/src/init/contracts.js";
import type { ClientRepository } from "../application/client-repository.js";
import type { ClientRecord } from "../domain/client.js";

export class PgClientRepository implements ClientRepository {
  constructor(private readonly sql: PgClient) {}

  async listActive(): Promise<ClientRecord[]> {
    const rows = await this.sql`
      SELECT * FROM clients WHERE active = 1 ORDER BY name ASC
    `;
    return rows as ClientRecord[];
  }

  async create(input: CreateClientInput): Promise<number> {
    const now = Date.now();
    const [row] = await this.sql`
      INSERT INTO clients (name, "storeIds", "contactName", email, phone, active, "createdAt", "updatedAt")
      VALUES (
        ${input.name},
        ${JSON.stringify(input.storeIds ?? [])},
        ${input.contactName ?? ""},
        ${input.email ?? ""},
        ${input.phone ?? ""},
        1,
        ${now},
        ${now}
      )
      RETURNING "clientId"
    `;
    return Number((row as { clientId: number }).clientId);
  }

  async update(clientId: number, input: UpdateClientInput): Promise<void> {
    await this.sql`
      UPDATE clients
      SET name = ${input.name},
          "storeIds" = ${JSON.stringify(input.storeIds ?? [])},
          "contactName" = ${input.contactName ?? ""},
          email = ${input.email ?? ""},
          phone = ${input.phone ?? ""},
          ss_api_key = ${input.ss_api_key ?? null},
          ss_api_secret = ${input.ss_api_secret ?? null},
          ss_api_key_v2 = ${input.ss_api_key_v2 ?? null},
          rate_source_client_id = ${input.rate_source_client_id ?? null},
          "updatedAt" = ${Date.now()}
      WHERE "clientId" = ${clientId}
    `;
  }

  async softDelete(clientId: number): Promise<void> {
    await this.sql`
      UPDATE clients SET active = 0, "updatedAt" = ${Date.now()}
      WHERE "clientId" = ${clientId}
    `;
  }

  async syncFromStores(stores: InitStoreDto[]): Promise<void> {
    const now = Date.now();

    for (const store of stores) {
      const name = store.storeName?.trim();
      if (!name || store.storeId == null) continue;

      // Try to find existing client
      const existingRows = await this.sql`
        SELECT "clientId", "storeIds"
        FROM clients
        WHERE name = ${name}
        LIMIT 1
      `;
      const existing = existingRows[0] as { clientId: number; storeIds: string | null } | undefined;

      if (!existing) {
        // Insert new client, skip if name conflict
        await this.sql`
          INSERT INTO clients (name, "storeIds", "contactName", email, phone, active, "createdAt", "updatedAt")
          VALUES (${name}, ${JSON.stringify([store.storeId])}, '', '', '', 1, ${now}, ${now})
          ON CONFLICT (name) DO NOTHING
        `;
        continue;
      }

      const storeIds = JSON.parse(existing.storeIds ?? "[]") as number[];
      if (!storeIds.includes(store.storeId)) {
        storeIds.push(store.storeId);
        await this.sql`
          UPDATE clients
          SET "storeIds" = ${JSON.stringify(storeIds)}, "updatedAt" = ${now}
          WHERE "clientId" = ${existing.clientId}
        `;
      }
    }
  }
}
