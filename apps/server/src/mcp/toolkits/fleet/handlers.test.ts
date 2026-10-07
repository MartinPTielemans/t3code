import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ExecutionEnvironmentDescriptor,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../../../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../../../peer/PeerMcpClient.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop", { providerSkillTransfer: true });
const box = descriptorOf("environment-box", "Box", { providerSkillTransfer: true });
const claudeId = ProviderInstanceId.make("claudeAgent");

const claude = (version: string, skillsRoot: string, skills: ReadonlyArray<string>) =>
  ({
    instanceId: claudeId,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-07T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: skills.map((name) => ({
      name,
      path: `${skillsRoot}/${name}/SKILL.md`,
      scope: "user",
      enabled: true,
    })),
  }) as unknown as ServerProvider;

/**
 * One environment's real fleet toolkit over its own Claude, whose personal
 * skills live in `skillsRoot` and are listed by scanning it, as the driver does.
 */
const environmentServices = (
  descriptor: ExecutionEnvironmentDescriptor,
  skillsRoot: string,
  version: string,
) =>
  Layer.mergeAll(
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(descriptor.environmentId),
      getDescriptor: Effect.succeed(descriptor),
    }),
    Layer.effect(
      ProviderRegistry.ProviderRegistry,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const scan = fs.readDirectory(skillsRoot).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.map((names) => [claude(version, skillsRoot, [...names].sort())]),
        );
        return ProviderRegistry.ProviderRegistry.of({
          getProviders: scan,
          refreshInstance: () => scan,
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]);
      }),
    ),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (instanceId) =>
        Effect.succeed(
          instanceId === claudeId ? ({ personalSkillsDirectory: skillsRoot } as never) : undefined,
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          liveThreadShell(
            threadId,
            threadId === ThreadId.make("thread:laptop-plan")
              ? { runtimeMode: "full-access", interactionMode: "plan" }
              : { runtimeMode: "full-access" },
          ),
        ),
    }),
  );

const writeSkill = Effect.fn(function* (root: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(root, name), { recursive: true });
  yield* fs.writeFileString(path.join(root, name, "SKILL.md"), body);
});

/** The box: Claude 2.1.5 with the `deploy-notes` and `tdd` skills, its fleet tools behind real OAuth. */
const serveBox = (skillsRoot: string, descriptor = box) =>
  servePeer(
    descriptor,
    McpHttpServer.layerFleetRegistration.pipe(
      Layer.provide(PeerForwarding.layer),
      Layer.provide(layerLinkingEnvironment(descriptor)),
      Layer.provide(environmentServices(descriptor, skillsRoot, "2.1.5")),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(NodeServices.layer),
    ),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "fleet-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fleet-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The laptop: Claude 2.1.3 with only `tdd`, linking to the box. */
const makeLaptop = (skillsRoot: string) =>
  Effect.gen(function* () {
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const here = yield* McpHttpServer.layerFleetRegistration.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(PeerForwarding.layer),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(environmentServices(laptop, skillsRoot, "2.1.3")),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(NodeServices.layer),
      Layer.fresh,
      Layer.build,
    );
    const server = Context.get(here, McpServer.McpServer);
    const call = (caller: string, name: string, args: Record<string, unknown>) =>
      server.callTool({ name, arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: laptop.environmentId,
          requestNamespace: `provider-session:${caller}`,
          thread: {
            threadId: ThreadId.make(caller),
            providerSessionId: `provider-session:${caller}`,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        }),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      peers: Context.get(linking, PeerMcpClient.PeerMcpClient),
      call,
    };
  });

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-tools-" });
  const boxSkills = path.join(temp, "box", "skills");
  const laptopSkills = path.join(temp, "laptop", "skills");
  yield* writeSkill(boxSkills, "deploy-notes", "---\nname: deploy-notes\n---\nShip it.\n");
  yield* writeSkill(boxSkills, "tdd", "---\nname: tdd\n---\nRed, green.\n");
  yield* writeSkill(laptopSkills, "tdd", "---\nname: tdd\n---\nRed, green.\n");
  return { fs, path, boxSkills, laptopSkills };
});

