import {
  FleetCopySkillsInput,
  FleetCopySkillsResult,
  FleetEnvironmentHealth,
  FleetHealthInput,
  FleetSkillExportInput,
  FleetStatusResult,
  OrchestratorMcpFailure,
  ProviderSkillBundle,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ProviderSkillTransfer from "../../../provider/ProviderSkillTransfer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    ProviderRegistry.ProviderRegistry,
    ProviderSkillTransfer.ProviderSkillTransfer,
    PeerForwarding.PeerForwarding,
  ],
};

const FleetStatusTool = Tool.make("t3_fleet_status", {
  ...shared,
  description:
    "Compare this T3 Code environment with every linked environment (t3_environment_links), such as the user's other machines: T3 Code versions and release channels, client protocol, each provider's on/off state, install, sign-in, health and version, and the user's own skills one machine has and another lacks. Returns each environment, whether it answered, and the differences, errors first. A finding's action says what fixes it: copy-skills is done here with t3_fleet_copy_skills; the others are changed on that machine (its own agent, or the user in Settings), because a link may not change another environment's providers or server.",
  success: FleetStatusResult,
})
  .annotate(Tool.Title, "Compare linked environments")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const FleetHealthTool = Tool.make("t3_fleet_health", {
  ...shared,
  description:
    "Read one environment's health as t3_fleet_status compares it: T3 Code version, client protocol, and each provider's state, version, sign-in and personal skill names. Pass environmentId to read a linked environment instead of this one.",
  parameters: FleetHealthInput,
  success: FleetEnvironmentHealth,
})
  .annotate(Tool.Title, "Read environment health")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const SkillExportTool = Tool.make("t3_provider_skill_export", {
  ...shared,
  description:
    "Read one of the user's own skills (a personal skill the provider instance loads, by name) as files, so it can be copied to another environment. Pass environmentId to read it from a linked environment. To copy skills here, use t3_fleet_copy_skills, which calls this for you.",
  parameters: FleetSkillExportInput,
  success: ProviderSkillBundle,
})
  .annotate(Tool.Title, "Read a personal skill")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CopySkillsTool = Tool.make("t3_fleet_copy_skills", {
  ...shared,
  description:
    "Copy the user's own skills from linked environments into a provider instance here, as t3_fleet_status's copy-skills action lists them. Each skill is read from the environment that has it and written into this instance's personal skills directory; a skill already here is never overwritten and is reported as failed. Requires a live full-access/default calling thread or a full-access client. Copying into another environment has to run there.",
  parameters: FleetCopySkillsInput,
  success: FleetCopySkillsResult,
})
  .annotate(Tool.Title, "Copy skills here")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const FleetToolkit = Toolkit.make(
  FleetStatusTool,
  FleetHealthTool,
  SkillExportTool,
  CopySkillsTool,
);
