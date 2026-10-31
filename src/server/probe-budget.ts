import type { AppSettings } from "../shared/types.js";
import {
  BudgetError,
  BudgetManager,
  type BudgetStore,
  type Reservation,
} from "./budget.js";
import { Store } from "./store.js";

const BUDGET = "ai-budget";
const STATE = "ai-budget-state";
const OWNERS = "ai-probe-requests";
const OWNER = "verify-api";
type BudgetFields = Pick<
  AppSettings,
  | "monthlyLimit"
  | "creditAmount"
  | "creditStartsAt"
  | "creditExpiresAt"
  | "creditConfirmed"
>;
type Ownership = { id: string; owner: typeof OWNER };

function validate(record: Reservation): void {
  if (
    !record ||
    typeof record.id !== "string" ||
    !record.id ||
    !["reserved", "ambiguous", "settled", "released"].includes(record.status) ||
    !Number.isSafeInteger(record.reservedMicros) ||
    record.reservedMicros <= 0 ||
    (record.actualMicros !== undefined &&
      (!Number.isSafeInteger(record.actualMicros) ||
        record.actualMicros < 0)) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    (record.completedAt !== undefined &&
      !Number.isFinite(Date.parse(record.completedAt)))
  )
    throw new BudgetError("Invalid probe budget record; request not sent");
}

function sameRequest(a: Reservation, b: Reservation): boolean {
  return (
    a.id === b.id &&
    a.category === b.category &&
    a.model === b.model &&
    a.endpoint === b.endpoint &&
    a.createdAt === b.createdAt &&
    a.reservedMicros === b.reservedMicros
  );
}

function cost(record: Reservation): number {
  validate(record);
  return record.status === "released"
    ? 0
    : record.status === "settled"
      ? (record.actualMicros ?? record.reservedMicros)
      : record.reservedMicros;
}

/**
 * Production SQLite owns every reservation, its probe membership, and the global
 * overrun block. Prompts, audit payloads and synthetic financial records remain
 * isolated. No network operation belongs inside atomic().
 */
export class ProbeBudgetStore implements BudgetStore {
  constructor(
    private production: Store,
    private isolated: Store,
    readonly limitMicros: number,
    private now: () => Date = () => new Date(),
  ) {
    if (
      !Number.isSafeInteger(limitMicros) ||
      limitMicros <= 0 ||
      limitMicros > 20_000_000
    )
      throw new BudgetError("Probe limit must be positive and at most USD 20");
    if (
      production === isolated ||
      (production.file === isolated.file && production.file !== ":memory:")
    )
      throw new BudgetError("Synthetic records require a separate database");
    this.importLegacy();
  }

  budgetFields(): BudgetFields {
    // Deliberately project only budget admission fields: never load holdings,
    // transactions, the full settings JSON, or the production API switch.
    const row = this.production.db
      .prepare(
        "SELECT json_extract(value,'$.monthlyLimit') AS monthlyLimit, json_extract(value,'$.creditAmount') AS creditAmount, json_extract(value,'$.creditStartsAt') AS creditStartsAt, json_extract(value,'$.creditExpiresAt') AS creditExpiresAt, json_extract(value,'$.creditConfirmed') AS creditConfirmed FROM records WHERE namespace='settings' AND key='app'",
      )
      .get() as
      | (Omit<BudgetFields, "creditConfirmed"> & { creditConfirmed: number })
      | undefined;
    if (
      !row ||
      ![
        row.monthlyLimit,
        row.creditAmount,
        row.creditStartsAt,
        row.creditExpiresAt,
      ].every((value) => typeof value === "string") ||
      ![0, 1].includes(row.creditConfirmed)
    )
      throw new BudgetError(
        "Confirmed production budget configuration is required",
      );
    return { ...row, creditConfirmed: row.creditConfirmed === 1 };
  }

  private importLegacy(): void {
    this.production.atomic(() => {
      for (const { key, value: legacy } of this.isolated.entries<Reservation>(
        BUDGET,
      )) {
        validate(legacy);
        if (key !== legacy.id)
          throw new BudgetError("Legacy probe request ID mismatch");
        const previous = this.production.get<Reservation>(BUDGET, key);
        let selected = legacy;
        if (previous) {
          validate(previous);
          if (
            !sameRequest(previous, legacy) ||
            (previous.status === "settled" &&
              legacy.status === "settled" &&
              cost(previous) !== cost(legacy))
          )
            throw new BudgetError(
              "Conflicting legacy probe expense; reconcile before sending",
            );
          // Never downgrade a known settlement to an old ambiguous/reserved copy.
          if (
            previous.status === "settled" ||
            (legacy.status !== "settled" &&
              previous.status !== "released" &&
              (previous.status === "ambiguous" ||
                legacy.status !== "ambiguous"))
          )
            selected = previous;
        }
        const ownership = this.production.get<Ownership>(OWNERS, key);
        if (ownership && (ownership.id !== key || ownership.owner !== OWNER))
          throw new BudgetError("Conflicting probe request ownership");
        this.production.put(BUDGET, key, selected);
        this.production.put(OWNERS, key, { id: key, owner: OWNER });
        if (
          selected.status === "settled" &&
          cost(selected) > selected.reservedMicros
        )
          this.production.put(STATE, "blocked", true);
      }
      if (this.isolated.get(STATE, "blocked"))
        this.production.put(STATE, "blocked", true);
    });
  }

