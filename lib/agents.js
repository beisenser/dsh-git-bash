export const name = "git-bash-agent-shell";
export const inject = ["agents", "tools", "systemPrompt"];
// Make the global Git Bash-backed Bash tool win over preset-provided shells.
export function apply(ctx) {
    const installed = new Map();
    const install = (agent) => {
        if (installed.has(agent))
            return;
        let cleanup;
        cleanup = agent.ctx.effect(() => {
            const disposers = [];
            const globalBash = ctx.tools.get("bash");
            if (!globalBash) {
                throw new Error("git-bash-agent-shell: the global bash tool is unavailable; keep the tool-bash row enabled");
            }
            disposers.push(agent.ctx.tools.register(globalBash));
            if (ctx.tools.get("pwsh", agent)) {
                disposers.push(agent.ctx.tools.restrict({ deny: ["pwsh"] }));
            }
            disposers.push(agent.ctx.systemPrompt.section({
                name: "tool:bash",
                order: 105,
                text: "Check the [exit code: N] marker on every Git Bash result; investigate failures before moving on.",
            }));
            disposers.push(agent.ctx.systemPrompt.section({
                name: "tool:pwsh",
                order: 105,
                text: "",
            }));
            return () => {
                for (const dispose of disposers.reverse())
                    dispose();
                if (installed.get(agent) === cleanup)
                    installed.delete(agent);
            };
        }, "git-bash-agent-shell.install()");
        installed.set(agent, cleanup);
    };
    ctx.effect(() => {
        const stopCreated = ctx.on("agent/created", ({ agent }) => {
            install(agent);
            return undefined;
        });
        const stopDisposed = ctx.on("agent/disposed", ({ agent }) => installed.delete(agent));
        for (const agent of ctx.agents.list())
            install(agent);
        return async () => {
            stopCreated();
            stopDisposed();
            const cleanups = [...installed.values()];
            installed.clear();
            await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve(cleanup())));
        };
    }, "git-bash-agent-shell.lifecycle()");
}
//# sourceMappingURL=agents.js.map