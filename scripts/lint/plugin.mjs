// The repository's own lint rules as one ESLint plugin, registered as `open-bot`. ESLint refuses
// two different objects under one plugin name, so eslint.config.mjs and the tests share this one.
import tableOwners from "./table-owners.mjs";
import workspaceImports from "./workspace-imports.mjs";

export default { rules: { ...tableOwners.rules, ...workspaceImports.rules } };
