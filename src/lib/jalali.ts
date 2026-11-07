const dateFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Asia/Tehran",
});
const dateTimeFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Tehran",
});

export function fa(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return dateFmt.format(new Date(date));
}

export function faTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return dateTimeFmt.format(new Date(date));
}

export function faNum(n: number): string {
  return new Intl.NumberFormat("fa-IR").format(n);
}
