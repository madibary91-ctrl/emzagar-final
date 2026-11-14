import Link from "next/link";

export interface BrandProps {
  light?: boolean;
  href?: string;
  name?: string;
  logoUrl?: string | null;
  tagline?: string;
}

const DEFAULT_NAME = "امضاگیر";

export function Brand({ light = false, href = "/", name = DEFAULT_NAME, logoUrl = null, tagline }: BrandProps) {
  // برای نام پیش‌فرض، شعار انگلیسی قدیمی؛ برای برند اختصاصی فقط شعار انتخابی مدیر
  const sub = tagline !== undefined && tagline !== "" ? tagline : name === DEFAULT_NAME ? "EMZAGAR / SIGN FLOW" : "";
  return (
    <Link href={href} className="inline-flex items-center gap-3" aria-label={`${name}${sub ? ` ${sub}` : ""}، صفحه نخست`}>
      {logoUrl ? (
        <span className="grid h-10 w-10 place-items-center overflow-hidden rounded-[13px] bg-white p-1 ring-1 ring-black/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoUrl} alt="" className="h-full w-full object-contain" />
        </span>
      ) : (
        <span className={`grid h-10 w-10 place-items-center rounded-[13px] ${light ? "bg-mint text-ink" : "bg-ink text-mint"}`}>
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <path d="M4 16.5C7.4 10.2 8.2 7.8 9.2 8.7C10.5 9.9 6.4 18.5 10.2 15.1C13 12.5 13.6 10.1 14.1 11.4C14.8 13.2 12.8 17.1 16 14.7L21.5 9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 21H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
      )}
      <span className="leading-none">
        <span className={`block max-w-[150px] truncate text-[20px] font-black tracking-tight ${light ? "text-white" : "text-ink"}`}>{name}</span>
        {sub && <span className={`mt-1 block max-w-[150px] truncate text-[9px] font-medium tracking-[.12em] ${light ? "text-white/65" : "text-ink/72"}`}>{sub}</span>}
      </span>
    </Link>
  );
}
