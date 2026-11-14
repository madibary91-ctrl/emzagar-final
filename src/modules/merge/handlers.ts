import { registerJobHandler } from "@/modules/jobs/queue";
import { processMergeRow } from "./service";

/** ارسال انبوه: هر ردیف یک کار مستقل در صف ماندگار (پردازش بیرون از درخواست کاربر، با گزارش لحظه‌ای) */
registerJobHandler("merge.row", {
  async run(p) {
    await processMergeRow(Number(p.rowId));
  },
});
