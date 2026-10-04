// How a check-in issue reads as the repair done ("Battery Issue" ->
// "Battery Replacement"), wherever a repair is named to a client or on the
// books: invoice lines and Account tab deposits. Keep in sync with
// assets/intake.js ISSUE_INVOICE_LABEL.
const ISSUE_REPAIR_LABEL = {
  "Screen Cracked / Broken": "Screen Replacement",
  "Battery Issue": "Battery Replacement",
  "Charging Port": "Charging Port Replacement",
  "Won't Power On": "Power Issue Repair",
  "Water Damage": "Water Damage Repair",
  "Camera Issue": "Camera Repair",
  "Speaker / Mic Issue": "Speaker / Mic Repair",
  "Back Glass Cracked": "Back Glass Replacement",
  "Software Issue": "Software Repair",
  "Diagnostic Needed": "Diagnostic",
};

/** "Battery Issue, Other: Housing" -> ["Battery Replacement", "Housing"]. */
export function repairLabels(issues) {
  return String(issues || "")
    .split(",")
    .map((issue) => issue.trim())
    .filter(Boolean)
    .map((issue) => (issue.startsWith("Other:") ? issue.slice(6).trim() : ISSUE_REPAIR_LABEL[issue] || issue))
    .filter(Boolean);
}
