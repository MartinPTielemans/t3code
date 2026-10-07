import type { ServerProviderSkill } from "@t3tools/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

/** Where a skill comes from: the user's own ("personal"), a repository's, a plugin's, and so on. */
export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}
