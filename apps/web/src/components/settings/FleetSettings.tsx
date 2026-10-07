import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  diagnoseFleet,
  type FleetFinding,
  type FleetMember,
  type FleetReport,
  type FleetSeverity,
} from "@t3tools/client-runtime/fleet";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import { ServerUpdateAction } from "../ServerUpdateAction";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SEVERITY_BADGE: Record<FleetSeverity, "error" | "warning" | "info"> = {
  error: "error",
  warning: "warning",
  info: "info",
};

const SEVERITY_LABEL: Record<FleetSeverity, string> = {
  error: "Broken",
  warning: "Differs",
  info: "Note",
};

function toFleetMember(environment: EnvironmentPresentation): FleetMember {
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    enabled: environment.entry.enabled,
    connected: environment.connection.phase === "connected",
    serverConfig: environment.serverConfig,
  };
}

function useFleetReport() {
  const { environments } = useEnvironments();
  return useMemo(() => {
    const byId = new Map(environments.map((e) => [e.environmentId, e]));
    return { report: diagnoseFleet(environments.map(toFleetMember)), byId };
  }, [environments]);
}

function machineSummary(member: FleetReport["members"][number], findings: number): string {
  if (!member.connected) return "Not connected";
  if (member.serverConfig === null) return "Loading…";
  const version = `T3 Code ${member.serverConfig.environment.serverVersion}`;
  return findings === 0
    ? `${version} · matches the fleet`
    : `${version} · ${findings} difference${findings === 1 ? "" : "s"}`;
}

function UpdateProviderButton({ finding }: { readonly finding: FleetFinding }) {
  const action = finding.action;
  const canManage = useEnvironmentScope(finding.environmentId, AuthProvidersManageScope);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  const [pending, setPending] = useState(false);
  if (action?.kind !== "update-provider") return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={!canManage || pending}
      onClick={async () => {
        setPending(true);
        try {
          const result = await updateProvider({
            environmentId: finding.environmentId,
            input: { provider: action.driver, instanceId: action.instanceId },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            toastManager.add({ type: "error", title: "Provider update failed" });
          }
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "Updating…" : "Update"}
    </Button>
  );
}

/**
 * Copies each missing skill from a machine that has it: export there, import
 * here. Skills already present are refused by the server, never overwritten.
 */
function CopySkillsButton({ finding }: { readonly finding: FleetFinding }) {
  const action = finding.action;
  const canManageHere = useEnvironmentScope(finding.environmentId, AuthProvidersManageScope);
  const exportSkill = useAtomCommand(serverEnvironment.exportProviderSkill, {
    reportFailure: false,
  });
  const importSkill = useAtomCommand(serverEnvironment.importProviderSkill, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  if (action?.kind !== "copy-skills") return null;
  const copy = async () => {
    setPending(true);
    const failed: string[] = [];
    try {
      for (const skill of action.skills) {
        const exported = await exportSkill({
          environmentId: skill.from.environmentId,
          input: { instanceId: skill.from.instanceId, name: skill.name },
        });
        if (exported._tag === "Failure") {
          if (!isAtomCommandInterrupted(exported)) failed.push(skill.name);
          continue;
        }
        const imported = await importSkill({
          environmentId: finding.environmentId,
          input: { instanceId: action.instanceId, skill: exported.value },
        });
        if (imported._tag === "Failure" && !isAtomCommandInterrupted(imported)) {
          failed.push(skill.name);
        }
      }
    } finally {
      setPending(false);
    }
    const copied = action.skills.length - failed.length;
    toastManager.add(
      failed.length === 0
        ? { type: "success", title: `Copied ${copied} skill${copied === 1 ? "" : "s"}` }
        : {
            type: "error",
            title: `Could not copy ${failed.length} skill${failed.length === 1 ? "" : "s"}`,
            description: failed.join(", "),
          },
    );
  };
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={!canManageHere || pending}
      onClick={() => void copy()}
    >
      {pending ? "Copying…" : "Copy here"}
    </Button>
  );
}

function FindingAction({
  finding,
  environment,
}: {
  readonly finding: FleetFinding;
  readonly environment: EnvironmentPresentation | undefined;
}) {
  const navigate = useNavigate();
  const action = finding.action;
  if (action === undefined || environment === undefined) return null;
  switch (action.kind) {
    case "update-server":
      return (
        <ServerUpdateAction
          environmentId={finding.environmentId}
          serverLabel={environment.label}
          selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
          installation={environment.serverConfig?.environment.capabilities.serverInstallation}
          desktopAppUpdate={supportsDesktopAppUpdate(environment.serverConfig)}
          threadContinuation={supportsServerUpdateThreadContinuation(environment.serverConfig)}
          targetVersion={action.targetVersion}
        />
      );
    case "update-provider":
      return <UpdateProviderButton finding={finding} />;
    case "copy-skills":
      return <CopySkillsButton finding={finding} />;
    case "open-provider-settings":
      return (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/settings/providers",
              search: { environmentId: finding.environmentId, instanceId: action.instanceId },
            })
          }
        >
          Open
        </Button>
      );
  }
}

