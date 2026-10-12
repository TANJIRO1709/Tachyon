import type { CircuitState } from "@/lib/types";
import { STATE_WORD } from "./format";

/** Circuit state: colour, icon and word together, never colour alone. */
export function StateIcon({ state, size = 14 }: { state: CircuitState; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true } as const;
  if (state === "closed")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.6 8.2l2.2 2.2 4.6-4.8" fill="none" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === "open")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" />
    </svg>
  );
}

export function StateChip({ state }: { state: CircuitState }) {
  return (
    <span className="state" data-s={state}>
      <StateIcon state={state} />
      {STATE_WORD[state]}
    </span>
  );
}
