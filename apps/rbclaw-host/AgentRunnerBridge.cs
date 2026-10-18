using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RBClaw.Host;

internal sealed record AgentRunnerRequest(
    string Prompt,
    string ChatJid,
    string GroupFolder,
    bool IsMain,
    string? SessionId = null);

internal sealed record AgentRunnerResult(
    string Status,
    string? Result,
    string? Error,
    string? NewSessionId);

internal sealed class AgentRunnerBridge
{
    private const string StartMarker = "---RBCLAW_OUTPUT_START---";
    private const string EndMarker = "---RBCLAW_OUTPUT_END---";
    private const int MaxFrameCharacters = 1_000_000;
    private const int MaxErrorCharacters = 16_384;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string bunExecutable;
    private readonly string runnerEntry;
    private readonly string groupsDirectory;
    private readonly TimeSpan timeout;

    public AgentRunnerBridge()
    {
        bunExecutable = Environment.GetEnvironmentVariable("RBCLAW_BUN_EXECUTABLE")?.Trim() is { Length: > 0 } bun
            ? bun : "bun";
        runnerEntry = Environment.GetEnvironmentVariable("RBCLAW_RUNNER_ENTRY")?.Trim() ?? "";
        groupsDirectory = Environment.GetEnvironmentVariable("RBCLAW_GROUPS_DIR")?.Trim() is { Length: > 0 } groups
            ? Path.GetFullPath(groups) : Path.GetFullPath("groups");
        timeout = TimeSpan.FromMinutes(30);
    }

    public async Task<AgentRunnerResult> RunAsync(
        AgentRunnerRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Prompt))
            throw new ArgumentException("Agent prompt is required.", nameof(request));
        if (string.IsNullOrWhiteSpace(request.ChatJid))
            throw new ArgumentException("Chat JID is required.", nameof(request));
        if (string.IsNullOrWhiteSpace(request.GroupFolder) ||
            request.GroupFolder is "." or ".." ||
            request.GroupFolder.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            request.GroupFolder.Contains('/') || request.GroupFolder.Contains('\\'))
            throw new ArgumentException("Group folder must be a single safe directory name.", nameof(request));
        if (runnerEntry.Length == 0 || !File.Exists(runnerEntry))
            throw new FileNotFoundException("Set RBCLAW_RUNNER_ENTRY to the built Bun runner entry.", runnerEntry);

        var groupDir = Path.Combine(groupsDirectory, request.GroupFolder);
        var ipcDir = Path.Combine(groupDir, "ipc");
        Directory.CreateDirectory(ipcDir);

        var start = new ProcessStartInfo(bunExecutable)
        {
            WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(runnerEntry))!,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(Path.GetFullPath(runnerEntry));
        start.Environment["RBCLAW_GROUP_DIR"] = groupDir;
        start.Environment["RBCLAW_GROUP_FOLDER"] = request.GroupFolder;
        start.Environment["RBCLAW_CHAT_JID"] = request.ChatJid;
        start.Environment["RBCLAW_WORK_DIR"] = groupDir;
        start.Environment["RBCLAW_GLOBAL_DIR"] = Path.Combine(groupsDirectory, "global");
        start.Environment["RBCLAW_IPC_DIR"] = ipcDir;
        start.Environment["RBCLAW_HOST_IPC_DIR"] = ipcDir;
        start.Environment["RBCLAW_IS_MAIN"] = request.IsMain ? "1" : "0";
        start.Environment["RBCLAW_AGENT_TYPE"] = "claude-code";

        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new InvalidOperationException("Bun agent runner did not start.");

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        linked.CancelAfter(timeout);
        try
        {
            var outputTask = ReadLastFrameAsync(process.StandardOutput, linked.Token);
            var errorTask = ReadLimitedAsync(process.StandardError, MaxErrorCharacters, linked.Token);
            await process.StandardInput.WriteAsync(JsonSerializer.Serialize(request, JsonOptions));
            process.StandardInput.Close();

            var exitTask = process.WaitForExitAsync(linked.Token);
            var firstCompleted = await Task.WhenAny(exitTask, outputTask, errorTask);
            await firstCompleted;
            await exitTask;
            var frame = await outputTask;
            var error = await errorTask;
            if (frame is null)
                throw new InvalidDataException($"Bun runner returned no output frame (exit {process.ExitCode}): {error}");

            var result = JsonSerializer.Deserialize<AgentRunnerResult>(frame, JsonOptions)
                ?? throw new InvalidDataException("Bun runner returned an empty result.");
            if (result.Status is not ("success" or "error"))
                throw new InvalidDataException("Bun runner returned an unknown status.");
            if (process.ExitCode != 0 && result.Status == "success")
                throw new InvalidDataException($"Bun runner exited with code {process.ExitCode}: {error}");
            return result;
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
            }
        }
    }

    private static async Task<string?> ReadLastFrameAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        var frame = new StringBuilder();
        string? lastFrame = null;
        var insideFrame = false;
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            if (line == StartMarker)
            {
                frame.Clear();
                insideFrame = true;
            }
            else if (line == EndMarker && insideFrame)
            {
                lastFrame = frame.ToString();
                insideFrame = false;
            }
            else if (insideFrame)
            {
                if (frame.Length + line.Length > MaxFrameCharacters)
                    throw new InvalidDataException("Bun runner output frame exceeded the size limit.");
                frame.AppendLine(line);
            }
        }
        return lastFrame;
    }

    private static async Task<string> ReadLimitedAsync(
        StreamReader reader,
        int maxCharacters,
        CancellationToken cancellationToken)
    {
        var output = new StringBuilder();
        var buffer = new char[4096];
        int read;
        while ((read = await reader.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (output.Length < maxCharacters)
                output.Append(buffer.AsSpan(0, Math.Min(read, maxCharacters - output.Length)));
        }
        return output.ToString();
    }
}
