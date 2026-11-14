/**
 * DB-05 — «تنها منبع حقیقت» ساختار دیتابیس: `src/db/schema.ts`.
 *
 * پیش‌تر `schema-sql.ts` یک فایل تولیدشده با اجرای دستی `gen-schema-sql.mjs` بود (دو منبع حقیقت، بدون هیچ CI).
 * اکنون DDL ایدمپوتنت نصب‌کننده «در لحظه» از خودِ تعریف جدول‌های Drizzle ساخته می‌شود؛
 * پس هیچ فایل تولیدی‌ای برای فراموش‌شدن یا ناهمگام‌شدن وجود ندارد و هر ستون/ایندکس/Foreign Key
 * که در schema.ts اضافه شود، خودکار در نصب و ارتقا اعمال می‌شود.
 *
 * فقط به drizzle-orm (وابستگی production) نیاز دارد، نه drizzle-kit.
 */
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable, type AnyPgColumn, type PgColumn } from "drizzle-orm/pg-core";
import * as schema from "./schema";

const dialect = new PgDialect();
const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const renderSql = (s: SQL) => dialect.sqlToQuery(s).sql;

export const TRGM_OPCLASS = "gin_trgm_ops";

export interface SchemaPlan {
  /** CREATE EXTENSION (ایمن؛ نبود دسترسی فقط هشدار است) */
  extensions: string[];
  /** CREATE TABLE IF NOT EXISTS … */
  tables: string[];
  /** ALTER TABLE … ADD COLUMN IF NOT EXISTS … (برای دیتابیس‌های قدیمی‌تر) */
  columns: string[];
  /** CREATE [UNIQUE] INDEX IF NOT EXISTS … */
  indexes: string[];
  /** Foreign Keyها (ایدمپوتنت، DEFERRABLE) */
  foreignKeys: string[];
  /** نام جدول‌ها */
  tableNames: string[];
}

function columnDef(col: PgColumn, opts: { inline: boolean }): string {
  const parts = [q(col.name), col.getSQLType()];
  if (col.hasDefault && col.default !== undefined) {
    const d = col.default as unknown;
    if (is(d as object, SQL)) parts.push(`DEFAULT ${renderSql(d as SQL)}`);
    else if (typeof d === "string") parts.push(`DEFAULT ${lit(d)}`);
    else if (typeof d === "number" || typeof d === "bigint" || typeof d === "boolean") parts.push(`DEFAULT ${String(d)}`);
    else parts.push(`DEFAULT ${lit(JSON.stringify(d))}`);
  }
  if (opts.inline && col.primary) parts.push("PRIMARY KEY");
  if (col.notNull) parts.push("NOT NULL");
  return parts.join(" ");
}

function indexColumn(c: unknown): string {
  if (is(c as object, SQL)) return renderSql(c as SQL);
  const col = c as PgColumn & { indexConfig?: { order?: string; nulls?: string; opClass?: string } };
  const cfg = col.indexConfig;
  return [q(col.name), cfg?.opClass, cfg?.order === "desc" ? "DESC" : undefined].filter(Boolean).join(" ");
}

const allTables = (): PgTable[] => (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v as object, PgTable));

