/* global maestro, output */
// The copied text (an automation's title, a teammate's job), as typed, and as a pattern that
// matches only it: Maestro reads `text` as a regular expression, so text with "(", "." or "+" in
// it is escaped first.
output.title = maestro.copiedText;
output.titlePattern = maestro.copiedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