  records(): Reservation[] {
    return this.production.list<Ownership>(OWNERS).map((ownership) => {
      if (ownership.owner !== OWNER)
        throw new BudgetError(
          "Unknown probe ownership; reconcile before sending",
        );
      const record = this.production.get<Reservation>(BUDGET, ownership.id);
      if (!record || record.id !== ownership.id)
        throw new BudgetError(
          "Missing shared probe reservation; request not sent",
        );
      validate(record);
      return record;
    });
  }

  accountedMicros(): number {
    const total = this.records().reduce((sum, record) => sum + cost(record), 0);
    if (!Number.isSafeInteger(total))
      throw new BudgetError("Invalid probe total");
    return total;
  }

  owns(id: string): boolean {
    const ownership = this.production.get<Ownership>(OWNERS, id);
    return ownership?.id === id && ownership.owner === OWNER;
  }

  get<T>(namespace: string, key: string): T | undefined {
    if (namespace === BUDGET || namespace === STATE)
      return this.production.get<T>(namespace, key);
    const value = this.isolated.get<T>(namespace, key);
    if (namespace === "settings" && key === "app" && value)
      return { ...value, ...this.budgetFields() };
    return value;
  }

  list<T>(namespace: string): T[] {
    return (
      namespace === BUDGET || namespace === STATE
        ? this.production
        : this.isolated
    ).list<T>(namespace);
  }

  atomic<T>(fn: () => T): T {
    // The shared transaction commits before reserve() returns and before POST.
    // An isolated audit failure may omit evidence, but cannot release a committed
    // production reservation. There is no cross-database expense reconciliation.
    return this.production.atomic(() => this.isolated.atomic(fn));
  }

  put(namespace: string, key: string, value: unknown): void {
    if (namespace !== BUDGET && namespace !== STATE) {
      this.isolated.put(namespace, key, value);
      return;
    }
    this.production.atomic(() => {
      if (namespace === STATE) {
        // A probe can set the global overrun latch, never clear it.
        if (key !== "blocked" || value !== true)
          throw new BudgetError("Probe cannot clear shared budget protection");
        this.production.put(namespace, key, true);
        return;
      }
      const proposed = value as Reservation;
      validate(proposed);
      if (key !== proposed.id)
        throw new BudgetError("Probe request ID mismatch");
      const existing = this.production.get<Reservation>(BUDGET, key);
      if (!existing) {
        if (proposed.status !== "reserved")
          throw new BudgetError(
            "Probe request requires a committed reservation",
          );
        if (this.accountedMicros() + proposed.reservedMicros > this.limitMicros)
          throw new BudgetError(
            "Lifetime probe hard limit exhausted; request not sent",
          );
        // Re-run the canonical admission policy with the latest production
        // fields under BEGIN IMMEDIATE. This check-only view does not persist its
        // temporary generated ID; the original request ID is stored below.
        const admission: BudgetStore = {
          get: this.production.get.bind(this.production),
          list: this.production.list.bind(this.production),
          atomic: this.production.atomic.bind(this.production),
          put: (ns, _id, candidate) => {
            if (
              ns !== BUDGET ||
              (candidate as Reservation).status !== "reserved"
            )
              throw new BudgetError("Unexpected admission operation");
          },
        };
        new BudgetManager(admission, this.now).reserve(
          { ...this.budgetFields(), apiEnabled: true } as AppSettings,
          {
            model: proposed.model,
            endpoint: proposed.endpoint,
            category: proposed.category,
            reservedMicros: proposed.reservedMicros,
          },
        );
        this.production.put(OWNERS, key, { id: key, owner: OWNER });
      } else {
        if (!this.owns(key) || !sameRequest(existing, proposed))
          throw new BudgetError(
            "Probe cannot modify another request's expense",
          );
        if (existing.status === "settled") {
          if (
            proposed.status !== "settled" ||
            cost(existing) !== cost(proposed)
          )
            throw new BudgetError("Probe cannot downgrade a settled expense");
          return;
        }
        if (
          existing.status === "ambiguous" &&
          !["ambiguous", "settled"].includes(proposed.status)
        )
          throw new BudgetError(
            "Uncertain probe reservation must remain accounted",
          );
        if (existing.status === "released" && proposed.status !== "released")
          throw new BudgetError("Released probe request cannot be reused");
      }
      this.production.put(BUDGET, key, proposed);
    });
  }
}
