import type { DatabaseSync } from "node:sqlite";
import type { CreateClientInput, UpdateClientInput } from "../../../../../../packages/contracts/src/clients/contracts.ts";
import type { InitStoreDto } from "../../../../../../packages/contracts/src/init/contracts.ts";
import type { ClientRepository } from "../application/client-repository.ts";
import type { ClientRecord } from "../domain/client.ts";

export class SqliteClientRepository implements ClientRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async listActive(): Promise<ClientRecord[]> {
    return this.db.prepare("SELECT * FROM clients WHERE active = 1 ORDER BY name ASC").all() as ClientRecord[];
  }

  async create(input: CreateClientInput): Promise<number> {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO clients (name, storeIds, contactName, email, phone, active, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.name,
      JSON.stringify(input.storeIds ?? []),
      input.contactName ?? "",
      input.email ?? "",
      input.phone ?? "",
      now,
      now,
    );

    return Number(result.lastInsertRowid);
  }

  async update(clientId: number, input: UpdateClientInput): Promise<void> {
    this.db.prepare(`
      UPDATE clients
      SET name = ?, storeIds = ?, contactName = ?, email = ?, phone = ?,
          ss_api_key = ?, ss_api_secret = ?, ss_api_key_v2 = ?, rate_source_client_id = ?, updatedAt = ?
      WHERE clientId = ?
    `).run(
      input.name,
      JSON.stringify(input.storeIds ?? []),
      input.contactName ?? "",
      input.email ?? "",
      input.phone ?? "",
      input.ss_api_key ?? null,
      input.ss_api_secret ?? null,
      input.ss_api_key_v2 ?? null,
      input.rate_source_client_id ?? null,
      Date.now(),
      clientId,
    );
  }

  async softDelete(clientId: number): Promise<void> {
    this.db.prepare("UPDATE clients SET active = 0, updatedAt = ? WHERE clientId = ?").run(Date.now(), clientId);
  }

  async syncFromStores(stores: InitStoreDto[]): Promise<void> {
    const insertClient = this.db.prepare(`
      INSERT INTO clients (name, storeIds, contactName, email, phone, active, createdAt, updatedAt)
      VALUES (?, ?, '', '', '', 1, ?, ?)
      ON CONFLICT(name) DO NOTHING
    `);
    const findByName = this.db.prepare(`
      SELECT clientId, storeIds
      FROM clients
      WHERE name = ?
      LIMIT 1
    `);
    const updateStoreIds = this.db.prepare(`
      UPDATE clients
      SET storeIds = ?, updatedAt = ?
      WHERE clientId = ?
    `);
    const now = Date.now();

    for (const store of stores) {
      const name = store.storeName?.trim();
      if (!name || store.storeId == null) continue;

      const existing = findByName.get(name) as { clientId: number; storeIds: string | null } | undefined;
      if (!existing) {
        insertClient.run(name, JSON.stringify([store.storeId]), now, now);
        continue;
      }

      const storeIds = JSON.parse(existing.storeIds ?? "[]") as number[];
      if (!storeIds.includes(store.storeId)) {
        storeIds.push(store.storeId);
        updateStoreIds.run(JSON.stringify(storeIds), now, existing.clientId);
      }
    }
  }
}
