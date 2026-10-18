# RBClaw .NET Host

Cross-platform console host for a future C# RBClaw runtime. The initial scope
provides the service lifecycle, dependency injection, logging, and graceful
shutdown.

The console project targets .NET 8 because that SDK is available in the current
development environment. `Microsoft.AspNetCore.App` is a framework reference,
not a downloaded NuGet package. It supplies the hosting APIs and can also
support the dashboard HTTP server when that component is implemented.

Run from the repository root with the .NET 8 SDK installed. The same command
works in Bash and PowerShell:

```bash
dotnet run --project apps/rbclaw-host/RBClaw.Host.csproj
```

Press Ctrl+C to stop the host. The intended next components are SQLite storage,
Discord transport, the full dashboard HTTP API, and the MCP server.
For framework-dependent deployment, the target machine needs the .NET 8 and
ASP.NET Core 8 shared runtimes because of the framework reference above.

The HTTP host can be enabled with `WEB_DASHBOARD_ENABLED=true`. It binds to
`127.0.0.1:8734` by default and currently exposes `/api/health` and
`/api/status`. Set `WEB_DASHBOARD_STATIC_DIR` to an existing directory to
serve dashboard assets. When binding outside loopback, set
`WEB_DASHBOARD_TOKEN`; API requests then need an `Authorization: Bearer <token>`
header. The full Bun dashboard API has not yet been ported.

`AgentRunnerBridge` can invoke the existing built Bun runner. Set
`RBCLAW_RUNNER_ENTRY` to its `dist/index.js`; `RBCLAW_BUN_EXECUTABLE` can
override the `bun` executable path. This bridge currently handles owner turns
only. Reviewer and arbiter roles still need a Windows-compatible read-only
isolation mechanism before they can run on Windows.

For a manual process-boundary check, run the host with the `run-agent` argument
and set `RBCLAW_RUNNER_ENTRY` to `apps/rbclaw-host/fixtures/fake-runner.js`.
Send a JSON request such as
`{"prompt":"hello","chatJid":"dc:test","groupFolder":"smoke","isMain":true}`
on standard input. The command returns the runner's final JSON result.
