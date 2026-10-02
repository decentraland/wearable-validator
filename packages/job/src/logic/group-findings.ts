/** Findings that differ only in which body shape's file they name, told once: pure, for the Slack message. */

interface GroupableFinding {
  check: string;
  severity: string;
  message: string;
  where?: string;
}

export interface FindingGroup<F extends GroupableFinding> {
  finding: F;
  /** The first finding's message, naming its file without the body-shape folder when the group spans several. */
  message: string;
  /** The body-shape folders (male, female) the group spans; empty when it came from one. */
  shapes: string[];
  count: number;
}

// `"male/shirt.glb" › Albedo` or `male/shirt.glb`: the file is the path up to a closing quote or a " › " part, and its
// folder is the path's first segment
const FILE = /^"?([^"]+?)"?(?: › .*)?$/s;

/**
 * The finding with its body-shape folder set aside: `male/shirt.glb` becomes `shirt.glb` in `where` and wherever the
 * message names the file, however the check worded it. Untouched when it names no folder.
 */
function withoutFolder(finding: GroupableFinding): { folder?: string; where: string; message: string } {
  const where = finding.where ?? "";
  const file = FILE.exec(where)?.[1];
  const slash = file?.indexOf("/") ?? -1;
  if (!file || slash <= 0) return { where, message: finding.message };
  const folder = file.slice(0, slash);
  const bare = file.slice(slash + 1);
  return { folder, where: where.split(file).join(bare), message: finding.message.split(file).join(bare) };
}

/** Same check, severity, file and message once the folder is set aside: in order of first appearance. */
export function groupFindings<F extends GroupableFinding>(findings: F[]): FindingGroup<F>[] {
  const groups = new Map<string, { message: string; members: F[]; folders: Set<string> }>();
  for (const finding of findings) {
    const bare = withoutFolder(finding);
    const key = [finding.check, finding.severity, bare.where, bare.message].join("\n");
    const group = groups.get(key) ?? { message: bare.message, members: [], folders: new Set<string>() };
    group.members.push(finding);
    if (bare.folder) group.folders.add(bare.folder);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ message, members, folders }) => {
    const spans = folders.size > 1;
    return { finding: members[0], message: spans ? message : members[0].message, shapes: spans ? [...folders] : [], count: members.length };
  });
}
