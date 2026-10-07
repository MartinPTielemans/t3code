import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { formatProviderDriverKindLabel } from "../../providerModels";
import { getProviderSummary } from "./providerStatus";

/**
 * The providers on one machine that cannot start work, under its row in
 * Connections. Each names its state and opens that machine's provider
 * settings, where it is fixed.
 */
export function ProviderAttentionLine({
  environmentId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  return (
    <p className="mt-0.5 truncate text-xs text-warning-foreground">
      {providers.map((provider, index) => (
        <span key={provider.instanceId}>
          {index > 0 ? " · " : null}
          <Link
            to="/settings/providers"
            search={{ environmentId, instanceId: provider.instanceId }}
            className="underline-offset-2 hover:underline"
          >
            {provider.displayName?.trim() || formatProviderDriverKindLabel(provider.driver)}:{" "}
            {getProviderSummary(provider).headline}
          </Link>
        </span>
      ))}
    </p>
  );
}
