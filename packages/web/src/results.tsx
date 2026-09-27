import { useMemo, useState, type ReactNode } from "react";
import { checks as checkRegistry, fixes, registry, type Finding, type Group } from "@dcl-regenesislabs/wearable-validator";
import { limitFor } from "./limits.js";
import { MetadataValues } from "./metadata-values.js";
import { CODE_GROUPS, GROUP_LABELS, combinedVerdict, isRunning, renderingGroupShown, visualRows, visualVerdict, type CodeResult, type VisualState } from "./progress.js";
import { CheckAbout, FindingCard, RESULT_FILTERS, RuleColumns, SectionToggle, StatusChip, filterStatuses, headToggle, statusLabel } from "./rules.js";
import { RunView, type Sections } from "./run-view.js";
import { NONE_COLLAPSED, allCollapsed, collapseAll, expandAll, toggleSection } from "./sections.js";

/**
 * The results of one item — the verdict stamp, the filters, the code groups with their rule rows, then the visual
 * review card and the Rendering group. Validate feeds it the browser's own code run; History the run server's
 * saved gate, so both tabs read the same and never drift.
 */

const GROUP_INTROS: Record<Group, string> = {
  files: "The cheapest checks run first: the package's files, sizes, metadata and integrity — everything knowable without opening the 3D model.",
  model: "The 3D model itself: geometry budgets, textures, materials, skeleton and skinning — parsed from the GLB and measured exactly.",
  emote: "The animation data: length, clips, bone targets, root motion and sound — measured from the keyframes.",
  rendering: "Real renders reviewed against the thumbnail — rendered by the run server and streamed here as they happen.",
  content: "Deterministic content screening."
};
export const CODE_CHECK_COUNT = registry.filter((check) => check.group !== "rendering").length;

/** What the item itself can add to the rows: its metadata for the metadata row, its category for the limits shown. */
export interface ItemContext {
  metadata?: unknown;
  metadataSource?: string;
  category?: string;
  hides?: string[];
}

export interface ResultsProps {
  /** Prefix of the element ids the collapse toggles point at, unique per mounted results page. */
  scope: string;
  /** The code checks: the browser's run on Validate, the server's saved gate in History; null when an old run kept none. */
  result: CodeResult | null;
  visual: VisualState;
  aiChecks: string[];
  modelKnown: boolean;
  filter: string;
  onFilter: (key: string) => void;
  item?: ItemContext;
  /** A bare GLB: no verdict, only its model checks. */
  bare?: boolean;
  /** The visual review card and Rendering group are on the page (a run server is connected, or a run is open). */
  visualShown: boolean;
  onCancel?: () => void;
  onRunAgain?: () => void;
  /** What sits under the stepper before the run starts (the Validate tab's gate button). */
  gate?: ReactNode;
  footer?: ReactNode;
}

