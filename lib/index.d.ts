import type { Context } from "@deepseek-ai/cordis";
import type { Config as LocalBashConfig } from "@deepseek-ai/dsh-bash-local";
import { SandboxBashExecutor } from "@deepseek-ai/dsh-bash-sandbox";
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from "@deepseek-ai/dsh-shell";
import z from "@deepseek-ai/schemastery";
export { GIT_BASH_PATH_ENV, gitBashCandidates, resolveGitBashPath } from "./discovery.js";
export interface Config extends LocalBashConfig {
    executable?: string;
}
export declare const Config: z<Config>;
export declare function describeGuardFailure(detail: string): string;
export declare class GitBashExecutor extends SandboxBashExecutor {
    static inject: string[];
    static Config: typeof SandboxBashExecutor.Config;
    private executableCache;
    private readonly guardedFacts;
    constructor(ctx: Context, config: Config);
    get executable(): string;
    resolve(request: ShellExecRequest): ShellExecSpec;
    private argv;
    private guardedArgv;
    private policy;
    private confineGitBash;
    private static decorateRoutedResult;
    private serverDaclNormalized;
    private ensureServerDaclNormalized;
    execute(spec: ShellExecSpec): Promise<ShellExecution>;
}
export default GitBashExecutor;
//# sourceMappingURL=index.d.ts.map