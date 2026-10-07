import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  FleetEnvironmentHealth,
  FleetFinding,
  FleetFindingAction,
  FleetProviderHealth,
  FleetSeverity,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import { resolveProviderSkillSourceKind } from "./providerSkillSource.ts";
import { cliReleaseChannelOf, type CliReleaseChannel } from "./releaseChannel.ts";
import { compareSemverVersions } from "./semver.ts";

/**
 * Fleet: how the user's environments differ from each other. Each environment
 * reports its own health; this compares the reports, so a provider that is
 * signed out on the desktop or a server two releases behind shows up from
 * whichever machine the user, or an agent, is on.
 *
 * Pure: it reads nothing and starts nothing. Clients feed it the server
 * configs they hold; the `t3_fleet_status` MCP tool feeds it what linked
 * environments report. Disabled members are left out: the user switched them
 * off.
 */
export interface FleetMember {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly health: FleetEnvironmentHealth | null;
  /** Why a disconnected member could not be read, when known. */
  readonly problem?: string | undefined;
}

export interface FleetProviderRow {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  /** One entry per reporting member, in member order; null where the instance does not exist. */
  readonly cells: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly provider: FleetProviderHealth | null;
  }>;
}

type ReportingMember = FleetMember & { readonly health: FleetEnvironmentHealth };

export interface FleetReport {
  /** Enabled members, in the order given. */
  readonly members: ReadonlyArray<FleetMember>;
  /** Members whose health has arrived; only these are compared. */
  readonly reporting: ReadonlyArray<ReportingMember>;
  readonly findings: ReadonlyArray<FleetFinding>;
  readonly providers: ReadonlyArray<FleetProviderRow>;
}

/** The health an environment reports about itself, from its descriptor and provider snapshots. */
export function fleetHealthOf(input: {
  readonly environment: Pick<
    ExecutionEnvironmentDescriptor,
    "environmentId" | "label" | "serverVersion" | "orchestrationProtocolVersion" | "capabilities"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
}): FleetEnvironmentHealth {
  const { environment } = input;
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    serverVersion: environment.serverVersion,
    ...(environment.orchestrationProtocolVersion === undefined
      ? {}
      : { orchestrationProtocolVersion: environment.orchestrationProtocolVersion }),
    providerSkillTransfer: environment.capabilities.providerSkillTransfer === true,
    providers: input.providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      enabled: provider.enabled,
      installed: provider.installed,
      version: provider.version,
      status: provider.status,
      authStatus: provider.auth.status,
      ...(provider.message ? { message: provider.message } : {}),
      ...(provider.availability ? { availability: provider.availability } : {}),
      ...(provider.unavailableReason ? { unavailableReason: provider.unavailableReason } : {}),
      ...(provider.versionAdvisory ? { versionAdvisory: provider.versionAdvisory } : {}),
      personalSkills: provider.skills
        .filter((skill) => resolveProviderSkillSourceKind(skill) === "personal")
        .map((skill) => skill.name),
    })),
  };
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

export const fleetProviderLabel = (
  provider: Pick<FleetProviderHealth, "displayName" | "instanceId">,
) => provider.displayName ?? provider.instanceId;

const newestVersion = (versions: ReadonlyArray<string>) =>
  versions.reduce<string | null>(
    (newest, version) =>
      newest === null || compareSemverVersions(version, newest) > 0 ? version : newest,
    null,
  );

