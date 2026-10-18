using System.Net;

namespace RBClaw.Host;

internal sealed record DashboardOptions(
    bool Enabled,
    string Host,
    int Port,
    string? StaticDirectory,
    string Token)
{
    public static DashboardOptions FromEnvironment()
    {
        var enabled = string.Equals(
            Environment.GetEnvironmentVariable("WEB_DASHBOARD_ENABLED"),
            "true",
            StringComparison.OrdinalIgnoreCase);
        var host = Environment.GetEnvironmentVariable("WEB_DASHBOARD_HOST")?.Trim();
        if (string.IsNullOrWhiteSpace(host)) host = "127.0.0.1";

        var portText = Environment.GetEnvironmentVariable("WEB_DASHBOARD_PORT");
        if (!int.TryParse(portText ?? "8734", out var port) || port is < 1 or > 65535)
            throw new ArgumentException("WEB_DASHBOARD_PORT must be between 1 and 65535.");

        var staticDirectory = Environment.GetEnvironmentVariable("WEB_DASHBOARD_STATIC_DIR");
        var token = Environment.GetEnvironmentVariable("WEB_DASHBOARD_TOKEN")?.Trim() ?? "";
        if (enabled && token.Length == 0 && !IsLoopback(host))
            throw new InvalidOperationException(
                "WEB_DASHBOARD_TOKEN is required when WEB_DASHBOARD_HOST is not loopback.");

        if (enabled && !string.IsNullOrWhiteSpace(staticDirectory) &&
            !Directory.Exists(staticDirectory))
            throw new DirectoryNotFoundException(
                $"WEB_DASHBOARD_STATIC_DIR does not exist: {staticDirectory}");

        return new DashboardOptions(enabled, host, port, staticDirectory, token);
    }

    public string Url => $"http://{(Host.Contains(':') && !Host.StartsWith('[') ? $"[{Host}]" : Host)}:{Port}";

    private static bool IsLoopback(string host) =>
        string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase) ||
        (IPAddress.TryParse(host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address));
}
