using System.Text.Json;

namespace RBClaw.Host;

internal static class AgentRunnerCommand
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task RunAsync()
    {
        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += OnCancel;
        try
        {
            var input = await Console.In.ReadToEndAsync(cancellation.Token);
            var request = JsonSerializer.Deserialize<AgentRunnerRequest>(input, JsonOptions)
                ?? throw new InvalidDataException("Agent runner request is empty.");
            var result = await new AgentRunnerBridge().RunAsync(request, cancellation.Token);
            Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions));
            if (result.Status != "success") Environment.ExitCode = 1;
        }
        finally
        {
            Console.CancelKeyPress -= OnCancel;
        }

        void OnCancel(object? sender, ConsoleCancelEventArgs args)
        {
            args.Cancel = true;
            cancellation.Cancel();
        }
    }
}