function serverFindings(
  reporting: ReadonlyArray<ReportingMember>,
  labelOf: (id: EnvironmentId) => string,
): FleetFinding[] {
  const out: FleetFinding[] = [];
  const byChannel = new Map<CliReleaseChannel, ReportingMember[]>();
  for (const member of reporting) {
    const channel = cliReleaseChannelOf(member.health.serverVersion);
    byChannel.set(channel, [...(byChannel.get(channel) ?? []), member]);
  }
  // Releases on one train are comparable; a nightly is never "behind" a stable.
  for (const [channel, members] of byChannel) {
    const newest = newestVersion(members.map((m) => m.health.serverVersion));
    if (newest === null) continue;
    const onNewest = members.filter((m) => m.health.serverVersion === newest).map((m) => m.label);
    for (const member of members) {
      const version = member.health.serverVersion;
      if (compareSemverVersions(version, newest) >= 0) continue;
      out.push({
        key: "server-behind",
        environmentId: member.environmentId,
        severity: "warning",
        area: "server",
        title: `T3 Code ${version} is behind ${newest}`,
        detail: `${joinNames(onNewest)} ${onNewest.length === 1 ? "runs" : "run"} ${newest} on the ${channel} channel.`,
        action: { _tag: "update-server", targetVersion: newest },
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
    m.health.orchestrationProtocolVersion === undefined
      ? []
      : [{ member: m, protocol: m.health.orchestrationProtocolVersion }],
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

function providerRows(reporting: ReadonlyArray<ReportingMember>): FleetProviderRow[] {
  const rows = new Map<ProviderInstanceId, FleetProviderRow>();
  for (const member of reporting) {
    for (const provider of member.health.providers) {
      if (rows.has(provider.instanceId)) continue;
      rows.set(provider.instanceId, {
        instanceId: provider.instanceId,
        driver: provider.driver,
        label: fleetProviderLabel(provider),
        cells: reporting.map((m) => ({
          environmentId: m.environmentId,
          provider: m.health.providers.find((p) => p.instanceId === provider.instanceId) ?? null,
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
    const settings: FleetFindingAction = { _tag: "open-provider-settings", instanceId };
    const enabledOn = row.cells.filter((c) => c.provider?.enabled).map((c) => c.environmentId);
    const working = row.cells.flatMap((c) =>
      c.provider?.enabled && c.provider.installed && c.provider.version !== null
        ? [{ environmentId: c.environmentId, version: c.provider.version }]
        : [],
    );
    const newestInstalled = newestVersion(working.map((w) => w.version));

    for (const { environmentId, provider } of row.cells) {
      if (provider === null) continue;
      const key = (what: string) => `provider-${what}:${instanceId}`;
      const update: FleetFindingAction = {
        _tag: "update-provider",
        instanceId,
        driver: provider.driver,
      };
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
      if (provider.authStatus === "unauthenticated") {
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
            ? { action: update }
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
          .filter((w) => w.version === newestInstalled)
          .map((w) => labelOf(w.environmentId));
        out.push({
          key: key("older"),
          environmentId,
          severity: "info",
          area: "provider",
          title: `${label} ${provider.version} is older than ${joinNames(ahead)}'s ${newestInstalled}`,
          ...(advisory?.canUpdate ? { action: update } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Personal skills that some machines have and others lack, per provider
 * driver. Project skills differ by checkout and are not compared.
 */
function skillFindings(
  reporting: ReadonlyArray<ReportingMember>,
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
    const byDriver = new Map<ProviderDriverKind, DriverSkills>();
    for (const provider of member.health.providers) {
      if (!provider.enabled || !provider.installed) continue;
      const entry = byDriver.get(provider.driver) ?? {
        environmentId: member.environmentId,
        canTransfer: member.health.providerSkillTransfer,
        instanceId: provider.instanceId,
        providerLabel: fleetProviderLabel(provider),
        skills: new Set<string>(),
      };
      for (const skill of provider.personalSkills) entry.skills.add(skill);
      byDriver.set(provider.driver, entry);
    }
    for (const [driver, entry] of byDriver) {
      perDriver.set(driver, [...(perDriver.get(driver) ?? []), entry]);
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
        ? names.flatMap((name) => {
            const from = missing.get(name)?.find((source) => source.canTransfer);
            return from
              ? [{ name, from: { environmentId: from.environmentId, instanceId: from.instanceId } }]
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
          ? { action: { _tag: "copy-skills", instanceId: member.instanceId, skills: copies } }
          : {}),
      });
    }
  }
  return out;
}

export function diagnoseFleet(members: ReadonlyArray<FleetMember>): FleetReport {
  const enabled = members.filter((m) => m.enabled);
  const reporting = enabled.flatMap((m): ReportingMember[] =>
    m.connected && m.health !== null ? [{ ...m, health: m.health }] : [],
  );
  const labels = new Map(enabled.map((m) => [m.environmentId, m.label]));
  const labelOf = (id: EnvironmentId) => labels.get(id) ?? id;

  const unreachable = enabled
    .filter((m) => !m.connected)
    .map((m): FleetFinding => ({
      key: "reach",
      environmentId: m.environmentId,
      severity: "warning",
      area: "reach",
      title: "Not connected",
      detail: m.problem ?? "Its health is unknown until it reconnects.",
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
