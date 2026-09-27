import type { MouseEvent, ReactNode } from "react";
import { details, docsUrl, explanations, sourceLinks, type CheckStatus, type Finding } from "@dcl-regenesislabs/wearable-validator";

/** The words and small pieces every rule row shares — the code groups on Validate and the rendering rows of a run. */

export const STATUS_LABELS: Record<CheckStatus, string> = {
  passed: "Passed",
  failed: "Needs fixing",
  warning: "Review",
  skipped: "Not checked",
  errored: "Check error"
};

const GLYPHS: Record<CheckStatus, string> = { passed: "✓", failed: "✕", warning: "!", skipped: "○", errored: "‼" };

/** dcl-editor Chip tones for a check status; `warn` is this site's amber tone (the editor has none). */
const CHIP_TONES: Record<CheckStatus, string> = { passed: "live", failed: "danger", warning: "warn", skipped: "soon", errored: "danger" };

export const RESULT_FILTERS: { key: string; label: string; statuses: CheckStatus[] }[] = [
  { key: "all", label: "All rules", statuses: ["passed", "failed", "warning", "skipped", "errored"] },
  { key: "attention", label: "Needs attention", statuses: ["failed", "warning", "errored"] },
  { key: "passed", label: "Passed", statuses: ["passed"] },
  { key: "unchecked", label: "Not checked", statuses: ["skipped"] }
];

export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A failing rule says how many problems it holds, so the list adds up to the verdict's totals. */
export function statusLabel(status: CheckStatus, findings: Finding[]): string {
  const count = findings.filter((finding) => finding.severity === (status === "failed" ? "error" : "warning")).length;
  if ((status === "failed" || status === "warning") && count > 0) return plural(count, status === "failed" ? "error" : "warning");
  return STATUS_LABELS[status];
}

export const filterStatuses = (key: string): CheckStatus[] => (RESULT_FILTERS.find((option) => option.key === key) ?? RESULT_FILTERS[0]).statuses;

export function StatusChip({ status, label, busy }: { status: CheckStatus; label?: string; busy?: boolean }) {
  return (
    <span className={`eui-ds-chip ${CHIP_TONES[status]} status-chip`}>
      {busy ? <Spinner size="xs" decorative /> : <span className="ico" aria-hidden="true">{GLYPHS[status]}</span>}
      <span className="txt">{label ?? STATUS_LABELS[status]}</span>
    </span>
  );
}

/** dcl-editor Spinner: the class alone sizes it. Decorative inside a live region, so the region is read once. */
export function Spinner({ size = "sm", decorative = false, label = "Loading" }: { size?: "xs" | "sm" | "md" | "lg" | "xl"; decorative?: boolean; label?: string }) {
  return (
    <span className={`eui-ds-spinner ${size}`} role={decorative ? undefined : "status"} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}>
      <svg viewBox="0 0 50 50">
        <circle className="track" cx="25" cy="25" r="20" fill="none" strokeWidth="5" />
        <circle className="arc" cx="25" cy="25" r="20" fill="none" strokeWidth="5" strokeLinecap="round" strokeDasharray="90 160" />
      </svg>
    </span>
  );
}

/** dcl-editor's tree caret: the twisty around it rotates it from "closed" (right) to "open" (down). */
function Caret() {
  return (
    <svg width="8" height="8" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4 2.5L8.5 6L4 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A collapsible header row: the whole row toggles, except its own buttons and links; the chevron stays the keyboard control. */
export function headToggle(onToggle: () => void): (event: MouseEvent<HTMLElement>) => void {
  return (event) => {
    if ((event.target as Element).closest("button, a, input, select, summary")) return;
    onToggle();
  };
}

/** The collapse toggle in a section header: a real button beside the clickable row, the body it hides keeps the header's tally. */
export function SectionToggle({ name, controls, collapsed, onToggle }: { name: string; controls: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="eui-btn icon section-toggle" aria-expanded={!collapsed} aria-controls={controls} aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`} onClick={onToggle}>
      <span className={`twisty${collapsed ? "" : " open"}`}><Caret /></span>
    </button>
  );
}

export function RuleColumns() {
  return (
    <div className="rule-columns" aria-hidden="true">
      <span>Rule</span><span>Your value</span><span>Requirement</span><span>Status</span><span />
    </div>
  );
}

export function FindingCard({ finding, children }: { finding: Finding; children?: ReactNode }) {
  return (
    <div className={`finding ${finding.severity}`}>
      <p className="msg">{finding.message}</p>
      {(finding.where || finding.measured !== undefined || children) && (
        <div className="meta">
          {finding.where && <span>{finding.where}</span>}
          {finding.measured !== undefined && (
            <span>
              measured <span className="ml">{String(finding.measured)}</span>
              {finding.limit !== undefined && <> / limit <span className="ml">{String(finding.limit)}</span></>}
            </span>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

export function CheckAbout({ check, rule, collapsed }: { check: string; rule?: string; collapsed: boolean }) {
  const body = (
    <>
      <p className="explain">{explanations[check]}</p>
      {details[check] && <p className="how">{details[check]}</p>}
      <div className="about-meta">
        <span>{check} · {rule}</span>
        <a href={docsUrl(check)} target="_blank" rel="noreferrer">docs ↗</a>
        <a href={sourceLinks[check]} target="_blank" rel="noreferrer">source ↗</a>
      </div>
    </>
  );
  if (!collapsed) return <div className="about">{body}</div>;
  return (
    <details className="about">
      <summary>About this check</summary>
      {body}
    </details>
  );
}

/** dcl-editor Notice: an inline note that owns its own spacing. `attention` asks for a look; it never reports a fault. */
export function Notice({ tone = "info", role, children }: { tone?: "info" | "attention"; role?: "alert" | "status"; children: ReactNode }) {
  return (
    <div className={`eui-ds-notice${tone === "attention" ? " attention" : ""}`} role={role}>
      <div className="body">{children}</div>
    </div>
  );
}

/** dcl-editor StateBlock: a whole-surface state (empty history, a missing run). */
export function StateBlock({ tone = "neutral", icon, headline, note, children }: { tone?: "neutral" | "success" | "error"; icon?: ReactNode; headline: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="eui-ds-state">
      {icon !== undefined && <div className={`eui-ds-state-icon${tone === "neutral" ? "" : ` ${tone}`}`}>{icon}</div>}
      <p className="eui-ds-state-t">{headline}</p>
      {note !== undefined && <p className="eui-ds-state-note">{note}</p>}
      {children}
    </div>
  );
}
