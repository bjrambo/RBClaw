using System.Text.Json.Serialization;

namespace RBClaw.VoiceCompanion;

public sealed class CompanionSettings
{
    public string DataDir { get; set; } = "";
    public string SourceGroup { get; set; } = "";
    public string ChatJid { get; set; } = "";
    public string DashboardBaseUrl { get; set; } = "http://127.0.0.1:8734";
    public string DashboardToken { get; set; } = "";
    public string SenderName { get; set; } = "Voice Companion";
    public string WakePhrase { get; set; } = "";
    public int SessionTimeoutMinutes { get; set; } = 2;
    public string SttProvider { get; set; } = "groq";
    public string ApiKey { get; set; } = "";
    public int SilenceMs { get; set; } = 1000;
    public double VoiceThreshold { get; set; } = 0.02;
    public bool IgnoreWakePhrase { get; set; }
    public bool ReadAiResponsesAloud { get; set; } = true;
    public bool PostVoiceTranscriptsToDiscord { get; set; } = true;
}

public sealed class IpcVoiceMessage
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "inject_inbound_message";

    [JsonPropertyName("chatJid")]
    public string ChatJid { get; set; } = "";

    [JsonPropertyName("text")]
    public string Text { get; set; } = "";

    [JsonPropertyName("sender")]
    public string Sender { get; set; } = "voice-companion";

    [JsonPropertyName("senderName")]
    public string SenderName { get; set; } = "Voice Companion";

    [JsonPropertyName("treatAsHuman")]
    public bool TreatAsHuman { get; set; } = true;

    [JsonPropertyName("sourceKind")]
    public string SourceKind { get; set; } = "voice_companion";

    [JsonPropertyName("nonce")]
    public string Nonce { get; set; } = "";

    [JsonPropertyName("timestamp")]
    public string Timestamp { get; set; } = "";

    [JsonPropertyName("approvalLevel")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ApprovalLevel { get; set; }

    [JsonPropertyName("approvalMethod")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ApprovalMethod { get; set; }
}

public sealed class DashboardRoomActivity
{
    [JsonPropertyName("jid")]
    public string Jid { get; set; } = "";

    [JsonPropertyName("folder")]
    public string Folder { get; set; } = "";

    [JsonPropertyName("messages")]
    public List<DashboardMessage> Messages { get; set; } = new();

    [JsonPropertyName("pairedTask")]
    public DashboardPairedTask? PairedTask { get; set; }
}

public sealed class DashboardRoomSummary
{
    [JsonPropertyName("jid")]
    public string Jid { get; set; } = "";

    [JsonPropertyName("folder")]
    public string Folder { get; set; } = "";
}

public sealed class AvailableGroupsResponse
{
    [JsonPropertyName("groups")]
    public List<AvailableRoom> Groups { get; set; } = new();

    [JsonPropertyName("lastSync")]
    public string LastSync { get; set; } = "";
}

public sealed class AvailableRoom
{
    [JsonPropertyName("jid")]
    public string Jid { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("lastActivity")]
    public string LastActivity { get; set; } = "";

    [JsonPropertyName("isRegistered")]
    public bool IsRegistered { get; set; }

    [JsonPropertyName("folder")]
    public string? Folder { get; set; }

    public override string ToString()
    {
        var name = string.IsNullOrWhiteSpace(Name) ? Jid : Name;
        var folder = string.IsNullOrWhiteSpace(Folder) ? "unregistered" : Folder;
        return $"{name} · {folder}";
    }
}

public sealed class DashboardMessage
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("senderName")]
    public string SenderName { get; set; } = "";

    [JsonPropertyName("content")]
    public string Content { get; set; } = "";

    [JsonPropertyName("timestamp")]
    public string Timestamp { get; set; } = "";

    [JsonPropertyName("sourceKind")]
    public string SourceKind { get; set; } = "";
}

public sealed class DashboardPairedTask
{
    [JsonPropertyName("outputs")]
    public List<DashboardOutput> Outputs { get; set; } = new();
}

public sealed class DashboardOutput
{
    [JsonPropertyName("id")]
    public long Id { get; set; }

    [JsonPropertyName("role")]
    public string Role { get; set; } = "";

    [JsonPropertyName("outputText")]
    public string OutputText { get; set; } = "";

    [JsonPropertyName("createdAt")]
    public string CreatedAt { get; set; } = "";
}

public sealed record ConversationLine(string Speaker, string Text, DateTimeOffset At);

public sealed record SpeechSegment(byte[] WavBytes, double Peak);
