import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { cliReleaseChannelOf, type CliReleaseChannel } from "@t3tools/shared/releaseChannel";
import { compareSemverVersions } from "@t3tools/shared/semver";

import { resolveProviderSkillSourceKind } from "./providerSkills.ts";

/**
 * Fleet: how the user's environments differ from each other. Each environment
 * already reports its own health in its server config; this compares them, so
 * a provider that is logged out on the desktop or a server two releases behind
 * shows up from whichever machine the user is on.
 *
 * Pure over the configs the client already holds; it reads nothing and starts
 * nothing. Disabled environments are left out: the user switched them off.
 */
export interface FleetMember {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly serverConfig: ServerConfig | null;
}

export type FleetSeverity = "error" | "warning" | "info";

export type FleetFindingAction =
  | { readonly kind: "update-server"; readonly targetVersion: string }
  | {
      readonly kind: "update-provider";
      readonly instanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
    }
  | { readonly kind: "open-provider-settings"; readonly instanceId: ProviderInstanceId }
  | {
      readonly kind: "copy-skills";
      /** The instance on the finding's environment that receives the skills. */
      readonly instanceId: ProviderInstanceId;
      readonly skills: ReadonlyArray<{
        readonly name: string;
        readonly from: {
          readonly environmentId: EnvironmentId;
          readonly instanceId: ProviderInstanceId;
        };
      }>;
    };

export interface FleetFinding {
  /** Stable per environment, so a list keyed by it keeps its rows across refreshes. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly severity: FleetSeverity;
  readonly area: "reach" | "server" | "provider" | "skills";
  readonly title: string;
  readonly detail?: string;
  readonly action?: FleetFindingAction;
}

export interface FleetProviderRow {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  /** One entry per reporting member, in member order; null where the instance does not exist. */
  readonly cells: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly provider: ServerProvider | null;
  }>;
}

export interface FleetReport {
  /** Enabled members, in the order given. */
  readonly members: ReadonlyArray<FleetMember>;
  /** Members whose config has arrived; only these are compared. */
  readonly reporting: ReadonlyArray<FleetMember & { readonly serverConfig: ServerConfig }>;
  readonly findings: ReadonlyArray<FleetFinding>;
  readonly providers: ReadonlyArray<FleetProviderRow>;
}

