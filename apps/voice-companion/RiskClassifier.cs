using System.Text.RegularExpressions;

namespace RBClaw.VoiceCompanion;

public static partial class RiskClassifier
{
    private static readonly Regex HighRiskRegex = BuildHighRiskRegex();

    public static bool IsHighRisk(string text)
    {
        return HighRiskRegex.IsMatch(text);
    }

    [GeneratedRegex(
        @"\b(commit|push|deploy|restart|ssh|delete|reset|rebase|force)\b|rm\s+-|drop\s+(table|database)|커밋|푸시|배포|재시작|삭제|지워|리셋|리베이스|강제|디비|DB|데이터베이스|마이그레이션|접속",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BuildHighRiskRegex();
}
