type RestartPolicy = "always" | "on-failure" | "never";
/** launchd's ProcessType values; `Background` throttles CPU and I/O. */
type LaunchdProcessType = "Standard" | "Background" | "Adaptive" | "Interactive";
interface ServiceSpec {
    /** The launchd Label, reverse-DNS by convention. systemd names a unit by its file, so it ignores this. */
    label: string;
    description: string;
    /** The program and its arguments; the first entry must be an absolute path. */
    argv: readonly string[];
    /** Written in insertion order. */
    environment: Readonly<Record<string, string>>;
    stdoutPath: string;
    stderrPath: string;
    /** Defaults to "always". */
    restart?: RestartPolicy;
    /** Seconds systemd waits before a restart. Defaults to 5. */
    restartSec?: number;
    /** Omitted from the plist when unset. */
    launchdProcessType?: LaunchdProcessType;
}
declare function renderSystemdUserService(spec: ServiceSpec): string;
declare function renderLaunchAgentPlist(spec: ServiceSpec): string;

export { type LaunchdProcessType, type RestartPolicy, type ServiceSpec, renderLaunchAgentPlist, renderSystemdUserService };
