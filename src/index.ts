import type { Context } from "@deepseek-ai/cordis";
import { assertServiceableBashConfig } from "@deepseek-ai/dsh-bash-local";
import type { Config as LocalBashConfig } from "@deepseek-ai/dsh-bash-local";
import { SandboxBashExecutor } from "@deepseek-ai/dsh-bash-sandbox";
import { SandboxUnavailableError } from "@deepseek-ai/dsh-sandbox";
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxPolicy,
} from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcess,
  ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import z from "@deepseek-ai/schemastery";
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitBashPath } from "./discovery.js";

export { GIT_BASH_PATH_ENV, gitBashCandidates, resolveGitBashPath } from "./discovery.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_EXECUTABLE = resolve(
  PACKAGE_ROOT,
  "native",
  "bin",
  "win32-x64",
  "msys-token-guard.exe",
);
const GUARD_HOOK = resolve(
  PACKAGE_ROOT,
  "native",
  "bin",
  "win32-x64",
  "msys-token-guard-hook.dll",
);
const EXECUTABLE_SPAWN_CODES = new Set(["EACCES", "ENOENT"]);
const GIT_BASH_EXECUTABLE_PATTERN =
  /^(?:[A-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|%[^%]+%[\\/])(?:.*[\\/])?bash\.exe$/i;
const GUARD_FAILURE_RULE: RunnerFailureRule = {
  allowedExitCodes: [125],
  fatalSignatures: ["msys-token-guard:"],
};
// The guard's child-token setup fails when the restricted DACL (inherited from
// the server token's default DACL) offers no usable ordinary SID to the guard.
const SERVER_DACL_FAILURE_SIGNATURE = "openprocesstoken(child default dacl)";

// DSH derives every restricted token from the server's own process token, and
// the restricted DACL starts as a copy of the server's default DACL. Servers
// started outside MSYS2 can carry a DACL without the user SID, which blocks
// the guard's workspace-write child-token setup (exit 125). Run the guard
// helper once per server process to stamp the standard DACL shape — the same
// normalization starting `dsh web` from Git Bash gets for free.
function normalizeServerDefaultDacl(): boolean {
  if (process.platform !== "win32" || process.arch !== "x64") return false;
  let result;
  try {
    result = spawnSync(GUARD_EXECUTABLE, ["--normalize-server-dacl"], {
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    return false;
  }
  return result.status === 0;
}

export interface Config extends LocalBashConfig {
  // Absolute Git for Windows bash.exe path. Auto-detected when omitted.
  executable?: string;
}

const LOCAL_BASH_CONFIG = SandboxBashExecutor.Config;

type ResolvedGitBashConfig = Required<Omit<Config, "cwd">> & Pick<Config, "cwd">;

// Keep the field schema permissive enough to render a recovery card for a
// legacy bad value; resolveConfiguredExecutable enforces it on new writes and use.
export const Config = z.intersect([
  LOCAL_BASH_CONFIG,
  z.object({
    executable: z.string()
      .default("")
      .role("path")
      .description("Absolute path to Git for Windows bash.exe; blank uses automatic discovery."),
  }),
]) as z<Config>;

function resolveConfiguredExecutable(config: Config): string | undefined {
  const executable = config.executable?.trim();
  if (!executable) return undefined;
  if (!GIT_BASH_EXECUTABLE_PATTERN.test(executable)) {
    throw new TypeError(
      "git-bash: executable must be an absolute Windows path ending in bash.exe",
    );
  }
  return resolveGitBashPath(executable);
}

function checkedCompositionConfig(config: Config): Config {
  // Blank configuration intentionally defers auto-discovery so the settings
  // card remains available on hosts that still need Git for Windows configured.
  resolveConfiguredExecutable(config);
  return config;
}

interface RunnerFailureMatch {
  detail: string;
}

interface ProcessFacts {
  mode: ConfinedSandboxMode;
  enforcement: SandboxEnforcement;
  denialSignatures: readonly string[];
  runnerFailureRules: readonly RunnerFailureRule[];
  runnerProgram: string | undefined;
  workdir: string;
}

function isUsableWorkdir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isRunnerSpawnFailure(
  error: unknown,
  runnerProgram: string | undefined,
  workdir: string,
): boolean {
  if (runnerProgram === undefined || !isUsableWorkdir(workdir)) return false;
  if (typeof error !== "object" || error === null) return false;
  const { code, path, syscall } = error as NodeJS.ErrnoException;
  if (typeof code !== "string" || !EXECUTABLE_SPAWN_CODES.has(code)) return false;
  if (typeof syscall !== "string") return false;

  const exactSyscall = "spawn " + runnerProgram;
  if (path === undefined) return syscall === exactSyscall;
  if (typeof path !== "string" || path.length === 0 || path !== runnerProgram) return false;
  return syscall === "spawn" || syscall === exactSyscall;
}

function matchesSignature(
  exitCode: number | null,
  stderr: string,
  signatures: readonly string[],
): boolean {
  if (exitCode === null || exitCode === 0) return false;
  const lowered = stderr.toLowerCase();
  return signatures.some((signature) => lowered.includes(signature.toLowerCase()));
}

function classifyDenial(result: ShellRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures);
}

// Turn the guard's bare DACL failure line into an actionable message: the
// automatic normalization ran (or was skipped) and the server still serves
// restricted tokens without ordinary user coverage.
export function describeGuardFailure(detail: string): string {
  if (!detail.toLowerCase().includes(SERVER_DACL_FAILURE_SIGNATURE)) return detail;
  return detail + " (git-bash: the DSH server process token's default DACL lacks the user SID,"
    + " so the guard cannot prepare the restricted child token. Start `dsh web` from Git Bash"
    + " so MSYS2 restores the standard DACL shape, and see"
    + " https://github.com/inmny/dsh-git-bash/issues/4)";
}

function classifyRunnerFailure(
  exitCode: number | null,
  stderr: string,
  rules: readonly RunnerFailureRule[],
): RunnerFailureMatch | undefined {  if (exitCode === null || exitCode === 0) return undefined;
  const lines = stderr.split(/\r?\n/);
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) {
      continue;
    }
    const informationalLines = new Set(
      (rule.informationalLines ?? []).map((line) => line.toLowerCase()),
    );
    const fatalSignatures = rule.fatalSignatures
      .filter((signature) => signature.trim().length > 0)
      .map((signature) => signature.toLowerCase());
    for (const line of lines) {
      const lowered = line.toLowerCase();
      if (informationalLines.has(lowered)) continue;
      if (fatalSignatures.some((signature) => lowered.includes(signature))) {
        return { detail: line };
      }
    }
  }
  return undefined;
}

