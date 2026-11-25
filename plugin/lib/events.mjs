/** Normalise an EnforcementEventItem into the compact shape the plugin shows and stores. */
export function normalizeEvent(e) {
  const c = e?.contextual && typeof e.contextual === "object" ? e.contextual : {};
  const violations = Array.isArray(e?.violations) ? e.violations : [];
  const fwd = e?.forwarding && typeof e.forwarding === "object" ? e.forwarding : null;
  const str = (v) => (typeof v === "string" ? v : undefined);
  return {
    event_id: str(e?.event_id),
    request_id: str(e?.request_id),
    // `action_taken` is the enforcement outcome; `action` on the item is the action-gateway payload, not an outcome.
    action: String(e?.action_taken ?? ""),
    severity: str(e?.severity),
    created_at: String(e?.created_at ?? ""),
    policy_version: str(e?.policy_version),
    policy_pack: str(c.policy_pack),
    detection_types: Array.isArray(c.detection_types) ? c.detection_types.filter((x) => typeof x === "string") : undefined,
    detection_origin: str(c.detection_origin),
    notice: str(c.developer_notice),
    rules: violations
      .map((v) => v?.rule ?? v?.rule_id ?? v?.type ?? v?.name)
      .filter((x) => typeof x === "string")
      .slice(0, 5),
    forwarding: fwd
      ? {
          can_approve: Boolean(fwd.can_approve),
          state: str(fwd.state),
          expires_at: str(fwd.expires_at),
          unavailable_reason: str(fwd.unavailable_reason),
        }
      : undefined,
  };
}

export function isNoteworthy(n) {
  return n.action === "blocked" || n.action === "redacted" || n.action === "redact";
}

/** The one-line explanation the VS Code Companion shows; history-origin blocks get their own wording. */
export function headlineFor(noteworthy) {
  const history = noteworthy.filter((n) => n.action === "blocked" && n.detection_origin === "history");
  if (history.length > 0) {
    const n = history.length;
    return n > 1
      ? `${n} blocks share one root cause: a detection still in this conversation's history. Start a new conversation to continue; editing your latest message cannot clear it.`
      : "This block is from an earlier message still in the conversation history. Start a new conversation to continue; editing your latest message cannot clear it.";
  }
  const blocked = noteworthy.filter((n) => n.action === "blocked").length;
  const redacted = noteworthy.length - blocked;
  const parts = [];
  if (blocked) parts.push(`${blocked} blocked`);
  if (redacted) parts.push(`${redacted} redacted`);
  const firstNotice = noteworthy.find((n) => n.notice)?.notice;
  return (
    firstNotice ||
    `${parts.join(", ") || "1 blocked"} request${noteworthy.length > 1 ? "s" : ""} at the gateway. This is the policy boundary working, not a network error.`
  );
}
