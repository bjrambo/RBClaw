using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace RBClaw.Host;

internal sealed class DashboardService(
    DashboardOptions options,
    ILogger<DashboardService> logger) : IHostedService
{
    private WebApplication? app;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!options.Enabled) return;

        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls(options.Url);
        builder.Services.AddResponseCompression(compression =>
            compression.Providers.Add<GzipCompressionProvider>());
        var dashboard = builder.Build();

        dashboard.UseResponseCompression();

        dashboard.Use(async (context, next) =>
        {
            if (context.Request.Path.StartsWithSegments("/api") &&
                context.Request.Path != "/api/health" &&
                options.Token.Length > 0 && !HasValidToken(context, options.Token))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            await next(context);
        });

        dashboard.MapGet("/api/health", () => Results.Json(new { status = "ok" }));
        dashboard.MapGet("/api/status", () => Results.Json(new
        {
            service = "RBClaw.Host",
            platform = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
        }));

        if (!string.IsNullOrWhiteSpace(options.StaticDirectory))
        {
            var files = new PhysicalFileProvider(Path.GetFullPath(options.StaticDirectory));
            dashboard.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
            dashboard.UseStaticFiles(new StaticFileOptions { FileProvider = files });
        }

        try
        {
            await dashboard.StartAsync(cancellationToken);
            app = dashboard;
            logger.LogInformation("RBClaw dashboard started at {Url}", options.Url);
        }
        catch
        {
            await dashboard.DisposeAsync();
            throw;
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (app is null) return;
        await app.StopAsync(cancellationToken);
        await app.DisposeAsync();
        app = null;
    }

    private static bool HasValidToken(HttpContext context, string expected)
    {
        var header = context.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        if (!header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;

        var supplied = header[prefix.Length..].Trim();
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(expected));
        return CryptographicOperations.FixedTimeEquals(suppliedHash, expectedHash);
    }
}
