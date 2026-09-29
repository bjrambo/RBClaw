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
Discord transport, the dashboard HTTP API, and the MCP/agent runner bridge.
For framework-dependent deployment, the target machine needs the .NET 8 and
ASP.NET Core 8 shared runtimes because of the framework reference above.