const SEVERITY_ORDER: Record<FleetSeverity, number> = { error: 0, warning: 1, info: 2 };

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const listSome = (names: ReadonlyArray<string>, limit = 4) =>
  names.length <= limit
    ? joinNames(names)
    : `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;

export const fleetProviderLabel = (provider: Pick<ServerProvider, "displayName" | "instanceId">) =>
  provider.displayName ?? provider.instanceId;

const newestVersion = (versions: ReadonlyArray<string>) =>
  versions.reduce<string | null>(
    (newest, version) =>
      newest === null || compareSemverVersions(version, newest) > 0 ? version : newest,
    null,
  );

function serverFindings(
  reporting: FleetReport["reporting"],
  labelOf: (id: EnvironmentId) => string,
): FleetFinding[] {
  const out: FleetFinding[] = [];
  const byChannel = new Map<CliReleaseChannel, Array<FleetReport["reporting"][number]>>();
  for (const member of reporting) {
    const channel = cliReleaseChannelOf(member.serverConfig.environment.serverVersion);
    byChannel.set(channel, [...(byChannel.get(channel) ?? []), member]);
  }
  // Releases on one train are comparable; a nightly is never "behind" a stable.
  for (const [channel, members] of byChannel) {
    const newest = newestVersion(members.map((m) => m.serverConfig.environment.serverVersion));
    if (newest === null) continue;
    const onNewest = members
      .filter((m) => m.serverConfig.environment.serverVersion === newest)
      .map((m) => m.label);
    for (const member of members) {
      const version = member.serverConfig.environment.serverVersion;
      if (compareSemverVersions(version, newest) >= 0) continue;
      out.push({
        key: "server-behind",
        environmentId: member.environmentId,
        severity: "warning",
        area: "server",
        title: `T3 Code ${version} is behind ${newest}`,
        detail: `${joinNames(onNewest)} ${onNewest.length === 1 ? "runs" : "run"} ${newest} on the ${channel} channel.`,
        action: { kind: "update-server", targetVersion: newest },
      });
    }
  }
  if (byChannel.size > 1) {
    const largest = Math.max(...[...byChannel.values()].map((members) => members.length));
    const majority = [...byChannel.entries()].filter(([, m]) => m.length === largest);
    // With a tie there is no "usual" channel, so nobody is singled out.
    if (majority.length === 1) {
      const [usual, usualMembers] = majority[0]!;
      for (const [channel, members] of byChannel) {
        if (channel === usual) continue;
        for (const member of members) {
          out.push({
            key: "server-channel",
            environmentId: member.environmentId,
            severity: "info",
            area: "server",
            title: `On the ${channel} channel`,
            detail: `${joinNames(usualMembers.map((m) => m.label))} ${usualMembers.length === 1 ? "is" : "are"} on ${usual}.`,
          });
        }
      }
    }
  }
  const protocols = reporting.flatMap((m) =>
    m.serverConfig.environment.orchestrationProtocolVersion === undefined
      ? []
      : [{ member: m, protocol: m.serverConfig.environment.orchestrationProtocolVersion }],
  );
  const newestProtocol = Math.max(...protocols.map((p) => p.protocol));
  for (const { member, protocol } of protocols) {
    if (protocol >= newestProtocol) continue;
    const ahead = protocols.filter((p) => p.protocol === newestProtocol).map((p) => p.member.label);
    out.push({
      key: "server-protocol",
      environmentId: member.environmentId,
      severity: "warning",
      area: "server",
      title: `Speaks client protocol ${protocol}; ${joinNames(ahead)} ${ahead.length === 1 ? "speaks" : "speak"} ${newestProtocol}`,
      detail: `An app built for one side cannot connect to the other until ${labelOf(member.environmentId)} is updated.`,
    });
  }
  return out;
}

function providerRows(reporting: FleetReport["reporting"]): FleetProviderRow[] {
  const rows = new Map<ProviderInstanceId, FleetProviderRow>();
  for (const member of reporting) {
    for (const provider of member.serverConfig.providers) {
      if (rows.has(provider.instanceId)) continue;
      rows.set(provider.instanceId, {
        instanceId: provider.instanceId,
        driver: provider.driver,
        label: fleetProviderLabel(provider),
        cells: reporting.map((m) => ({
          environmentId: m.environmentId,
          provider:
            m.serverConfig.providers.find((p) => p.instanceId === provider.instanceId) ?? null,
        })),
      });
    }
  }
  return [...rows.values()];
}

function providerFindings(
  rows: ReadonlyArray<FleetProviderRow>,
  labelOf: (id: EnvironmentId) => string,
): FleetFinding[] {
  const out: FleetFinding[] = [];
  for (const row of rows) {
    const { instanceId, label } = row;
    const settings = { kind: "open-provider-settings", instanceId } as const;
    const enabledOn = row.cells.filter((c) => c.provider?.enabled).map((c) => c.environmentId);
    const working = row.cells.flatMap((c) =>
      c.provider?.enabled && c.provider.installed && c.provider.version !== null
        ? [{ environmentId: c.environmentId, provider: c.provider }]
        : [],
    );
    const newestInstalled = newestVersion(working.map((w) => w.provider.version!));

    for (const { environmentId, provider } of row.cells) {
      if (provider === null) continue;
      const key = (what: string) => `provider-${what}:${instanceId}`;
      if (!provider.enabled) {
        const elsewhere = enabledOn.filter((id) => id !== environmentId);
        if (elsewhere.length > 0) {
          out.push({
            key: key("off"),
            environmentId,
            severity: "warning",
            area: "provider",
            title: `${label} is off here`,
            detail: `It is on in ${joinNames(elsewhere.map(labelOf))}.`,
            action: settings,
          });
        }
        continue;
      }
      if (provider.availability === "unavailable") {
        out.push({
          key: key("unavailable"),
          environmentId,
          severity: "warning",
          area: "provider",
          title: `${label} is unavailable`,
          ...(provider.unavailableReason ? { detail: provider.unavailableReason } : {}),
          action: settings,
        });
        continue;
      }
      if (!provider.installed) {
        out.push({
          key: key("missing"),
          environmentId,
          severity: "error",
          area: "provider",
          title: `${label} is on but not installed`,
          ...(provider.message ? { detail: provider.message } : {}),
          action: settings,
        });
        continue;
      }
      if (provider.auth.status === "unauthenticated") {
        out.push({
          key: key("logged-out"),
          environmentId,
          severity: "error",
          area: "provider",
          title: `${label} is signed out`,
          ...(provider.message ? { detail: provider.message } : {}),
          action: settings,
        });
      } else if (provider.status === "error" || provider.status === "warning") {
        out.push({
          key: key(provider.status),
          environmentId,
          severity: provider.status,
          area: "provider",
          title: provider.status === "error" ? `${label} is failing` : `${label} needs attention`,
          ...(provider.message ? { detail: provider.message } : {}),
          action: settings,
        });
      }
      const advisory = provider.versionAdvisory;
      if (advisory?.status === "behind_latest" && advisory.latestVersion !== null) {
        out.push({
          key: key("behind"),
          environmentId,
          severity: "info",
          area: "provider",
          title: `${label} ${provider.version ?? advisory.currentVersion ?? "here"} is behind ${advisory.latestVersion}`,
          ...(advisory.canUpdate
            ? {
                action: {
                  kind: "update-provider",
                  instanceId,
                  driver: provider.driver,
                } as const,
              }
            : advisory.updateCommand
              ? { detail: `Run \`${advisory.updateCommand}\` on that machine.` }
              : {}),
        });
      } else if (
        provider.version !== null &&
        newestInstalled !== null &&
        compareSemverVersions(provider.version, newestInstalled) < 0
      ) {
        // No advisory (it could not reach the registry, say), but another
        // machine runs something newer.
        const ahead = working
          .filter((w) => w.provider.version === newestInstalled)
          .map((w) => labelOf(w.environmentId));
        out.push({
          key: key("older"),
          environmentId,
          severity: "info",
          area: "provider",
          title: `${label} ${provider.version} is older than ${joinNames(ahead)}'s ${newestInstalled}`,
          ...(provider.versionAdvisory?.canUpdate
            ? {
                action: {
                  kind: "update-provider",
                  instanceId,
                  driver: provider.driver,
                } as const,
              }
            : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Personal skills (the user's own, not a repository's or a plugin's) that some
 * machines have and others lack, per provider driver. Project skills differ by
 * checkout and are not compared.
 */
function skillFindings(
  reporting: FleetReport["reporting"],
  labelOf: (id: EnvironmentId) => string,
): FleetFinding[] {
  const out: FleetFinding[] = [];
  interface DriverSkills {
    readonly environmentId: EnvironmentId;
    readonly canTransfer: boolean;
    /** The first enabled instance of the driver: where copied skills go. */
    readonly instanceId: ProviderInstanceId;
    readonly providerLabel: string;
    readonly skills: Set<string>;
  }
  const perDriver = new Map<ProviderDriverKind, DriverSkills[]>();
  for (const member of reporting) {
    const canTransfer = member.serverConfig.environment.capabilities.providerSkillTransfer === true;
    const byDriver = new Map<
      ProviderDriverKind,
      Omit<DriverSkills, "environmentId" | "canTransfer">
    >();
    for (const provider of member.serverConfig.providers) {
      if (!provider.enabled || !provider.installed) continue;
      const entry = byDriver.get(provider.driver) ?? {
        instanceId: provider.instanceId,
        providerLabel: fleetProviderLabel(provider),
        skills: new Set<string>(),
      };
      for (const skill of provider.skills) {
        if (resolveProviderSkillSourceKind(skill) === "personal") entry.skills.add(skill.name);
      }
      byDriver.set(provider.driver, entry);
    }
    for (const [driver, entry] of byDriver) {
      perDriver.set(driver, [
        ...(perDriver.get(driver) ?? []),
        { environmentId: member.environmentId, canTransfer, ...entry },
      ]);
    }
  }
  for (const [driver, members] of perDriver) {
    if (members.length < 2) continue;
    for (const member of members) {
      const missing = new Map<string, DriverSkills[]>();
      for (const other of members) {
        if (other.environmentId === member.environmentId) continue;
        for (const skill of other.skills) {
          if (member.skills.has(skill)) continue;
          missing.set(skill, [...(missing.get(skill) ?? []), other]);
        }
      }
      if (missing.size === 0) continue;
      const names = [...missing.keys()].sort();
      const sources = [
        ...new Set([...missing.values()].flat().map((s) => labelOf(s.environmentId))),
      ];
      // Copyable when this machine and, per skill, some machine that has it can transfer.
      const copies = member.canTransfer
        ? names.flatMap((skill) => {
            const from = missing.get(skill)?.find((source) => source.canTransfer);
            return from
              ? [
                  {
                    name: skill,
                    from: { environmentId: from.environmentId, instanceId: from.instanceId },
                  },
                ]
              : [];
          })
        : [];
      out.push({
        key: `skills-missing:${driver}`,
        environmentId: member.environmentId,
        severity: "info",
        area: "skills",
        title: `${names.length} ${member.providerLabel} skill${names.length === 1 ? " is" : "s are"} missing here`,
        detail: `${listSome(names)}, from ${joinNames(sources)}.`,
        ...(copies.length > 0
          ? {
              action: {
                kind: "copy-skills",
                instanceId: member.instanceId,
                skills: copies,
              } as const,
            }
          : {}),
      });
    }
  }
  return out;
}

export function diagnoseFleet(members: ReadonlyArray<FleetMember>): FleetReport {
  const enabled = members.filter((m) => m.enabled);
  const reporting = enabled.flatMap((m) =>
    m.connected && m.serverConfig !== null ? [{ ...m, serverConfig: m.serverConfig }] : [],
  );
  const labels = new Map(enabled.map((m) => [m.environmentId, m.label]));
  const labelOf = (id: EnvironmentId) => labels.get(id) ?? id;

  const unreachable: FleetFinding[] = enabled
    .filter((m) => !m.connected)
    .map((m) => ({
      key: "reach",
      environmentId: m.environmentId,
      severity: "warning",
      area: "reach",
      title: "Not connected",
      detail: "Its health is unknown until it reconnects.",
    }));
  const providers = providerRows(reporting);
  const findings = [
    ...unreachable,
    ...serverFindings(reporting, labelOf),
    ...providerFindings(providers, labelOf),
    ...skillFindings(reporting, labelOf),
  ];
  const order = new Map(enabled.map((m, index) => [m.environmentId, index]));
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (order.get(a.environmentId) ?? 0) - (order.get(b.environmentId) ?? 0),
  );
  return { members: enabled, reporting, findings, providers };
}
