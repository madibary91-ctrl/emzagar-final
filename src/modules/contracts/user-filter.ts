import type { UserFilter } from "./service/query";

export const USER_FILTERS: UserFilter[] = ["all", "my_turn", "pending", "signed", "closed"];
export const USER_PAGE_SIZE = 20;

/** پارامتر `?status=` داشبورد کاربر → فیلتر معتبر (ورودی ناشناس ⇒ همه) */
export function parseUserFilter(raw: unknown): UserFilter {
  return USER_FILTERS.includes(raw as UserFilter) ? (raw as UserFilter) : "all";
}

export function parsePage(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}
