export declare const GIT_BASH_PATH_ENV = "DSH_GIT_BASH_PATH";
export interface GitBashDiscoveryOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}
export declare function gitBashCandidates(env?: NodeJS.ProcessEnv): string[];
export declare function resolveGitBashPath(executable?: string, options?: GitBashDiscoveryOptions): string;
//# sourceMappingURL=discovery.d.ts.map