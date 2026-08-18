const ACTION_REFERENCE = /^\s*(?:-\s+)?uses:\s+([^\s#]+)/;
const IMMUTABLE_ACTION_REFERENCE = /@[0-9a-f]{40}$/;

export function mutableActionReferences(workflow: string): string[] {
  const references: string[] = [];

  for (const line of workflow.split("\n")) {
    const action = line.match(ACTION_REFERENCE)?.[1];
    if (
      action !== undefined &&
      !action.startsWith("./") &&
      !IMMUTABLE_ACTION_REFERENCE.test(action)
    ) {
      references.push(action);
    }
  }

  return references;
}
