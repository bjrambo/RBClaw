using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using RBClaw.Host;

if (args is ["run-agent"])
{
    await AgentRunnerCommand.RunAsync();
    return;
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddSingleton(DashboardOptions.FromEnvironment());
builder.Services.AddSingleton<AgentRunnerBridge>();
builder.Services.AddHostedService<RuntimeWorker>();
builder.Services.AddHostedService<DashboardService>();

await builder.Build().RunAsync();
