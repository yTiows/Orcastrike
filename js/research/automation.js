// Automation ladder and permission controller (pure + a small controller class).
// P0: execution is default OFF, no mode or theme grants it, UMBRA's "unproven edge" override
// never unlocks L2/L3. L2/L3 also need a VERIFIED execution API; none exists in this build
// (DATA_SOURCE_MATRIX #19/#20), so no real executor ships. The controller's STOP/kill-switch
// logic is exercised in tests with a SYNTHETIC mock executor only.
//
//   L0 alert only · L1 stage (external link, no submission) · L2 user-approved execution ·
//   L3 narrowly automated execution (CSFloat balance only), incl. auto-reprice with a floor.

export const LEVELS = Object.freeze(["L0", "L1", "L2", "L3"]);
export const EXECUTION_API_VERIFIED = false;
export const L3_CONFIRMATION_PHRASE = "I accept automated execution on CSFloat balance";
export const REQUIRED_LIMITS = Object.freeze(["per_item_cents", "per_day_cents", "total_exposure_cents", "max_concurrent_orders", "max_loss_cents"]);

const rank = (l) => LEVELS.indexOf(l);

export function levelAvailability(level, { executionApiVerified = EXECUTION_API_VERIFIED } = {}) {
  if (level === "L0" || level === "L1") return { available: true };
  if (!executionApiVerified) return { available: false, reason: "UNVERIFIED: no verified execution API (DATA_SOURCE_MATRIX #19/#20); not implemented" };
  return { available: true };
}

function limitsComplete(limits) {
  return Boolean(limits) && REQUIRED_LIMITS.every((k) => Number.isSafeInteger(limits[k]) && limits[k] > 0);
}

// request: { action: "alert" | "stage" | "execute" | "reprice", approvedByUser?, dataState?, amountCents?, floorCents? }
// state:   { level, killSwitch: { engaged }, umbra: { active, unproven }, strategyValidated,
//            limits, confirmation, usage: { day_cents, open_orders, exposure_cents, day_loss_cents } }
export function permissionDecision(request, state, { executionApiVerified = EXECUTION_API_VERIFIED } = {}) {
  const deny = (reason) => ({ allowed: false, reason });
  if (request.action === "alert") return { allowed: true };
  if (state.killSwitch?.engaged) return deny("kill switch engaged");
  if (request.action === "stage") {
    if (rank(state.level) >= 1 || state.umbra?.active) return { allowed: true };
    return deny("staging needs automation level L1 or UMBRA autopilot");
  }
  if (request.action !== "execute" && request.action !== "reprice") return deny(`unknown action ${request.action}`);
  if (state.umbra?.unproven) return deny('UMBRA "unproven edge" override never unlocks L2/L3');
  const needed = request.action === "reprice" ? "L3" : "L2";
  if (rank(state.level) < rank(needed)) return deny(`automation level ${state.level} < ${needed}`);
  const avail = levelAvailability(state.level, { executionApiVerified });
  if (!avail.available) return deny(avail.reason);
  if (request.dataState !== "COMPLETE") return deny(`data state ${request.dataState ?? "unknown"} (stale or incomplete data → STOP)`);
  if (state.level === "L2") return request.approvedByUser === true ? { allowed: true } : deny("L2 requires explicit approval of this transaction");
  // L3
  if (!state.strategyValidated) return deny("L3 requires STRATEGY_VALIDATION");
  if (state.confirmation !== L3_CONFIRMATION_PHRASE) return deny("L3 requires the typed confirmation phrase");
  if (!limitsComplete(state.limits)) return deny(`L3 requires user hard limits: ${REQUIRED_LIMITS.join(", ")}`);
  const u = state.usage ?? { day_cents: 0, open_orders: 0, exposure_cents: 0, day_loss_cents: 0 };
  const amt = request.amountCents ?? 0;
  if (amt > state.limits.per_item_cents) return deny("per-item limit");
  if (u.day_cents + amt > state.limits.per_day_cents) return deny("per-day limit");
  if (u.exposure_cents + amt > state.limits.total_exposure_cents) return deny("total exposure limit");
  if (u.open_orders + 1 > state.limits.max_concurrent_orders) return deny("max concurrent orders");
  if (u.day_loss_cents >= state.limits.max_loss_cents) return deny("max loss reached");
  if (request.action === "reprice" && !(Number.isSafeInteger(request.floorCents) && request.floorCents > 0)) return deny("auto-reprice needs a floor price");
  return { allowed: true };
}

// Wraps an executor. Any API failure, stale data or unexpected response → STOP: the kill switch
// is engaged (persisted through setKillSwitch) and nothing further runs until a human resets it.
export class AutomationController {
  constructor({ executor, getState, setKillSwitch, log = () => {}, executionApiVerified = EXECUTION_API_VERIFIED }) {
    Object.assign(this, { executor, getState, setKillSwitch, log, executionApiVerified });
  }

  async stop(reason) {
    await this.setKillSwitch({ engaged: true, at: new Date().toISOString(), reason });
    this.log("STOP", reason);
    return { status: "STOPPED", reason };
  }

  async act(request) {
    const state = this.getState();
    const d = permissionDecision(request, state, { executionApiVerified: this.executionApiVerified });
    if (!d.allowed) {
      if (request.action === "execute" || request.action === "reprice") {
        if (/data state/.test(d.reason)) return this.stop(d.reason);
      }
      return { status: "DENIED", reason: d.reason };
    }
    if (request.action === "alert" || request.action === "stage") return { status: "OK", action: request.action };
    if (!this.executor) return this.stop("no executor available");
    let res;
    try {
      res = await this.executor[request.action](request);
    } catch (err) {
      return this.stop(`API failure: ${err?.message ?? "error"}`);
    }
    const expected = res && typeof res === "object" && res.status === "ACCEPTED" && typeof res.order_id === "string" && Number.isSafeInteger(res.amount_cents) && res.amount_cents === request.amountCents;
    if (!expected) return this.stop("unexpected API response");
    return { status: "EXECUTED", order_id: res.order_id };
  }
}
