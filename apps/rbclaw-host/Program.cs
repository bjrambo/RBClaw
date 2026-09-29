using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using RBClaw.Host;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddHostedService<RuntimeWorker>();

await builder.Build().RunAsync();