function ProviderCell({ provider }: { readonly provider: ServerProvider | null }) {
  if (provider === null) return <span className="text-muted-foreground">—</span>;
  if (!provider.enabled) return <span className="text-muted-foreground">Off</span>;
  if (!provider.installed) return <Badge variant="error">Not installed</Badge>;
  if (provider.auth.status === "unauthenticated") return <Badge variant="error">Signed out</Badge>;
  const tone =
    provider.status === "error" ? "error" : provider.status === "warning" ? "warning" : null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="tabular-nums">{provider.version ?? "?"}</span>
      {tone ? <Badge variant={tone}>{tone === "error" ? "Failing" : "Warning"}</Badge> : null}
    </span>
  );
}

function ProviderMatrix({ report }: { readonly report: FleetReport }) {
  if (report.reporting.length < 2 || report.providers.length === 0) return null;
  return (
    <SettingsSection {...searchableSetting("fleet-providers")}>
      <div className="overflow-x-auto px-3 py-2 sm:px-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              {report.reporting.map((member) => (
                <TableHead key={member.environmentId}>{member.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.providers.map((row) => (
              <TableRow key={row.instanceId}>
                <TableCell>{row.label}</TableCell>
                {row.cells.map((cell) => (
                  <TableCell key={cell.environmentId}>
                    <ProviderCell provider={cell.provider} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingsSection>
  );
}

export function FleetSettingsPanel() {
  const { report, byId } = useFleetReport();
  const countByEnvironment = useMemo(() => {
    const counts = new Map<EnvironmentId, number>();
    for (const finding of report.findings) {
      counts.set(finding.environmentId, (counts.get(finding.environmentId) ?? 0) + 1);
    }
    return counts;
  }, [report.findings]);

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("fleet-machines")}>
        {report.members.length < 2 ? (
          <SettingsRow
            title="Only this machine"
            description="Add another environment in Connections to compare your machines here."
          />
        ) : (
          report.members.map((member) => (
            <SettingsRow
              key={member.environmentId}
              title={member.label}
              description={machineSummary(
                member,
                countByEnvironment.get(member.environmentId) ?? 0,
              )}
            />
          ))
        )}
      </SettingsSection>

      {report.members.length >= 2 ? (
        <SettingsSection {...searchableSetting("fleet-differences")}>
          {report.findings.length === 0 ? (
            <SettingsRow
              title="Everything matches"
              description="Every connected machine runs the same T3 Code, providers and skills."
            />
          ) : (
            report.findings.map((finding) => {
              const environment = byId.get(finding.environmentId);
              return (
                <SettingsRow
                  key={`${finding.environmentId}:${finding.key}`}
                  title={
                    <span className="inline-flex items-center gap-2">
                      <Badge variant={SEVERITY_BADGE[finding.severity]} size="sm">
                        {SEVERITY_LABEL[finding.severity]}
                      </Badge>
                      <span>
                        {environment?.label ?? finding.environmentId}: {finding.title}
                      </span>
                    </span>
                  }
                  {...(finding.detail ? { description: finding.detail } : {})}
                  control={<FindingAction finding={finding} environment={environment} />}
                />
              );
            })
          )}
        </SettingsSection>
      ) : null}

      <ProviderMatrix report={report} />
    </SettingsPageContainer>
  );
}
