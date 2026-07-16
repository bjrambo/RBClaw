using System.IO;
using System.Text.Json;

namespace RBClaw.VoiceCompanion;

public sealed class IpcMessageWriter
{
    private const string LegacyWslUncPrefix = @"\\wsl$\";
    private const string LocalhostWslUncPrefix = @"\\wsl.localhost\";
    private const string LegacyStoreSuffix = @"\store";
    private const string CurrentDataSuffix = @"\data";
    private static readonly char[] UnsafeSourceGroupChars =
        ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    public string WriteMessage(
        CompanionSettings settings,
        string text,
        string? approvalLevel = null,
        string? approvalMethod = null)
    {
        // approvalLevel/approvalMethod are audit and UX metadata only.
        // RBClaw enforces high-risk voice request policy at server ingress.
        var nonce = $"voice-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid():N}";
        var payload = new IpcVoiceMessage
        {
            ChatJid = settings.ChatJid,
            Text = text,
            SenderName = NormalizeSenderName(settings.SenderName),
            Nonce = nonce,
            Timestamp = DateTimeOffset.UtcNow.ToString("O"),
            ApprovalLevel = approvalLevel,
            ApprovalMethod = approvalMethod,
        };

        return WritePayload(settings, nonce, payload);
    }

    public string WriteDiscordTranscriptMessage(CompanionSettings settings, string text)
    {
        var nonce = $"voice-display-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid():N}";
        var senderName = NormalizeSenderName(settings.SenderName);
        var payload = new IpcVoiceMessage
        {
            Type = "message",
            ChatJid = settings.ChatJid,
            Text = $"[voice] {senderName}: {text}",
            Sender = "voice-companion",
            SenderName = senderName,
            TreatAsHuman = false,
            SourceKind = "voice_companion",
            Nonce = nonce,
            Timestamp = DateTimeOffset.UtcNow.ToString("O"),
        };

        return WritePayload(settings, nonce, payload);
    }

    private static string WritePayload(CompanionSettings settings, string nonce, IpcVoiceMessage payload)
    {
        if (!TryValidateDataDir(settings.DataDir, out var dataDirError))
        {
            throw new InvalidOperationException(dataDirError);
        }

        if (!TryValidateRouting(settings, out var routingError))
        {
            throw new InvalidOperationException(routingError);
        }

        var dataDir = NormalizeDataDir(settings.DataDir);
        var sourceGroup = NormalizeSourceGroup(settings.SourceGroup, settings.ChatJid);
        payload.ChatJid = settings.ChatJid.Trim();
        var dir = Path.Combine(dataDir, "ipc", sourceGroup, "messages");
        try
        {
            Directory.CreateDirectory(dir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            throw new InvalidOperationException(
                $"Unable to open RBClaw data dir. Check the DataDir setting: {dataDir}",
                ex);
        }

        var finalPath = Path.Combine(dir, $"{nonce}.json");
        var tempPath = finalPath + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(payload, JsonOptions));
        if (File.Exists(finalPath)) File.Delete(finalPath);
        File.Move(tempPath, finalPath);
        return finalPath;
    }

    public static string NormalizeDataDir(string dataDir)
    {
        var trimmed = dataDir.Trim().Trim('"');
        var normalized = trimmed.StartsWith(LegacyWslUncPrefix, StringComparison.OrdinalIgnoreCase)
            ? LocalhostWslUncPrefix + trimmed[LegacyWslUncPrefix.Length..]
            : trimmed;
        return normalized.EndsWith(LegacyStoreSuffix, StringComparison.OrdinalIgnoreCase)
            ? normalized[..^LegacyStoreSuffix.Length] + CurrentDataSuffix
            : normalized;
    }

    public static bool TryValidateDataDir(string dataDir, out string error)
    {
        var normalized = NormalizeDataDir(dataDir);
        if (normalized.Length == 0)
        {
            error = "Set the RBClaw DataDir before starting or sending a command.";
            return false;
        }

        var isUncPath = normalized.StartsWith(@"\\", StringComparison.Ordinal);
        var isWindowsDrivePath =
            normalized.Length >= 3 &&
            char.IsAsciiLetter(normalized[0]) &&
            normalized[1] == ':' &&
            normalized[2] is '\\' or '/';
        if (!isUncPath && !isWindowsDrivePath && !Path.IsPathRooted(normalized))
        {
            error = "The RBClaw DataDir must be an absolute path.";
            return false;
        }

        error = "";
        return true;
    }

    public static string NormalizeSourceGroup(string sourceGroup, string chatJid)
    {
        return sourceGroup.Trim();
    }

    public static string NormalizeSenderName(string senderName)
    {
        var normalized = senderName.Trim();
        return normalized.Length == 0 ? "Voice Companion" : normalized;
    }

    public static bool IsValidDiscordChatJid(string chatJid)
    {
        var trimmed = chatJid.Trim();
        if (!trimmed.StartsWith("dc:", StringComparison.Ordinal)) return false;

        var id = trimmed[3..];
        if (id.Length is < 17 or > 20) return false;
        foreach (var character in id)
        {
            if (character is < '0' or > '9') return false;
        }
        return true;
    }

    public static bool IsSafeSourceGroup(string sourceGroup)
    {
        var trimmed = sourceGroup.Trim();
        if (trimmed.Length == 0 || trimmed is "." or "..") return false;
        if (trimmed.IndexOfAny(UnsafeSourceGroupChars) >= 0) return false;

        foreach (var character in trimmed)
        {
            if (char.IsControl(character)) return false;
        }
        return true;
    }

    public static bool TryValidateRouting(
        CompanionSettings settings,
        out string error)
    {
        if (!IsValidDiscordChatJid(settings.ChatJid))
        {
            error = string.IsNullOrWhiteSpace(settings.ChatJid)
                ? "Select a Discord room before starting or sending a command."
                : "The selected Discord room JID is invalid. Refresh the room list and select it again.";
            return false;
        }

        if (!IsSafeSourceGroup(settings.SourceGroup))
        {
            error = string.IsNullOrWhiteSpace(settings.SourceGroup)
                ? "The selected Discord room has no registered source group."
                : "The selected source group is not a safe folder name. Refresh the room list and select it again.";
            return false;
        }

        error = "";
        return true;
    }
}
