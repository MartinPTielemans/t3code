import {
  type FleetCopySkillsResult,
  type FleetStatusResult,
  OrchestratorMcpFailure,
  type ProviderSkillTransferError,
} from "@t3tools/contracts";
import { diagnoseFleet, fleetHealthOf, type FleetMember } from "@t3tools/shared/fleet";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ProviderSkillTransfer from "../../../provider/ProviderSkillTransfer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FleetToolkit } from "./tools.ts";

const { tools } = FleetToolkit;

/** How long one linked environment may take to report before it counts as unreachable. */
const LINKED_HEALTH_TIMEOUT = Duration.seconds(15);

const transferFailure = (error: ProviderSkillTransferError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** This environment's own health, as every peer reports it. */
const localHealth = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  return fleetHealthOf({
    environment: yield* environment.getDescriptor,
    providers: yield* providers.getProviders,
  });
});

const health = (environmentId: FleetMember["environmentId"] | undefined) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const target = PeerForwarding.remoteTarget(scope, environmentId);
    if (target === undefined) return yield* localHealth;
    const forwarding = yield* PeerForwarding.PeerForwarding;
    return yield* forwarding.call(scope, tools.t3_fleet_health, target, {});
  });

export const layer = McpToolAccess.toLayer(FleetToolkit, {
  t3_fleet_health: McpToolAccess.reads((input) => health(input.environmentId)),

  t3_fleet_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const forwarding = yield* PeerForwarding.PeerForwarding;
      const here = yield* localHealth;
      const { links } = yield* forwarding.links(scope);
      // Each linked environment answers for itself; one that cannot is compared as unreachable.
      const linked = yield* Effect.forEach(
        links,
        (link): Effect.Effect<FleetMember> =>
          link.status === "expired"
            ? Effect.succeed({
                environmentId: link.environmentId,
                label: link.label,
                enabled: true,
                connected: false,
                health: null,
                problem: "The link expired. Link it again from a new pairing code.",
              })
            : forwarding.call(scope, tools.t3_fleet_health, link.environmentId, {}).pipe(
                Effect.timeoutOrElse({
                  duration: LINKED_HEALTH_TIMEOUT,
                  orElse: () =>
                    Effect.fail(
                      new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: "It did not answer in time.",
                      }),
                    ),
                }),
                Effect.map((reported): FleetMember => ({
                  environmentId: link.environmentId,
                  label: link.label,
                  enabled: true,
                  connected: true,
                  health: reported,
                })),
                Effect.catch((failure) =>
                  Effect.succeed<FleetMember>({
                    environmentId: link.environmentId,
                    label: link.label,
                    enabled: true,
                    connected: false,
                    health: null,
                    problem: failure.message,
                  }),
                ),
              ),
        { concurrency: "unbounded" },
      );
      const members: ReadonlyArray<FleetMember> = [
        {
          environmentId: here.environmentId,
          label: here.label,
          enabled: true,
          connected: true,
          health: here,
        },
        ...linked,
      ];
      const report = diagnoseFleet(members);
      return {
        environmentId: here.environmentId,
        environments: members.map((member) => ({
          environmentId: member.environmentId,
          label: member.label,
          reachable: member.health !== null,
          ...(member.health ? { serverVersion: member.health.serverVersion } : {}),
          ...(member.problem ? { problem: member.problem } : {}),
        })),
        findings: report.findings,
      } satisfies FleetStatusResult;
    }),
  ),

  t3_provider_skill_export: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const target = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (target !== undefined) {
        const forwarding = yield* PeerForwarding.PeerForwarding;
        return yield* forwarding.call(scope, tools.t3_provider_skill_export, target, input);
      }
      const transfer = yield* ProviderSkillTransfer.ProviderSkillTransfer;
      return yield* transfer
        .exportSkill({ instanceId: input.instanceId, name: input.name })
        .pipe(Effect.mapError(transferFailure));
    }),
  ),

  // Writing a skill changes this environment, so a linked environment may not ask for it.
  t3_fleet_copy_skills: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const forwarding = yield* PeerForwarding.PeerForwarding;
      const transfer = yield* ProviderSkillTransfer.ProviderSkillTransfer;
      const copied: Array<FleetCopySkillsResult["copied"][number]> = [];
      const failed: Array<FleetCopySkillsResult["failed"][number]> = [];
      for (const skill of input.skills) {
        const source = PeerForwarding.remoteTarget(scope, skill.from.environmentId);
        if (source === undefined) {
          failed.push({ name: skill.name, reason: "It is already in this environment." });
          continue;
        }
        const outcome = yield* forwarding
          .call(scope, tools.t3_provider_skill_export, source, {
            instanceId: skill.from.instanceId,
            name: skill.name,
          })
          .pipe(
            Effect.flatMap((bundle) =>
              transfer
                .importSkill({ instanceId: input.instanceId, skill: bundle })
                .pipe(Effect.mapError(transferFailure)),
            ),
            Effect.result,
          );
        if (outcome._tag === "Success") copied.push(outcome.success);
        else failed.push({ name: skill.name, reason: outcome.failure.message });
      }
      return { copied, failed };
    }),
  ),
});