export function Results({ scope, result, visual, aiChecks, modelKnown, filter, onFilter, item, bare = false, visualShown, onCancel, onRunAgain, gate, footer }: ResultsProps) {
  const [collapsed, setCollapsed] = useState(NONE_COLLAPSED);
  const statuses = filterStatuses(filter);
  const rows = visualRows(visual);
  const codeRows = result?.checks ?? [];
  const findingsByCheck = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const finding of result?.findings ?? []) map.set(finding.check, [...(map.get(finding.check) ?? []), finding]);
    return map;
  }, [result]);

  const groups = CODE_GROUPS.map((group) => ({ group, rows: codeRows.filter((row) => row.group === group) })).filter(({ rows }) => rows.length > 0);
  const sectionKeys = [...groups.map(({ group }) => group), ...(visualShown ? ["visual", ...(renderingGroupShown(visual) ? ["rendering"] : [])] : [])];
  const sections: Sections = { scope, collapsed, toggle: (key) => setCollapsed((current) => toggleSection(current, key)) };
  const everyCollapsed = allCollapsed(collapsed, sectionKeys);
  const anyRow = codeRows.length > 0 || rows.length > 0;
  const nothingInView = anyRow && !codeRows.some((row) => statuses.includes(row.status)) && !rows.some((row) => statuses.includes(row.status));

  return (
    <>
      <Verdict result={result} visual={rows} visualPhase={visual.phase} bare={bare} reviewable={visualShown} />
      {bare && <p className="glb-scope">Results cover the uploaded GLB. Choose its type and category to check the right limits. Package metadata and publishing checks are not part of this analysis.</p>}
      <div className="rules-toolbar">
        <div>
          <h1>Rule results</h1>
          <p>Compare your values with the requirements. Open a rule for findings and fix steps.</p>
        </div>
        <div className="rules-tools">
          <div className="eui-seg" role="group" aria-label="Filter rule results">
            {RESULT_FILTERS.map((option) => {
              const total = codeRows.filter((row) => option.statuses.includes(row.status)).length + rows.filter((row) => option.statuses.includes(row.status)).length;
              return (
                <button key={option.key} type="button" className={`eui-seg-btn${filter === option.key ? " active" : ""}`} aria-pressed={filter === option.key} onClick={() => onFilter(option.key)}>
                  {option.label} <span className="ct">{total}</span>
                </button>
              );
            })}
          </div>
          {sectionKeys.length > 0 && (
            <button type="button" className="eui-link sections-action" onClick={() => setCollapsed(everyCollapsed ? expandAll() : collapseAll(sectionKeys))}>
              {everyCollapsed ? "Expand all" : "Collapse all"}
            </button>
          )}
        </div>
      </div>
      {result === null && visual.phase === "done" && <p className="quiet-line" role="status">Code checks were not saved for this run.</p>}
      {nothingInView && <p className="empty-results" role="status">No rules in this view. Choose All rules to see every result.</p>}
      {groups.map(({ group, rows: groupRows }, index) => {
        const shown = groupRows.filter((row) => statuses.includes(row.status));
        if (shown.length === 0) return null;
        const passed = groupRows.filter((row) => row.status === "passed").length;
        const notApplicable = registry.filter((check) => check.group === group).length - groupRows.length;
        const body = `${scope}-${group}-body`;
        const isCollapsed = collapsed.has(group);
        return (
          <section className="group" key={group} style={{ animationDelay: `${index * 0.05}s` }}>
            <div className="group-head collapsible" title={GROUP_INTROS[group]} onClick={headToggle(() => sections.toggle(group))}>
              <h2>{GROUP_LABELS[group]}</h2>
              <span className="tally">
                {passed}/{groupRows.length} passed{notApplicable > 0 && <> · {notApplicable} n/a</>}
              </span>
              <SectionToggle name={GROUP_LABELS[group]} controls={body} collapsed={isCollapsed} onToggle={() => sections.toggle(group)} />
            </div>
            <div id={body} hidden={isCollapsed}>
              <RuleColumns />
              <div className="group-list">
                {shown.map((row) => {
                  const findings = findingsByCheck.get(row.check) ?? [];
                  const def = checkRegistry[row.check];
                  const requirement = limitFor(row.check, item?.category, item?.hides);
                  const unavailable = row.status === "skipped" || row.status === "errored";
                  return (
                    <details className={`check ${row.status}`} key={row.check}>
                      <summary>
                        <span className="check-title">{def?.title ?? row.check}</span>
                        <span className={`rule-value${row.measured === undefined ? " unavailable" : ""}`}>
                          <span className="mobile-label">Your value</span>
                          {row.measured ?? (unavailable ? "Not measured" : "No measurement reported")}
                        </span>
                        <span className="rule-requirement">
                          <span className="mobile-label">Requirement</span>
                          {requirement ?? def?.describe ?? "—"}
                        </span>
                        <StatusChip status={row.status} label={statusLabel(row.status, findings)} />
                        <span className="rule-chevron" aria-hidden="true">›</span>
                      </summary>
                      <div className="check-body">
                        {row.status === "skipped" && <p className="skip-note">skipped — {row.skipReason}</p>}
                        {row.status === "errored" && <p className="skip-note">check crashed — {row.skipReason}</p>}
                        {findings.map((finding, i) => <FindingCard finding={finding} key={i} />)}
                        {(row.status === "failed" || row.status === "warning") && fixes[row.check] && (
                          <p className="fix-hint">
                            <span className="fix-label">How to fix</span>
                            {fixes[row.check]}
                          </p>
                        )}
                        {row.check === "metadata" && item && (item.metadata !== undefined || item.metadataSource) && (
                          <MetadataValues value={item.metadata} source={item.metadataSource ?? "Package metadata"} />
                        )}
                        <CheckAbout check={row.check} rule={def?.rule} collapsed={findings.length > 0 || row.check === "metadata"} />
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}
      {visualShown && <RunView state={visual} aiChecks={aiChecks} modelKnown={modelKnown} sections={sections} filter={filter} onCancel={onCancel} onRunAgain={onRunAgain} gate={gate} />}
      {footer}
    </>
  );
}

function Verdict({ result, visual, visualPhase, bare, reviewable }: { result: CodeResult | null; visual: ReturnType<typeof visualRows>; visualPhase: VisualState["phase"]; bare: boolean; reviewable: boolean }) {
  const visualErrors = visual.flatMap((row) => row.findings).filter((finding) => finding.severity === "error").length;
  const visualWarnings = visual.flatMap((row) => row.findings).filter((finding) => finding.severity === "warning").length;
  const errors = (result?.summary.errors ?? 0) + visualErrors;
  const warnings = (result?.summary.warnings ?? 0) + visualWarnings;
  // without a saved code result the rendering rows are all there is to judge
  const verdict = result ? combinedVerdict(result, visual) : visualVerdict(visual) === null ? "incomplete" : visualVerdict(visual) ? "passed" : "failed";
  let stamp: ReactNode;
  if (bare) stamp = <span className="stamp analysis">Model checks</span>;
  else if (verdict === "passed") stamp = <span className="stamp pass">Passed</span>;
  else if (verdict === "failed") stamp = <span className="stamp fail">Failed</span>;
  else stamp = <span className="stamp none">Incomplete</span>;
  const visualNote = !reviewable || bare ? null : visualPhase === "idle" ? "visual review not started" : isRunning(visualPhase) ? "visual review in progress" : visualPhase === "done" ? `${visual.length} visual ${visual.length === 1 ? "check" : "checks"}` : `visual review ${visualPhase}`;
  // a live run has not reached its gate yet; a finished run without a gate says so in the quiet line under the toolbar
  const codeNote: ReactNode = result ? (
    <>
      <span className="n">{result.summary.checked}</span> of {CODE_CHECK_COUNT} code checks apply
      {result.summary.skipped > 0 && <> · {result.summary.skipped} skipped</>}
    </>
  ) : isRunning(visualPhase) ? "code checks running" : visualPhase === "done" ? null : "code checks did not run";
  return (
    <div className="verdict">
      <div className="verdict-word">
        <span className="eui-overline">{bare ? "GLB analysis" : "Verdict"}</span>
        {stamp}
      </div>
      <div className="verdict-facts">
        <div>
          <span className={`n${errors ? " err" : ""}`}>{errors}</span> {errors === 1 ? "error" : "errors"} ·{" "}
          <span className={`n${warnings ? " wrn" : ""}`}>{warnings}</span> {warnings === 1 ? "warning" : "warnings"}
        </div>
        <div>
          {codeNote}
          {codeNote && visualNote && " · "}
          {visualNote}
        </div>
      </div>
    </div>
  );
}
