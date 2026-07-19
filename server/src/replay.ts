// @aso/server — replay of run state from durable logs (D7, "honest closure").
//
// On instance restart the orchestrator's internal state is reconstructed NOT from the
// runs.state snapshot, but by RE-RUNNING the deterministic pipeline where ALL external
// side effects are fed from persisted logs:
//   • LLM  — from llm_steps (last valid attempt of the logical step; the provider is NOT called);
//   • Apple — from apple_cache (network-wide cache of raw data).
// The first log miss = the "frontier" of durable history: beyond it the run was never recorded,
// so replay stops and state lands exactly on the resumable boundary. A live resume afterwards
// makes real (billable/network) calls from the frontier — no double COGS/fetch.
export class ReplayFrontier extends Error {
  constructor(public where: string) {
    super(`replay frontier: ${where}`);
    this.name = "ReplayFrontier";
  }
}
