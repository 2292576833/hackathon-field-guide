import type { Actor, Clock } from "../../shared/contracts.ts";
import type { DatabasePort } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { FIRST_LOGIN_GUIDE_STEP_COUNT, FIRST_LOGIN_GUIDE_VERSION, type OnboardingState, type SaveOnboardingInput } from "./model.ts";
import { insertOnboarding, readOnboarding, updateOnboarding } from "./postgres.ts";

export class OnboardingService {
  private readonly database: DatabasePort;
  private readonly clock: Clock;

  constructor(database: DatabasePort, clock: Clock) {
    this.database = database;
    this.clock = clock;
  }

  async get(actor: Actor): Promise<OnboardingState> {
    this.assertActor(actor);
    return await readOnboarding(this.database, actor.userId) ?? this.initialState();
  }

  async save(actor: Actor, input: SaveOnboardingInput): Promise<OnboardingState> {
    this.assertActor(actor);
    if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || !Number.isInteger(input.stepIndex) || input.stepIndex < 0 || input.stepIndex >= FIRST_LOGIN_GUIDE_STEP_COUNT
      || input.completed !== undefined && typeof input.completed !== "boolean") {
      throw new DomainError("INVALID_ONBOARDING_STATE", "指引步骤无效，请重新打开网站指引。", { status: 422 });
    }
    if (input.completed === true && input.stepIndex !== FIRST_LOGIN_GUIDE_STEP_COUNT - 1) {
      throw new DomainError("ONBOARDING_NOT_AT_LAST_STEP", "请到指引最后一步，再确认已经了解。", { status: 422 });
    }
    return this.database.transaction(async sql => {
      const current = await readOnboarding(sql, actor.userId) ?? this.initialState();
      if (current.revision !== input.expectedRevision) this.conflict(current);
      if (current.version !== FIRST_LOGIN_GUIDE_VERSION) {
        throw new DomainError("ONBOARDING_VERSION_UNSUPPORTED", "网站指引已更新，请重新打开。", { status: 409 });
      }
      // Replaying an already completed guide cannot erase or change that fact.
      if (current.completedAt !== null) return current;
      const now = this.clock.now().toISOString();
      const next: OnboardingState = {
        version: FIRST_LOGIN_GUIDE_VERSION,
        stepIndex: input.stepIndex,
        completedAt: input.completed === true ? now : null,
        revision: current.revision + 1,
      };
      const saved = current.revision === 0
        ? await insertOnboarding(sql, actor.userId, next, now)
        : await updateOnboarding(sql, actor.userId, current.revision, next, now);
      if (saved) return saved;
      this.conflict(await readOnboarding(sql, actor.userId) ?? this.initialState());
    });
  }

  private initialState(): OnboardingState {
    return { version: FIRST_LOGIN_GUIDE_VERSION, stepIndex: 0, completedAt: null, revision: 0 };
  }

  private assertActor(actor: Actor): void {
    if (!actor || typeof actor.userId !== "string" || !actor.userId.trim()) {
      throw new DomainError("AUTH_SESSION_REQUIRED", "请先登录，再继续网站指引。", { status: 401 });
    }
  }

  private conflict(current: OnboardingState): never {
    throw new DomainError("ONBOARDING_REVISION_CONFLICT", "另一个页面更新了指引进度，已保留当前步骤，请重试保存。", {
      status: 409,
      latestRevision: current.revision,
      recoveryAction: "读取最新指引版本后，使用新的 expectedRevision 保存当前步骤。",
    });
  }
}
