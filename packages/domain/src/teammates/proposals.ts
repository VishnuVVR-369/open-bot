import { lineDiff, type DiffLine } from "../text/diff";

/**
 * What accepting a teammate's suggested instructions would change, against the instructions as
 * they are now: those may have changed since the teammate made its suggestion.
 */
export function instructionsChange(
  proposal: { current: string; proposed: string },
  instructionsNow: string,
): { lines: DiffLine[]; editedSince: boolean } {
  return {
    lines: lineDiff(instructionsNow, proposal.proposed),
    editedSince: instructionsNow !== proposal.current,
  };
}