it.layer(NodeServices.layer)("fleet tools across a link", (it) => {
  it.effect(
    "an agent compares its environment with a linked one and copies a missing skill here",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, path, boxSkills, laptopSkills } = yield* setup;
          const b = yield* serveBox(boxSkills);
          const a = yield* makeLaptop(laptopSkills);
          yield* linkTo(a.links, b, "auto");

          const status = yield* a.call("thread:laptop-full", "t3_fleet_status", {});
          expect(status.isError).toBe(false);
          expect(status.structuredContent).toMatchObject({
            environmentId: laptop.environmentId,
            environments: [
              { environmentId: laptop.environmentId, reachable: true },
              { environmentId: box.environmentId, label: "Box", reachable: true },
            ],
          });
          const findings = (status.structuredContent as { findings: ReadonlyArray<any> }).findings;
          expect(findings.map((f) => `${f.environmentId} ${f.key}`)).toEqual([
            "environment-laptop provider-older:claudeAgent",
            "environment-laptop skills-missing:claudeAgent",
          ]);
          const copy = findings[1].action;
          expect(copy).toEqual({
            _tag: "copy-skills",
            instanceId: "claudeAgent",
            skills: [
              {
                name: "deploy-notes",
                from: { environmentId: box.environmentId, instanceId: "claudeAgent" },
              },
            ],
          });

          const copied = yield* a.call("thread:laptop-full", "t3_fleet_copy_skills", {
            instanceId: copy.instanceId,
            skills: copy.skills,
          });
          expect(copied.structuredContent).toMatchObject({
            copied: [{ name: "deploy-notes" }],
            failed: [],
          });
          expect(
            yield* fs.readFileString(path.join(laptopSkills, "deploy-notes", "SKILL.md")),
          ).toBe("---\nname: deploy-notes\n---\nShip it.\n");

          // Now the two match, and a second copy refuses rather than overwrite.
          const after = yield* a.call("thread:laptop-full", "t3_fleet_status", {});
          expect(
            (after.structuredContent as { findings: ReadonlyArray<{ key: string }> }).findings.map(
              (f) => f.key,
            ),
          ).toEqual(["provider-older:claudeAgent"]);
          const again = yield* a.call("thread:laptop-full", "t3_fleet_copy_skills", {
            instanceId: copy.instanceId,
            skills: copy.skills,
          });
          expect(again.structuredContent).toMatchObject({
            copied: [],
            failed: [{ name: "deploy-notes", reason: expect.stringContaining("already here") }],
          });
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "copying needs a full-access caller here, and never runs for a linked caller there",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { boxSkills, laptopSkills } = yield* setup;
          const b = yield* serveBox(boxSkills);
          const a = yield* makeLaptop(laptopSkills);
          yield* linkTo(a.links, b, "full-access");
          const skills = [
            {
              name: "deploy-notes",
              from: { environmentId: box.environmentId, instanceId: claudeId },
            },
          ];

          const planned = yield* a.call("thread:laptop-plan", "t3_fleet_copy_skills", {
            instanceId: claudeId,
            skills,
          });
          expect(failureOf(planned)).toMatchObject({ code: "capability_denied" });

          // The laptop asking the box to write into the box: the link is fenced
          // from environment writes, whatever its access.
          const pushed = yield* a.peers
            .call({
              environmentId: box.environmentId,
              tool: "t3_fleet_copy_skills",
              arguments: {
                instanceId: claudeId,
                skills: [
                  {
                    name: "tdd",
                    from: { environmentId: laptop.environmentId, instanceId: claudeId },
                  },
                ],
              },
              limits: { runtimeMode: "full-access", interactionMode: "default" },
              success: Schema.Unknown,
            })
            .pipe(Effect.flip);
          expect(pushed.code).toBe("capability_denied");
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a linked environment that stops answering as itself is compared as unreachable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { boxSkills, laptopSkills } = yield* setup;
        const b = yield* serveBox(boxSkills);
        const a = yield* makeLaptop(laptopSkills);
        yield* linkTo(a.links, b, "auto");
        yield* Ref.set(b.descriptor, descriptorOf("environment-other", "Other"));
        const bearersBefore = (yield* Ref.get(b.bearers)).length;

        const status = yield* a.call("thread:laptop-full", "t3_fleet_status", {});
        expect(status.structuredContent).toMatchObject({
          environments: [
            { environmentId: laptop.environmentId, reachable: true },
            { environmentId: box.environmentId, reachable: false, problem: expect.any(String) },
          ],
          findings: [{ environmentId: box.environmentId, key: "reach", severity: "warning" }],
        });
        // The address answering as another environment never received the link's token.
        expect((yield* Ref.get(b.bearers)).length).toBe(bearersBefore);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
