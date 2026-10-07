import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ExecutionEnvironmentDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diagnoseFleet, fleetHealthOf, type FleetMember } from "./fleet.ts";

const claude = (overrides: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.5",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-07T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

const member = (
  id: string,
  options: {
    version?: string;
    protocol?: number;
    providers?: ReadonlyArray<ServerProvider>;
    connected?: boolean;
    enabled?: boolean;
    skillTransfer?: boolean;
  } = {},
): FleetMember => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  enabled: options.enabled ?? true,
  connected: options.connected ?? true,
  health: fleetHealthOf({
    environment: {
      environmentId: EnvironmentId.make(id),
      label: id,
      serverVersion: options.version ?? "0.9.0",
      ...(options.protocol === undefined ? {} : { orchestrationProtocolVersion: options.protocol }),
      capabilities: (options.skillTransfer
        ? { providerSkillTransfer: true }
        : {}) as ExecutionEnvironmentDescriptor["capabilities"],
    },
    providers: options.providers ?? [claude()],
  }),
});

const keysOf = (members: ReadonlyArray<FleetMember>) =>
  diagnoseFleet(members).findings.map((f) => `${f.environmentId} ${f.key}`);

describe("diagnoseFleet", () => {
  it("reports nothing for equivalent machines", () => {
    expect(keysOf([member("laptop"), member("server")])).toEqual([]);
  });

  it("flags a server behind the newest release on its channel, with the update target", () => {
    const { findings } = diagnoseFleet([
      member("laptop", { version: "0.9.2" }),
      member("server", { version: "0.9.0" }),
    ]);
    expect(findings).toMatchObject([
      {
        environmentId: "server",
        key: "server-behind",
        action: { _tag: "update-server", targetVersion: "0.9.2" },
      },
    ]);
  });

  it("never calls a nightly behind a stable release", () => {
    expect(
      keysOf([
        member("laptop", { version: "0.10.0" }),
        member("desktop", { version: "0.10.0" }),
        member("server", { version: "0.9.0-nightly.20261001.1" }),
      ]),
    ).toEqual(["server server-channel"]);
  });

  it("flags an older client protocol", () => {
    expect(keysOf([member("laptop", { protocol: 3 }), member("server", { protocol: 2 })])).toEqual([
      "server server-protocol",
    ]);
  });

  it("flags a provider that is off on one machine but on elsewhere", () => {
    expect(
      keysOf([
        member("laptop"),
        member("server", { providers: [claude({ enabled: false, status: "disabled" })] }),
      ]),
    ).toEqual(["server provider-off:claudeAgent"]);
  });

  it("reports a signed-out provider once, as an error", () => {
    const { findings } = diagnoseFleet([
      member("laptop"),
      member("server", {
        providers: [claude({ auth: { status: "unauthenticated" }, status: "error" })],
      }),
    ]);
    expect(findings.map((f) => [f.key, f.severity])).toEqual([
      ["provider-logged-out:claudeAgent", "error"],
    ]);
  });

  it("offers a provider update when the advisory says it can", () => {
    const { findings } = diagnoseFleet([
      member("laptop", {
        providers: [
          claude({
            version: "2.1.3",
            versionAdvisory: {
              status: "behind_latest",
              currentVersion: "2.1.3",
              latestVersion: "2.1.5",
              updateCommand: null,
              canUpdate: true,
              checkedAt: null,
              message: null,
            },
          }),
        ],
      }),
      member("server"),
    ]);
    expect(findings).toMatchObject([
      {
        environmentId: "laptop",
        key: "provider-behind:claudeAgent",
        action: { _tag: "update-provider" },
      },
    ]);
  });

  it("compares installed versions when there is no advisory", () => {
    expect(
      keysOf([member("laptop", { providers: [claude({ version: "2.1.3" })] }), member("server")]),
    ).toEqual(["laptop provider-older:claudeAgent"]);
  });

  it("lists personal skills another machine has, ignoring project skills", () => {
    const skill = (name: string, scope: string) => ({
      name,
      path: `/home/u/.claude/skills/${name}/SKILL.md`,
      scope,
      enabled: true,
    });
    const { findings } = diagnoseFleet([
      member("laptop", {
        providers: [claude({ skills: [skill("tdd", "user"), skill("deploy", "project")] })],
      }),
      member("server", { providers: [claude({ skills: [] })] }),
    ]);
    expect(findings).toMatchObject([
      { environmentId: "server", key: "skills-missing:claudeAgent", detail: "tdd, from laptop." },
    ]);
  });

  it("offers to copy missing skills only between machines that can transfer them", () => {
    const tdd = {
      name: "tdd",
      path: "/u/.claude/skills/tdd/SKILL.md",
      scope: "user",
      enabled: true,
    };
    const copyAction = (laptopCan: boolean) =>
      diagnoseFleet([
        member("laptop", { skillTransfer: laptopCan, providers: [claude({ skills: [tdd] })] }),
        member("server", { skillTransfer: true }),
      ]).findings[0]?.action;
    expect(copyAction(true)).toEqual({
      _tag: "copy-skills",
      instanceId: "claudeAgent",
      skills: [{ name: "tdd", from: { environmentId: "laptop", instanceId: "claudeAgent" } }],
    });
    expect(copyAction(false)).toBeUndefined();
  });

  it("reports an unreachable machine and compares only those that report", () => {
    expect(
      keysOf([
        member("laptop", { version: "0.9.2" }),
        member("server", { version: "0.9.0", connected: false }),
        member("old", { version: "0.1.0", enabled: false }),
      ]),
    ).toEqual(["server reach"]);
  });

  it("orders errors before warnings before info", () => {
    const severities = diagnoseFleet([
      member("laptop", { version: "0.9.2", providers: [claude({ version: "2.1.3" })] }),
      member("server", { providers: [claude({ installed: false, version: null })] }),
      member("desktop", { version: "0.9.2" }),
    ]).findings.map((f) => f.severity);
    expect(severities).toEqual(["error", "warning", "info"]);
  });
});
