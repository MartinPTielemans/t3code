import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderSkillExportInput } from "./providerSkillTransfer.ts";
import {
  ServerProviderAuthStatus,
  ServerProviderAvailability,
  ServerProviderState,
  ServerProviderVersionAdvisory,
} from "./server.ts";

/**
 * Fleet: how the user's environments differ. Each environment describes its
 * own health with `FleetEnvironmentHealth`; whoever compares them (a client
 * holding several server configs, or an agent through linked environments)
 * runs the same comparison over these snapshots.
 */

export const FleetProviderHealth = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  authStatus: ServerProviderAuthStatus,
  message: Schema.optionalKey(TrimmedNonEmptyString),
  availability: Schema.optionalKey(ServerProviderAvailability),
  unavailableReason: Schema.optionalKey(TrimmedNonEmptyString),
  versionAdvisory: Schema.optionalKey(ServerProviderVersionAdvisory),
  /** Names of the user's own skills this instance loads (not a repository's or a plugin's). */
  personalSkills: Schema.Array(TrimmedNonEmptyString),
});
export type FleetProviderHealth = typeof FleetProviderHealth.Type;

export const FleetEnvironmentHealth = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  serverVersion: TrimmedNonEmptyString,
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  /** The environment can export and import personal skills. */
  providerSkillTransfer: Schema.Boolean,
  providers: Schema.Array(FleetProviderHealth),
});
export type FleetEnvironmentHealth = typeof FleetEnvironmentHealth.Type;

export const FleetSeverity = Schema.Literals(["error", "warning", "info"]);
export type FleetSeverity = typeof FleetSeverity.Type;

export const FleetFindingAction = Schema.Union([
  Schema.TaggedStruct("update-server", { targetVersion: TrimmedNonEmptyString }),
  Schema.TaggedStruct("update-provider", {
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  }),
  Schema.TaggedStruct("open-provider-settings", { instanceId: ProviderInstanceId }),
  Schema.TaggedStruct("copy-skills", {
    /** The instance on the finding's environment that receives the skills. */
    instanceId: ProviderInstanceId,
    skills: Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        from: Schema.Struct({ environmentId: EnvironmentId, instanceId: ProviderInstanceId }),
      }),
    ),
  }),
]);
export type FleetFindingAction = typeof FleetFindingAction.Type;

export const FleetFinding = Schema.Struct({
  /** Stable per environment, so a list keyed by it keeps its rows across refreshes. */
  key: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  severity: FleetSeverity,
  area: Schema.Literals(["reach", "server", "provider", "skills"]),
  title: TrimmedNonEmptyString,
  detail: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(FleetFindingAction),
});
export type FleetFinding = typeof FleetFinding.Type;

export const FleetStatusResult = Schema.Struct({
  /** The environment answering, which is always compared. */
  environmentId: EnvironmentId,
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      reachable: Schema.Boolean,
      serverVersion: Schema.optionalKey(TrimmedNonEmptyString),
      /** Why a linked environment could not be compared. */
      problem: Schema.optionalKey(Schema.String),
    }),
  ),
  findings: Schema.Array(FleetFinding),
});
export type FleetStatusResult = typeof FleetStatusResult.Type;

export const FleetHealthInput = Schema.Struct({
  /** A linked environment (t3_environment_links) to read instead of this one. */
  environmentId: Schema.optionalKey(EnvironmentId),
});
export type FleetHealthInput = typeof FleetHealthInput.Type;

export const FleetCopySkillsInput = Schema.Struct({
  /** The instance here that receives the skills. */
  instanceId: ProviderInstanceId,
  skills: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      from: Schema.Struct({ environmentId: EnvironmentId, instanceId: ProviderInstanceId }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
export type FleetCopySkillsInput = typeof FleetCopySkillsInput.Type;

export const FleetCopySkillsResult = Schema.Struct({
  copied: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, path: TrimmedNonEmptyString })),
  failed: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
});
export type FleetCopySkillsResult = typeof FleetCopySkillsResult.Type;

export const FleetSkillExportInput = Schema.Struct({
  ...ProviderSkillExportInput.fields,
  /** A linked environment (t3_environment_links) to read the skill from instead of this one. */
  environmentId: Schema.optionalKey(EnvironmentId),
});
export type FleetSkillExportInput = typeof FleetSkillExportInput.Type;
