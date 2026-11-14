import { buildTemplate } from "./build";
import { BUSINESS } from "./catalog/business";
import { FINANCE } from "./catalog/finance";
import { HOUSING } from "./catalog/housing";
import { PERSONAL } from "./catalog/personal";
import { VEHICLE } from "./catalog/vehicle";
import { WORK } from "./catalog/work";
import { CATEGORIES, type CategoryId, type LibraryTemplate } from "./types";

export { CATEGORIES } from "./types";
export type { CategoryId, LibraryTemplate } from "./types";
export { fillPlaceholders, listPlaceholders, BLANK } from "./build";

/** کتابخانه‌ی قالب‌های آماده‌ی فارسی (حقوقی، متناسب با قوانین و عرف معاملات ایران) */
export const LIBRARY: LibraryTemplate[] = [...HOUSING, ...VEHICLE, ...FINANCE, ...WORK, ...BUSINESS, ...PERSONAL].map(buildTemplate);

const BY_KEY = new Map(LIBRARY.map((t) => [t.key, t]));

export const getLibraryTemplate = (key: string | null | undefined): LibraryTemplate | undefined => (key ? BY_KEY.get(key) : undefined);

export function libraryByCategory(): { id: CategoryId; label: string; items: LibraryTemplate[] }[] {
  return CATEGORIES.map((c) => ({ id: c.id, label: c.label, items: LIBRARY.filter((t) => t.category === c.id) }));
}
