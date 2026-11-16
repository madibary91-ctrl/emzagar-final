/**
 * پروسه‌ی فرزند برای آزمون R-02: سیگنال «واقعی» SIGTERM دریافت می‌کند.
 * argv: <mode> <outFile>
 *   next-like : مثل Next.js، یک هندلر SIGTERM «پیش از» ما دارد که ۱۰ms بعد فوراً process.exit(143) می‌زند
 *   sole      : فقط هندلر ما (مثل NEXT_MANUAL_SIG_HANDLE=1)
 *   stuck     : یک قلاب که هرگز تمام نمی‌شود (باید با مهلت قطع شود)
 */
import fs from "node:fs";
import { installShutdownHandlers, onShutdown } from "../../src/lib/shutdown";

const [mode, out] = [process.argv[2], process.argv[3]];
const mark = (s: string) => fs.appendFileSync(out, `${s}\n`);

if (mode === "next-like") process.on("SIGTERM", () => setTimeout(() => process.exit(143), 10));

if (mode === "stuck") {
  onShutdown("never", () => new Promise<void>(() => undefined), 20);
} else {
  onShutdown(
    "slow",
    async () => {
      await new Promise((r) => setTimeout(r, 400));
      mark("slow-done");
    },
    20,
  );
}
onShutdown("late", () => mark("late-done"), 90);

installShutdownHandlers();
setInterval(() => undefined, 1000); // مثل سرور HTTP، پروسه را زنده نگه می‌دارد
console.log("ready");