export function buildSchemaPlan(): SchemaPlan {
  const plan: SchemaPlan = { extensions: [], tables: [], columns: [], indexes: [], foreignKeys: [], tableNames: [] };
  let needsTrgm = false;

  const tables = allTables()
    .map((t) => getTableConfig(t))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const t of tables) {
    plan.tableNames.push(t.name);
    const lines = t.columns.map((c) => columnDef(c, { inline: true }));
    for (const c of t.columns) if (c.isUnique) lines.push(`CONSTRAINT ${q(c.uniqueName ?? `${t.name}_${c.name}_unique`)} UNIQUE(${q(c.name)})`);
    for (const u of t.uniqueConstraints) lines.push(`CONSTRAINT ${q(u.name ?? `${t.name}_${u.columns.map((c) => c.name).join("_")}_unique`)} UNIQUE(${u.columns.map((c) => q(c.name)).join(",")})`);
    for (const pk of t.primaryKeys) lines.push(`CONSTRAINT ${q(pk.getName())} PRIMARY KEY(${pk.columns.map((c) => q(c.name)).join(",")})`);
    plan.tables.push(`CREATE TABLE IF NOT EXISTS ${q(t.name)} (\n\t${lines.join(",\n\t")}\n)`);

    for (const c of t.columns) {
      if (c.primary) continue;
      plan.columns.push(`ALTER TABLE ${q(t.name)} ADD COLUMN IF NOT EXISTS ${columnDef(c, { inline: false })}`);
    }

    for (const i of t.indexes) {
      const cfg = i.config;
      const cols = cfg.columns.map(indexColumn);
      const usesTrgm = cols.some((c) => c.includes(TRGM_OPCLASS));
      const where = cfg.where ? ` WHERE ${renderSql(cfg.where)}` : "";
      const stmt = `CREATE ${cfg.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(cfg.name ?? "")} ON ${q(t.name)}${cfg.method && cfg.method !== "btree" ? ` USING ${cfg.method}` : ""} (${cols.join(", ")})${where}`;
      if (usesTrgm) {
        needsTrgm = true;
        // بدون pg_trgm فقط هشدار می‌دهیم (جستجو کندتر ولی درست کار می‌کند)؛ health check وضعیت را گزارش می‌دهد
        plan.indexes.push(
          `DO $emz$ BEGIN IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN ${stmt}; ELSE RAISE WARNING 'pg_trgm unavailable: index % skipped', ${lit(cfg.name ?? "")}; END IF; END $emz$`,
        );
      } else plan.indexes.push(stmt);
    }

    for (const fk of t.foreignKeys) {
      const r = fk.reference();
      const name = fk.getName();
      const from = r.columns.map((c) => q(c.name)).join(", ");
      const to = r.foreignColumns.map((c) => q(c.name)).join(", ");
      const ft = getTableConfig(r.foreignTable).name;
      const add = `ALTER TABLE ${q(t.name)} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${from}) REFERENCES ${q(ft)}(${to}) ON DELETE ${fk.onDelete ?? "no action"} ON UPDATE ${fk.onUpdate ?? "no action"} DEFERRABLE INITIALLY IMMEDIATE NOT VALID`;
      // NOT VALID سپس VALIDATE: روی دیتابیس موجود که ردیف یتیم (orphan) دارد نصب شکست نمی‌خورد؛
      // قید برای هر نوشتن جدید اعمال است و health check ردیف‌های یتیم را گزارش می‌دهد.
      // PostgreSQL برای ستون فرزند FK ایندکس نمی‌سازد؛ بدون آن، حذف/به‌روزرسانی ردیف والد (CASCADE/SET NULL) اسکن کامل جدول فرزند است
      const first = r.columns[0].name;
      const leading = (c: unknown) => !is(c as object, SQL) && (c as PgColumn).name === first;
      const covered =
        t.indexes.some((i) => leading(i.config.columns[0])) ||
        t.primaryKeys.some((pk) => pk.columns[0].name === first) ||
        t.columns.some((c) => c.name === first && (c.primary || c.isUnique)) ||
        t.uniqueConstraints.some((u) => u.columns[0].name === first);
      if (!covered) plan.indexes.push(`CREATE INDEX IF NOT EXISTS ${q(`${t.name}_${first}_fk_idx`)} ON ${q(t.name)} (${q(first)})`);
      plan.foreignKeys.push(
        `DO $emz$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${lit(name)} AND conrelid = ${lit(q(t.name))}::regclass) THEN ${add}; END IF; ` +
          `BEGIN ALTER TABLE ${q(t.name)} VALIDATE CONSTRAINT ${q(name)}; EXCEPTION WHEN foreign_key_violation THEN RAISE WARNING 'FK % has orphan rows; left NOT VALID', ${lit(name)}; END; END $emz$`,
      );
    }
  }

  if (needsTrgm) {
    plan.extensions.push(`DO $emz$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pg_trgm extension unavailable: %', SQLERRM; END $emz$`);
  }
  return plan;
}

/** انتظار: ستون‌ها و نوع هرکدام (برای تطبیق با دیتابیس واقعی) */
export function expectedColumns(): { table: string; column: string; type: string }[] {
  const out: { table: string; column: string; type: string }[] = [];
  for (const v of allTables()) {
    const t = getTableConfig(v);
    for (const c of t.columns as AnyPgColumn[]) out.push({ table: t.name, column: c.name, type: c.getSQLType() });
  }
  return out;
}

export function expectedForeignKeys(): { table: string; name: string }[] {
  const out: { table: string; name: string }[] = [];
  for (const v of allTables()) {
    const t = getTableConfig(v);
    for (const fk of t.foreignKeys) out.push({ table: t.name, name: fk.getName() });
  }
  return out;
}
