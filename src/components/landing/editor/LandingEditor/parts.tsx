"use client";

export function Confirm({ text, onYes, onNo }: { text: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
        <p className="text-sm font-bold leading-7">{text}</p>
        <div className="mt-5 flex gap-2"><button className="btn-danger flex-1" onClick={onYes}>بله، انجام شود</button><button className="btn-secondary flex-1" onClick={onNo}>انصراف</button></div>
      </div>
    </div>
  );
}
