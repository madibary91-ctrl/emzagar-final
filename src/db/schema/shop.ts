import { type AnyPgColumn, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { contracts, templates } from "./contracts";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/** محصولات / خدمات متصل به قرارداد (شبیه ووکامرس) */
export const products = pgTable("products", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  price: integer("price").notNull().default(0),
  templateId: integer("template_id").references((): AnyPgColumn => templates.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const orders = pgTable("orders", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "no action" }).notNull().default(0),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
  productId: integer("product_id").references((): AnyPgColumn => products.id, { onDelete: "no action" }).notNull(),
  amount: integer("amount").notNull().default(0),
  status: text("status").notNull().default("awaiting_signature"), // awaiting_signature | completed
  contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
