import { vi } from "vitest";

/**
 * شبیه‌سازی محیط Next.js (کوکی، هدرها، redirect) تا Server Actionها مستقیم در آزمون اجرا شوند.
 * `testEnv` در همه‌ی فایل‌های آزمون در دسترس است.
 */
export class RedirectError extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const store = {
  cookies: new Map<string, string>(),
  headers: new Map<string, string>([["x-forwarded-for", "10.0.0.1"], ["user-agent", "vitest"]]),
};
(globalThis as Record<string, unknown>).__testEnv = store;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (store.cookies.has(n) ? { name: n, value: store.cookies.get(n)! } : undefined),
    set: (n: string, v: string) => void store.cookies.set(n, v),
    delete: (n: string) => void store.cookies.delete(n),
  }),
  headers: async () => ({ get: (n: string) => store.headers.get(n.toLowerCase()) ?? null }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
