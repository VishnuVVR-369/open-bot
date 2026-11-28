/* global maestro, output */
// The automation's title, as typed, and as a pattern that matches only it: Maestro reads `text`
// as a regular expression, so a title with "(", "." or "+" in it is escaped first.
output.title = maestro.copiedText;
output.titlePattern = maestro.copiedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
