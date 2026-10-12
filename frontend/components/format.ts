export function ms(v: number | null | undefined, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return "–";
  if (digits != null) return v.toFixed(digits);
  if (v < 1) return v.toFixed(2);
  if (v < 10) return v.toFixed(1);
  return Math.round(v).toLocaleString();
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return `${(v * 100).toFixed(digits)}%`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export function duration(s: number): string {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export const STATE_WORD = { closed: "Closed", open: "Open", half_open: "Half-open" } as const;
