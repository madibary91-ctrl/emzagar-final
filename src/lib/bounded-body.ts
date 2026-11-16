/**
 * GLM-8 — خواندن بدنه‌ی multipart «با سقف واقعی بایت».
 *
 * `req.formData()` کل بدنه را (بدون هیچ سقفی) در حافظه جمع می‌کند و فقط «بعد از آن» می‌شود اندازه را سنجید؛
 * هدر Content-Length هم قابل‌اعتماد نیست (می‌تواند نباشد یا دروغ بگوید: Transfer-Encoding: chunked).
 * این تابع بدنه را به‌صورت جریانی می‌خواند، شمارش واقعی بایت‌ها را نگه می‌دارد و به‌محض عبور از سقف، جریان را
 * لغو می‌کند؛ پس مصرف حافظه همیشه O(سقف) است، نه O(داده‌ی مهاجم).
 */
export class BodyTooLargeError extends Error {
  constructor(public limit: number) {
    super(`حجم درخواست بیش از ${limit} بایت است`);
    this.name = "BodyTooLargeError";
  }
}

/** بدنه‌ی خام با سقف واقعی؛ در عبور از سقف BodyTooLargeError می‌دهد */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    void req.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(maxBytes);
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** جایگزین امن `await req.formData()` */
export async function readFormDataLimited(req: Request, maxBytes: number): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data|^application\/x-www-form-urlencoded/i.test(type)) throw new TypeError("نوع محتوا پشتیبانی نمی‌شود");
  const bytes = await readBodyLimited(req, maxBytes);
  return new Response(bytes as BodyInit, { headers: { "content-type": type } }).formData();
}
