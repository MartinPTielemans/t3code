import { createFileRoute } from "@tanstack/react-router";
import { FleetSettingsPanel } from "../components/settings/FleetSettings";

export const Route = createFileRoute("/settings/fleet")({ component: FleetSettingsPanel });
