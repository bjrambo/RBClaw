using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace RBClaw.VoiceCompanion;

public sealed class WhisperTranscriber : IDisposable
{
    private readonly HttpClient _http = new();

    public async Task<string> TranscribeAsync(
        CompanionSettings settings,
        byte[] wavBytes,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(settings.ApiKey))
        {
            throw new InvalidOperationException("STT API key is empty.");
        }

        var provider = settings.SttProvider.Trim().ToLowerInvariant();
        var endpoint = provider == "openai"
            ? "https://api.openai.com/v1/audio/transcriptions"
            : "https://api.groq.com/openai/v1/audio/transcriptions";
        var model = provider == "openai"
            ? "whisper-1"
            : "whisper-large-v3-turbo";

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", settings.ApiKey);

        using var form = new MultipartFormDataContent();
        form.Add(new StringContent(model), "model");
        form.Add(new StringContent("ko"), "language");
        form.Add(new ByteArrayContent(wavBytes), "file", "speech.wav");
        request.Content = form;

        using var response = await _http.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        response.EnsureSuccessStatusCode();

        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("text", out var text)
            ? text.GetString()?.Trim() ?? ""
            : "";
    }

    public void Dispose()
    {
        _http.Dispose();
    }
}
