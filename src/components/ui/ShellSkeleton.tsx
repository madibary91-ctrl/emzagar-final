/** اسکلت بارگذاری هم‌شکل با Shell (سایدبار + هدر + محتوا) برای جلوگیری از پرش چیدمان */
export default function ShellSkeleton() {
  return (
    <div className="min-h-screen bg-paper" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">در حال بارگذاری…</span>
      <aside aria-hidden="true" className="fixed inset-y-0 right-0 hidden w-[252px] flex-col gap-3 border-l border-ink/10 bg-[#f9faf6] p-5 lg:flex">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="skeleton h-10 w-10 !rounded-[13px]" />
          <div className="skeleton h-5 w-24" />
        </div>
        <div className="mt-4 space-y-2">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-2.5 py-1.5">
              <div className="skeleton h-8 w-8 !rounded-lg" />
              <div className="skeleton h-4 flex-1" style={{ maxWidth: `${55 + ((i * 17) % 35)}%` }} />
            </div>
          ))}
        </div>
      </aside>
      <div className="lg:mr-[252px]">
        <div aria-hidden="true" className="flex h-[70px] items-center justify-between border-b border-ink/10 px-4 sm:px-7">
          <div className="space-y-2">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton hidden h-3 w-48 sm:block" />
          </div>
          <div className="flex gap-2">
            <div className="skeleton h-10 w-10" />
            <div className="skeleton h-10 w-28" />
          </div>
        </div>
        <div aria-hidden="true" className="mx-auto max-w-6xl space-y-5 p-4 sm:p-7">
          <div className="space-y-2">
            <div className="skeleton h-8 w-56" />
            <div className="skeleton h-3 w-80 max-w-full" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="panel-solid flex items-center gap-4 p-5">
                <div className="skeleton h-12 w-12 !rounded-2xl" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-5 w-16" />
                  <div className="skeleton h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
          <div className="panel-solid space-y-4 p-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="skeleton h-4 w-4" />
                <div className="skeleton h-4 flex-1" />
                <div className="skeleton hidden h-4 w-24 md:block" />
                <div className="skeleton h-6 w-20 !rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
