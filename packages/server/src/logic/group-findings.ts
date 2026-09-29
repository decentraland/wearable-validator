/** Findings that differ only in which body shape's file they name, told once: pure, for the Slack message and the approval line. */
import type { Finding } from "@dcl-regenesislabs/wearable-validator";

export interface FindingGroup {
  finding: Finding;
  /** The first finding's message, naming its file without the body-shape folder when the group spans several. */
  message: string;
  /** The body-shape folders (male, female) the group spans; empty when it came from one. */
  shapes: string[];
  count: number;
}

// `"male/shirt.glb" › Albedo` or `male/shirt.glb`: the folder is the path's first segment, inside the quotes if any
const FOLDER = /^("?)([^/"]+)\/(.*)$/s;

/** The finding with its `where` rid of the folder, in the message too; untouched when it names no folder. */
function withoutFolder(finding: Finding): { folder?: string; where: string; message: string } {
  const where = finding.where ?? "";
  const match = FOLDER.exec(where);
  if (!match) return { where, message: finding.message };
  const rest = `${match[1]}${match[3]}`;
  return { folder: match[2], where: rest, message: finding.message.split(where).join(rest) };
}

/** Same check, severity, file and message once the folder is set aside: in order of first appearance. */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, { message: string; members: Finding[]; folders: Set<string> }>();
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
