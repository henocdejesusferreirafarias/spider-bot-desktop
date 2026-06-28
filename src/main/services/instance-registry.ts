import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InstanceRecord, InstanceStatus } from "../../shared/contracts.js";
import type { PredatorGlobalPaths } from "./paths.js";

interface InstanceRow {
  id: string;
  name: string;
  status: InstanceStatus;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

interface InstanceCounts {
  profileCount: number;
  proxyCount: number;
  pixPhoneKeyCount: number;
}

const defaultCounts: InstanceCounts = {
  profileCount: 0,
  proxyCount: 0,
  pixPhoneKeyCount: 0
};

export class InstanceRegistry {
  private readonly db: DatabaseSync;

  constructor(private readonly paths: PredatorGlobalPaths) {
    mkdirSync(paths.appData, { recursive: true });
    mkdirSync(paths.instancesRoot, { recursive: true });
    this.db = new DatabaseSync(paths.instanceRegistryFile);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.createSchema();
    this.markAllStopped();
  }

  listInstances(): InstanceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM instances ORDER BY updated_at DESC, name ASC")
      .all() as unknown as InstanceRow[];

    return rows.map((row) => this.mapRow(row, this.readCounts(row.id)));
  }

  getInstance(instanceId: string): InstanceRecord {
    const row = this.db.prepare("SELECT * FROM instances WHERE id = ?").get(instanceId) as InstanceRow | undefined;

    if (!row) {
      throw new Error(`Instancia ${instanceId} nao encontrada.`);
    }

    return this.mapRow(row, this.readCounts(row.id));
  }

  createInstance(name?: string): InstanceRecord {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const trimmedName = name?.trim();
    const safeName = trimmedName || `Instancia ${this.countInstances() + 1}`;

    mkdirSync(this.getInstanceRoot(id), { recursive: true });
    this.db
      .prepare(
        "INSERT INTO instances (id, name, status, created_at, updated_at) VALUES (?, ?, 'stopped', ?, ?)"
      )
      .run(id, safeName.slice(0, 80), now, now);

    return this.getInstance(id);
  }

  renameInstance(instanceId: string, name: string): InstanceRecord {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("Informe um nome para a instancia.");
    }

    this.db
      .prepare("UPDATE instances SET name = ?, updated_at = ? WHERE id = ?")
      .run(trimmedName.slice(0, 80), new Date().toISOString(), instanceId);
    return this.getInstance(instanceId);
  }

  markOpened(instanceId: string): InstanceRecord {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE instances SET status = 'running', last_opened_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, instanceId);
    return this.getInstance(instanceId);
  }

  markStopped(instanceId: string): InstanceRecord | undefined {
    const existing = this.db.prepare("SELECT id FROM instances WHERE id = ?").get(instanceId) as
      | { id: string }
      | undefined;

    if (!existing) {
      return undefined;
    }

    this.db
      .prepare("UPDATE instances SET status = 'stopped', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), instanceId);
    return this.getInstance(instanceId);
  }

  deleteInstance(instanceId: string): void {
    this.getInstance(instanceId);
    const instanceRoot = this.getInstanceRoot(instanceId);
    this.assertInsideInstancesRoot(instanceRoot);
    this.db.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);

    if (existsSync(instanceRoot)) {
      rmSync(instanceRoot, {
        recursive: true,
        force: true
      });
    }
  }

  getInstanceRoot(instanceId: string): string {
    if (!/^[a-z0-9-]+$/i.test(instanceId)) {
      throw new Error("Identificador de instancia invalido.");
    }

    return join(this.paths.instancesRoot, instanceId);
  }

  close(): void {
    this.db.close();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT
      );
    `);
  }

  private markAllStopped(): void {
    this.db.prepare("UPDATE instances SET status = 'stopped', updated_at = ?").run(new Date().toISOString());
  }

  private countInstances(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM instances").get() as { count: number };
    return row.count;
  }

  private readCounts(instanceId: string): InstanceCounts {
    const databaseFile = join(this.getInstanceRoot(instanceId), "predator.sqlite");
    if (!existsSync(databaseFile)) {
      return defaultCounts;
    }

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(databaseFile);
      return {
        profileCount: this.countTable(db, "profiles"),
        proxyCount: this.countTable(db, "proxies"),
        pixPhoneKeyCount: this.countTable(db, "pix_phone_keys", "WHERE status = 'available'")
      };
    } catch {
      return defaultCounts;
    } finally {
      db?.close();
    }
  }

  private countTable(db: DatabaseSync, tableName: string, whereClause?: string): number {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
      | { name: string }
      | undefined;

    if (!table) {
      return 0;
    }

    const sql = whereClause
      ? `SELECT COUNT(*) AS count FROM ${tableName} ${whereClause}`
      : `SELECT COUNT(*) AS count FROM ${tableName}`;
    const row = db.prepare(sql).get() as { count: number };
    return row.count;
  }

  private mapRow(row: InstanceRow, counts: InstanceCounts): InstanceRecord {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      profileCount: counts.profileCount,
      proxyCount: counts.proxyCount,
      pixPhoneKeyCount: counts.pixPhoneKeyCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at ?? undefined
    };
  }

  private assertInsideInstancesRoot(path: string): void {
    const root = resolve(this.paths.instancesRoot);
    const target = resolve(path);
    const targetRelativePath = relative(root, target);

    if (!targetRelativePath || targetRelativePath.startsWith("..") || isAbsolute(targetRelativePath)) {
      throw new Error("Caminho de instancia inseguro.");
    }
  }
}
