import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Copying one of the user's own skills between environments: the client
 * exports it from the machine that has it and imports it on one that lacks
 * it. Each server resolves its own personal skills directory, so neither
 * request carries a filesystem path outside the skill.
 */

/** A skill directory name: what the CLI calls the skill. */
export const ProviderSkillName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);

export const PROVIDER_SKILL_TRANSFER_MAX_FILES = 256;
export const PROVIDER_SKILL_TRANSFER_MAX_BYTES = 4 * 1024 * 1024;

export const ProviderSkillFile = Schema.Struct({
  /** Relative to the skill directory, `/`-separated, e.g. `SKILL.md` or `scripts/run.sh`. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  /** Base64 file contents. */
  contents: Schema.String,
  executable: Schema.optionalKey(Schema.Boolean),
});
export type ProviderSkillFile = typeof ProviderSkillFile.Type;

export const ProviderSkillBundle = Schema.Struct({
  name: ProviderSkillName,
  files: Schema.Array(ProviderSkillFile).check(
    Schema.isMaxLength(PROVIDER_SKILL_TRANSFER_MAX_FILES),
  ),
});
export type ProviderSkillBundle = typeof ProviderSkillBundle.Type;

export const ProviderSkillExportInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: ProviderSkillName,
});
export type ProviderSkillExportInput = typeof ProviderSkillExportInput.Type;

export const ProviderSkillImportInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  skill: ProviderSkillBundle,
});
export type ProviderSkillImportInput = typeof ProviderSkillImportInput.Type;

export const ProviderSkillImportResult = Schema.Struct({
  name: ProviderSkillName,
  /** Where the skill now lives on this environment. */
  path: TrimmedNonEmptyString,
});
export type ProviderSkillImportResult = typeof ProviderSkillImportResult.Type;

export class ProviderSkillTransferError extends Schema.TaggedError<ProviderSkillTransferError>()(
  "ProviderSkillTransferError",
  {
    instanceId: ProviderInstanceId,
    name: Schema.String,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Could not copy skill ${this.name}: ${this.reason}`;
  }
}
