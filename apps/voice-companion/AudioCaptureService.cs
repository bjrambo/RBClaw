using System.IO;
using NAudio.Wave;

namespace RBClaw.VoiceCompanion;

public sealed class AudioCaptureService : IDisposable
{
    private readonly object _lock = new();
    private WaveInEvent? _waveIn;
    private MemoryStream _buffer = new();
    private DateTimeOffset? _lastVoiceAt;
    private bool _capturingSpeech;
    private double _peak;
    private CompanionSettings _settings = new();

    public event EventHandler<SpeechSegment>? SegmentReady;
    public event EventHandler<double>? LevelChanged;

    public bool IsRunning => _waveIn != null;

    public void Start(CompanionSettings settings)
    {
        if (_waveIn != null) return;
        _settings = settings;
        _waveIn = new WaveInEvent
        {
            WaveFormat = new WaveFormat(16000, 16, 1),
            BufferMilliseconds = 80,
        };
        _waveIn.DataAvailable += OnDataAvailable;
        _waveIn.StartRecording();
    }

    public void Stop()
    {
        if (_waveIn == null) return;
        _waveIn.DataAvailable -= OnDataAvailable;
        _waveIn.StopRecording();
        _waveIn.Dispose();
        _waveIn = null;
        lock (_lock)
        {
            _buffer.Dispose();
            _buffer = new MemoryStream();
            _capturingSpeech = false;
            _lastVoiceAt = null;
            _peak = 0;
        }
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        var rms = CalculateRms(e.Buffer, e.BytesRecorded);
        LevelChanged?.Invoke(this, rms);

        SpeechSegment? completed = null;
        lock (_lock)
        {
            if (rms >= _settings.VoiceThreshold)
            {
                _capturingSpeech = true;
                _lastVoiceAt = DateTimeOffset.UtcNow;
                _peak = Math.Max(_peak, rms);
            }

            if (_capturingSpeech)
            {
                _buffer.Write(e.Buffer, 0, e.BytesRecorded);
            }

            if (_capturingSpeech && _lastVoiceAt.HasValue)
            {
                var silenceMs = (DateTimeOffset.UtcNow - _lastVoiceAt.Value).TotalMilliseconds;
                if (silenceMs >= _settings.SilenceMs && _buffer.Length > 16000)
                {
                    completed = new SpeechSegment(ToWav(_buffer.ToArray()), _peak);
                    _buffer.Dispose();
                    _buffer = new MemoryStream();
                    _capturingSpeech = false;
                    _lastVoiceAt = null;
                    _peak = 0;
                }
            }
        }

        if (completed != null)
        {
            SegmentReady?.Invoke(this, completed);
        }
    }

    private static double CalculateRms(byte[] buffer, int bytesRecorded)
    {
        if (bytesRecorded <= 0) return 0;
        double sumSquares = 0;
        var samples = bytesRecorded / 2;
        for (var i = 0; i < bytesRecorded; i += 2)
        {
            var sample = BitConverter.ToInt16(buffer, i) / 32768.0;
            sumSquares += sample * sample;
        }
        return Math.Sqrt(sumSquares / Math.Max(samples, 1));
    }

    private static byte[] ToWav(byte[] pcm)
    {
        using var output = new MemoryStream();
        using (var writer = new WaveFileWriter(output, new WaveFormat(16000, 16, 1)))
        {
            writer.Write(pcm, 0, pcm.Length);
        }
        return output.ToArray();
    }

    public void Dispose()
    {
        Stop();
    }
}