function assertNativeGuard(mode: ConfinedSandboxMode): void {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new SandboxUnavailableError(
      mode,
      "Git Bash restricted mode requires win32-x64, received " +
        process.platform + "-" + process.arch,
    );
  }

  for (const artifact of [GUARD_EXECUTABLE, GUARD_HOOK]) {
    try {
      if (!statSync(artifact).isFile()) throw new Error("not a file");
      accessSync(artifact, constants.R_OK);
    } catch (error) {
      throw new SandboxUnavailableError(
        mode,
        "Git Bash native guard artifact is unavailable: " + artifact + " (" + String(error) + ")",
      );
    }
  }
}

// DSH shell executor backed by Git for Windows Bash.
//
// DSH 0.2.x exposes one execution entry point — `execute(spec)` — on
// `ShellExecutor`; the 0.1.x `run`/`start` pair and its `runArgv`/`startArgv`
// helpers are gone. This executor therefore extends the sandbox-consuming
// `SandboxBashExecutor` (the provider the profile mounts at `ctx.shell`) and
// mirrors its `execute` line for line, substituting only the argv: the guard
// when confined, and the resolved `bash.exe` when not (the parent's
// full-access path hardcodes the bare `bash` name, which on Windows resolves
// to the WSL launcher under System32).
export class GitBashExecutor extends SandboxBashExecutor {
  static override inject = ["subprocess", "sandbox", "sandboxPolicy"];
  static override Config = Config as unknown as typeof SandboxBashExecutor.Config;

  private executableCache: { configured: string; resolved: string } | undefined;
  private readonly guardedFacts = new Map<ShellProcess, ProcessFacts>();

  constructor(ctx: Context, config: Config) {
    // Keep the inherited process mechanics as-is. The extended, executable-aware
    // Config travels with the plugin row: DSH 0.2.x keys a plugin's live Config
    // form by the loader row id and reads the schema straight off this class, so
    // there is no settings section to register here (the 0.1.x
    // `settings.installSection`/`register` seam is gone). Configure `executable`
    // through the row config in the profile patch, `DSH_GIT_BASH_PATH`, or
    // automatic discovery.
    super(ctx, checkedCompositionConfig(config));
  }

