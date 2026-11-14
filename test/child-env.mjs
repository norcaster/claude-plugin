/**
 * The environment a test gives a child process: what it needs to run, plus the test's own values.
 * Never a copy of the developer's whole environment, which can hold real credentials (and the Claude
 * plugin directory's scan holds a plugin that hands one to a process that can reach a server).
 */
export function childEnv(extra = {}) {
  const base = { PATH: process.env.PATH ?? "" };
  if (process.env.NORCASTER_CREDENTIAL_STORE) base.NORCASTER_CREDENTIAL_STORE = process.env.NORCASTER_CREDENTIAL_STORE;
  if (process.env.SYSTEMROOT) base.SYSTEMROOT = process.env.SYSTEMROOT; // Windows needs it to start Node
  return { ...base, ...extra };
}
