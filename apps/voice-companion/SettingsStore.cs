using System.IO;
using System.Text.Json;

namespace RBClaw.VoiceCompanion;

public static class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    public static string SettingsPath
    {
        get
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "RBClawVoiceCompanion");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "settings.json");
        }
    }

    public static CompanionSettings Load()
    {
        if (!File.Exists(SettingsPath)) return new CompanionSettings();
        try
        {
            var json = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize<CompanionSettings>(json) ?? new CompanionSettings();
        }
        catch
        {
            return new CompanionSettings();
        }
    }

    public static void Save(CompanionSettings settings)
    {
        File.WriteAllText(SettingsPath, JsonSerializer.Serialize(settings, JsonOptions));
    }
}
