/**
 * اجرای شبیه‌ساز از خط فرمان:
 *   npx tsx simulator/cli.ts                                   اجرا روی 127.0.0.1:4010
 *   npx tsx simulator/cli.ts --port 4010 --startpay auto       صفحه‌ی پرداخت خودکار (مناسب ربات)
 *   npx tsx simulator/cli.ts --preset network-chaos --seed 7    شروع با یک پیش‌تنظیم
 *   npx tsx simulator/cli.ts --scenario zarinpal=service_down --scenario gapgpt=rate_limit
 *   npx tsx simulator/cli.ts --help
 * متغیرهای محیطی معادل: SIM_PORT, SIM_HOST, SIM_STARTPAY, SIM_SEED, SIM_TOKEN
 */
import { PRESETS } from "./src/control";
import { isServiceId } from "./src/core";
import { startSimulator } from "./src/server";
import { SimClient } from "./src/client";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

if (args.includes("--help") || args.includes("-h")) {
  console.log(`شبیه‌ساز سرویس‌های بیرونی (زرین‌پال، کاوه‌نگار، ملی‌پیامک، GapGPT)

گزینه‌ها:
  --port <n>            پورت (پیش‌فرض 4010)
  --host <ip>           آدرس شنود (پیش‌فرض 127.0.0.1؛ در docker مقدار 0.0.0.0)
  --startpay auto|manual  رفتار صفحه‌ی پرداخت (پیش‌فرض manual)
  --seed <n>            seed آشوب (برای تکرارپذیری)
  --token <s>           محافظت پنل کنترل با هدر x-sim-token
  --preset <name>       یکی از: ${Object.keys(PRESETS).join(", ")}
  --scenario svc=name   سناریوی اولیه‌ی یک سرویس (می‌تواند چندبار تکرار شود)
  --quiet               بدون لاگ درخواست‌ها`);
  process.exit(0);
}

async function main() {
  const startPay = (flag("startpay") ?? process.env.SIM_STARTPAY ?? "manual") === "auto" ? "auto" : "manual";
  const token = flag("token") ?? process.env.SIM_TOKEN;
  const sim = await startSimulator({
    port: Number(flag("port") ?? process.env.SIM_PORT ?? 4010),
    host: flag("host") ?? process.env.SIM_HOST ?? "127.0.0.1",
    seed: Number(flag("seed") ?? process.env.SIM_SEED ?? 1),
    startPay,
    token,
    quiet: args.includes("--quiet"),
  });
  const client = new SimClient(sim.url, token);
  const preset = flag("preset");
  if (preset) await client.preset(preset);
  for (const s of all("scenario")) {
    const [svc, scenario] = s.split("=");
    if (!svc || !scenario || !isServiceId(svc)) {
      console.error(`--scenario نامعتبر: ${s} (قالب درست: zarinpal=service_down)`);
      continue;
    }
    await client.scenario(svc, scenario);
  }
  console.log(`
🧪 شبیه‌ساز آماده است: ${sim.url}
   داشبورد:        ${sim.url}/__sim/ui${token ? "?token=" + token : ""}
   سلامت:          ${sim.url}/__sim/health
   صفحه‌ی پرداخت:  ${startPay === "auto" ? "خودکار (موفق)" : "دستی"}

برای اتصال برنامه، این متغیر را بدهید:
   EXTERNAL_SIM_URL=${sim.url}

(برای توقف: Ctrl+C)
`);
  const stop = () => {
    void sim.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error("اجرای شبیه‌ساز ناموفق بود:", e instanceof Error ? e.message : e);
  process.exit(1);
});