  get executable(): string {
    const config = this.config as Config;
    const configured = config.executable?.trim() ?? "";
    if (this.executableCache?.configured === configured) {
      return this.executableCache.resolved;
    }

    const resolved = resolveConfiguredExecutable(config) ?? resolveGitBashPath();
    this.executableCache = { configured, resolved };
    return resolved;
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const resolved = super.resolve(request);
    return {
      ...resolved,
      env: {
        ...(resolved.env ?? {}),
        // Keep Git/MSYS2 Bash in the workspace directory instead of
        // changing to $HOME on login-shell startup.
        CHERE_INVOKING: "1",
      },
    };
  }

  private argv(command: string): readonly string[] {
    return [this.executable, "--login", "-c", command];
  }

  private guardedArgv(command: string, mode: ConfinedSandboxMode): readonly string[] {
    assertNativeGuard(mode);
    return [GUARD_EXECUTABLE, "--", ...this.argv(command)];
  }

  private policy(spec: ShellExecSpec): SandboxExecutionPolicy {
    if (!spec.sandboxPolicy) {
      throw new Error("git-bash: resolved execution is missing sandbox policy");
    }
    return spec.sandboxPolicy;
  }

  // The parent's `confine` and `decorateResult` are private, so the two small
  // steps that need the Git Bash argv live here; everything else stays
  // inherited (onProcessDone, sandboxMode, resolve, process mechanics).
  private async confineGitBash(command: string, policy: SandboxPolicy): Promise<ConfinedArgv> {
    this.ensureServerDaclNormalized();
    const confined = await this.ctx.sandbox.confine(
      this.guardedArgv(command, policy.mode),
      policy,
    );
    return {
      ...confined,
      runnerFailureRules: [...confined.runnerFailureRules, GUARD_FAILURE_RULE],
    };
  }

  private static decorateRoutedResult(
    ex: ShellExecution,
    map: (result: ShellRunResult) => ShellRunResult,
    mapError: (error: unknown) => never,
  ): ShellExecution {
    const base = ex.result.bind(ex);
    let decorated: Promise<ShellRunResult> | undefined;
    ex.result = () => {
      decorated ??= base().then(map, mapError);
      return decorated;
    };
    return ex;
  }

  private serverDaclNormalized = false;

  private ensureServerDaclNormalized(): void {
    if (this.serverDaclNormalized) return;
    this.serverDaclNormalized = true;
    normalizeServerDefaultDacl();
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const policy = this.policy(spec);
    const { mode } = policy;

    // Full access bypasses the sandbox seam entirely, so the guard is not used
    // and the resolved bash.exe is spawned directly.
    if (mode === "danger-full-access") {
      const ex = await this.executeArgv(spec, this.argv(spec.command));
      return GitBashExecutor.decorateRoutedResult(
        ex,
        (result) => ({ ...result, sandbox: { mode, denied: false } }),
        (error) => {
          throw error;
        },
      );
    }

    let confined: ConfinedArgv | undefined;
    const ex = await this.executeArgv(
      spec,
      async (signal) => {
        const prepared = await this.confineGitBash(spec.command, { ...policy, mode });
        signal.throwIfAborted();
        confined = prepared;
        return prepared.argv;
      },
      (process) => {
        const facts = confined;
        if (facts === undefined) return;
        this.guardedFacts.set(process, {
          mode,
          enforcement: facts.enforcement,
          denialSignatures: facts.denialSignatures,
          runnerFailureRules: facts.runnerFailureRules,
          runnerProgram: facts.argv[0],
          workdir: spec.workdir,
        });
      },
    );

    return GitBashExecutor.decorateRoutedResult(
      ex,
      (result) => {
        if (confined === undefined) {
          return { ...result, sandbox: { mode, denied: false } };
        }
        const { enforcement, denialSignatures, runnerFailureRules } = confined;
        const runnerFailure = classifyRunnerFailure(
          result.exitCode,
          result.stderr.text,
          runnerFailureRules,
        );
        if (runnerFailure !== undefined) {
          throw new SandboxUnavailableError(mode, describeGuardFailure(runnerFailure.detail));
        }
        return {
          ...result,
          sandbox: {
            mode,
            denied: classifyDenial(result, denialSignatures),
            enforcement,
          },
        };
      },
      (error) => {
        if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
        if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
          throw new SandboxUnavailableError(mode, String(error));
        }
        throw error;
      },
    );
  }
}

export default GitBashExecutor;
