import { LoginStatusOutput, AccountProfile, LoginState, UsageResult } from './index.js';
import '@titan-design/agent-protocol/redaction';

interface LoginProbeInput {
    executablePath: string;
    args: readonly ["login", "status"];
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
}
interface ReadLoginOptions {
    executablePath?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal;
    runStatus?: (input: LoginProbeInput) => Promise<LoginStatusOutput>;
}
/** Model-free login status only. No auth-file reads, provisioning, login or fallback. */
declare function readLoginState(profile: AccountProfile, options?: ReadLoginOptions): Promise<LoginState>;

interface ReadUsageOptions {
    /** Total bytes across all rollouts; exceeding the bound gives unknown, never a partial reading. */
    maxBytes?: number;
    maxFiles?: number;
}
/** Read active and archived rollout JSONL only, never auth.json; any scan failure refuses. */
declare function readUsage(profile: AccountProfile, options?: ReadUsageOptions): Promise<UsageResult>;

export { type LoginProbeInput, type ReadLoginOptions, type ReadUsageOptions, readLoginState, readUsage };
