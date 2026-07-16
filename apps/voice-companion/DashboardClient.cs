using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace RBClaw.VoiceCompanion;

public sealed class DashboardClient : IDisposable
{
    private readonly HttpClient _http = new();
    private readonly HashSet<string> _seen = new();

    public async Task<IReadOnlyList<ConversationLine>> PollNewLinesAsync(
        CompanionSettings settings,
        CancellationToken cancellationToken)
    {
        var baseUrl = settings.DashboardBaseUrl.TrimEnd('/');
        var jid = Uri.EscapeDataString(settings.ChatJid);
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"{baseUrl}/api/rooms/{jid}/timeline");
        ApplyDashboardAuth(request, settings);
        using var response = await _http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var activity = await JsonSerializer.DeserializeAsync<DashboardRoomActivity>(
            stream,
            cancellationToken: cancellationToken);
        if (activity == null) return Array.Empty<ConversationLine>();

        var lines = new List<ConversationLine>();
        foreach (var output in activity.PairedTask?.Outputs ?? new List<DashboardOutput>())
        {
            if (IsVoiceTranscriptDisplay(output.OutputText)) continue;
            var key = $"output:{output.Id}";
            if (!_seen.Add(key)) continue;
            lines.Add(new ConversationLine(
                output.Role,
                output.OutputText,
                ParseTime(output.CreatedAt)));
        }

        foreach (var message in activity.Messages)
        {
            if (!message.SourceKind.Contains("bot", StringComparison.OrdinalIgnoreCase)) continue;
            if (IsVoiceTranscriptDisplay(message.Content)) continue;
            var key = $"message:{message.Id}";
            if (!_seen.Add(key)) continue;
            lines.Add(new ConversationLine(
                message.SenderName,
                message.Content,
                ParseTime(message.Timestamp)));
        }

        return lines.OrderBy(line => line.At).ToList();
    }

    public async Task SendRoomMessageAsync(
        CompanionSettings settings,
        string text,
        string requestId,
        CancellationToken cancellationToken)
    {
        var baseUrl = settings.DashboardBaseUrl.TrimEnd('/');
        var jid = Uri.EscapeDataString(settings.ChatJid);
        var payload = JsonSerializer.Serialize(new
        {
            text,
            requestId,
            nickname = $"{IpcMessageWriter.NormalizeSenderName(settings.SenderName)} Confirmed",
        });
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{baseUrl}/api/rooms/{jid}/messages")
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };
        ApplyDashboardAuth(request, settings);
        using var response = await _http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    public async Task<IReadOnlyList<AvailableRoom>> LoadAvailableGroupsAsync(
        CompanionSettings settings,
        CancellationToken cancellationToken)
    {
        var baseUrl = settings.DashboardBaseUrl.TrimEnd('/');
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"{baseUrl}/api/available-groups");
        ApplyDashboardAuth(request, settings);
        using var response = await _http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var rooms = await JsonSerializer.DeserializeAsync<AvailableGroupsResponse>(
            stream,
            cancellationToken: cancellationToken);
        return rooms?.Groups ?? new List<AvailableRoom>();
    }

    public async Task<IReadOnlyList<ConversationLine>> LoadRoomPreviewAsync(
        CompanionSettings settings,
        string chatJid,
        CancellationToken cancellationToken)
    {
        var baseUrl = settings.DashboardBaseUrl.TrimEnd('/');
        var jid = Uri.EscapeDataString(chatJid);
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"{baseUrl}/api/rooms/{jid}/timeline");
        ApplyDashboardAuth(request, settings);
        using var response = await _http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var activity = await JsonSerializer.DeserializeAsync<DashboardRoomActivity>(
            stream,
            cancellationToken: cancellationToken);
        if (activity == null) return Array.Empty<ConversationLine>();

        var lines = new List<ConversationLine>();
        foreach (var message in activity.Messages)
        {
            if (IsVoiceTranscriptDisplay(message.Content)) continue;
            lines.Add(new ConversationLine(
                message.SenderName,
                message.Content,
                ParseTime(message.Timestamp)));
        }

        foreach (var output in activity.PairedTask?.Outputs ?? new List<DashboardOutput>())
        {
            if (IsVoiceTranscriptDisplay(output.OutputText)) continue;
            lines.Add(new ConversationLine(
                output.Role,
                output.OutputText,
                ParseTime(output.CreatedAt)));
        }

        return lines.OrderBy(line => line.At).ToList();
    }

    public async Task<string?> ResolveRoomFolderAsync(
        CompanionSettings settings,
        CancellationToken cancellationToken)
    {
        var baseUrl = settings.DashboardBaseUrl.TrimEnd('/');
        var jid = Uri.EscapeDataString(settings.ChatJid);
        using (var roomRequest = new HttpRequestMessage(
            HttpMethod.Get,
            $"{baseUrl}/api/rooms/{jid}/timeline"))
        {
            ApplyDashboardAuth(roomRequest, settings);
            using var roomResponse = await _http.SendAsync(roomRequest, cancellationToken);
            roomResponse.EnsureSuccessStatusCode();
            await using var roomStream = await roomResponse.Content.ReadAsStreamAsync(cancellationToken);
            var activity = await JsonSerializer.DeserializeAsync<DashboardRoomActivity>(
                roomStream,
                cancellationToken: cancellationToken);
            if (!string.IsNullOrWhiteSpace(activity?.Folder))
            {
                return activity.Folder.Trim();
            }
        }

        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"{baseUrl}/api/rooms-timeline");
        ApplyDashboardAuth(request, settings);
        using var response = await _http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var rooms = await JsonSerializer.DeserializeAsync<Dictionary<string, DashboardRoomSummary>>(
            stream,
            cancellationToken: cancellationToken);
        if (rooms == null) return null;

        var chatJid = settings.ChatJid.Trim();
        if (rooms.TryGetValue(chatJid, out var room) && !string.IsNullOrWhiteSpace(room.Folder))
        {
            return room.Folder.Trim();
        }

        foreach (var candidate in rooms.Values)
        {
            if (
                candidate.Jid.Equals(chatJid, StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(candidate.Folder))
            {
                return candidate.Folder.Trim();
            }
        }

        return null;
    }

    private static void ApplyDashboardAuth(
        HttpRequestMessage request,
        CompanionSettings settings)
    {
        var token = settings.DashboardToken.Trim();
        if (token.Length == 0) return;
        request.Headers.TryAddWithoutValidation("x-rbclaw-dashboard-token", token);
    }

    private static DateTimeOffset ParseTime(string value)
    {
        return DateTimeOffset.TryParse(value, out var parsed)
            ? parsed
            : DateTimeOffset.Now;
    }

    private static bool IsVoiceTranscriptDisplay(string text)
    {
        return text.TrimStart().StartsWith("[voice] ", StringComparison.Ordinal);
    }

    public void Dispose()
    {
        _http.Dispose();
    }
}
