using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;

namespace RBClaw.VoiceCompanion;

public sealed class MainWindow : Window
{
    private static readonly Regex[] HighRiskVoicePatterns =
    {
        new(@"\bcommit\b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"\bpush\b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"\bdeploy\b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"\brestart\b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"\bssh\b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"\brm\s+-", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"\bdrop\s+(table|database)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"\bdelete\s+", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new("커밋", RegexOptions.Compiled),
        new("푸시", RegexOptions.Compiled),
        new("배포", RegexOptions.Compiled),
        new("재시작", RegexOptions.Compiled),
        new("삭제", RegexOptions.Compiled),
        new("지워", RegexOptions.Compiled),
        new("디비|DB|데이터베이스", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new("마이그레이션", RegexOptions.Compiled),
        new("SSH|접속", RegexOptions.IgnoreCase | RegexOptions.Compiled),
    };

    private readonly AudioCaptureService _audio = new();
    private readonly WhisperTranscriber _transcriber = new();
    private readonly IpcMessageWriter _ipcWriter = new();
    private readonly DashboardClient _dashboard = new();
    private readonly DispatcherTimer _sessionTimer = new();
    private readonly DispatcherTimer _pollTimer = new();
    private readonly SemaphoreSlim _segmentLock = new(1, 1);
    private readonly SemaphoreSlim _speechLock = new(1, 1);
    private readonly object _speechProcessGuard = new();
    private readonly ObservableCollection<string> _conversation = new();
    private readonly ObservableCollection<AvailableRoom> _rooms = new();
    private readonly ObservableCollection<string> _roomPreview = new();

    private readonly TextBlock _stateText = new();
    private readonly Border _stateDot = new();
    private readonly TextBlock _meterText = new();
    private readonly TextBox _dataDirBox = new();
    private readonly TextBox _sourceGroupBox = new();
    private readonly TextBox _chatJidBox = new();
    private readonly TextBox _dashboardUrlBox = new();
    private readonly TextBox _dashboardTokenBox = new();
    private readonly TextBox _roomSearchBox = new();
    private readonly ListBox _roomList = new();
    private readonly ListBox _roomPreviewList = new();
    private readonly TextBlock _roomFocusStatusText = new();
    private readonly TextBox _senderNameBox = new();
    private readonly TextBox _wakePhraseBox = new();
    private readonly TextBox _timeoutBox = new();
    private readonly TextBox _silenceMsBox = new();
    private readonly TextBox _voiceThresholdBox = new();
    private readonly ComboBox _providerBox = new();
    private readonly TextBox _apiKeyBox = new();
    private readonly CheckBox _ignoreWakePhraseBox = new();
    private readonly CheckBox _readResponsesBox = new();
    private readonly CheckBox _postTranscriptsBox = new();
    private readonly ListBox _conversationList = new();
    private readonly TextBox _manualInputBox = new();
    private readonly TextBlock _pendingApprovalText = new();
    private Button? _approveVoiceButton;

    private CompanionSettings _settings = new();
    private CancellationTokenSource? _cts;
    private Process? _speechProcess;
    private List<AvailableRoom> _allRooms = new();
    private string? _pendingVoiceCommand;
    private bool _activeSession;
    private bool _hotkeyActive;
    private bool _dashboardPollInitialized;
    private DateTimeOffset _lastActivity = DateTimeOffset.MinValue;

    public MainWindow()
    {
        Title = "RBClaw Voice Companion";
        Width = 1120;
        Height = 760;
        MinWidth = 980;
        MinHeight = 680;
        Background = Brush.Parse("#07111F");
        Foreground = Brush.Parse("#E5F2FF");
        Content = BuildLayout();
        LoadSettingsToUi();

        _audio.SegmentReady += Audio_SegmentReady;
        _audio.LevelChanged += (_, level) =>
        {
            Dispatcher.UIThread.Post(() => _meterText.Text = $"level {level:0.000}");
        };

        _sessionTimer.Interval = TimeSpan.FromSeconds(5);
        _sessionTimer.Tick += (_, _) => CheckSessionTimeout();

        _pollTimer.Interval = TimeSpan.FromSeconds(2);
        _pollTimer.Tick += async (_, _) => await PollDashboardAsync();

        _readResponsesBox.IsCheckedChanged += ReadResponsesBox_IsCheckedChanged;
        _roomSearchBox.TextChanged += (_, _) => ApplyRoomFilter();
        _roomList.SelectionChanged += RoomList_SelectionChanged;
        KeyDown += MainWindow_KeyDown;
        Closed += (_, _) => DisposeServices();
        SetState("Idle", "#64748B");
    }

    private Control BuildLayout()
    {
        var root = new Grid
        {
            Margin = new Thickness(24),
            RowDefinitions = new RowDefinitions("Auto,*"),
        };

        var header = new DockPanel { Margin = new Thickness(0, 0, 0, 18) };
        var titleStack = new StackPanel();
        titleStack.Children.Add(new TextBlock
        {
            Text = "RBClaw Voice Companion",
            FontSize = 34,
            FontWeight = FontWeight.SemiBold,
        });
        titleStack.Children.Add(new TextBlock
        {
            Text = "wake word, STT, IPC injection, dashboard response loop",
            Foreground = Brush.Parse("#8EA3B7"),
            Margin = new Thickness(2, 4, 0, 0),
        });
        DockPanel.SetDock(titleStack, Dock.Left);
        header.Children.Add(titleStack);

        var statePanel = new Border
        {
            Background = Brush.Parse("#101B2E"),
            BorderBrush = Brush.Parse("#26364F"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(14, 10),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Children =
                {
                    _stateDot,
                    _stateText,
                },
            },
        };
        _stateDot.Width = 10;
        _stateDot.Height = 10;
        _stateDot.CornerRadius = new CornerRadius(5);
        _stateDot.Margin = new Thickness(0, 0, 8, 0);
        _stateText.FontWeight = FontWeight.SemiBold;
        DockPanel.SetDock(statePanel, Dock.Right);
        header.Children.Add(statePanel);
        Grid.SetRow(header, 0);
        root.Children.Add(header);

        var body = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("360,18,*"),
        };
        Grid.SetRow(body, 1);
        root.Children.Add(body);

        var settingsPanel = new Border
        {
            Background = Brush.Parse("#111827"),
            BorderBrush = Brush.Parse("#26364F"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(18),
            Child = new ScrollViewer { Content = BuildSettingsStack() },
        };
        Grid.SetColumn(settingsPanel, 0);
        body.Children.Add(settingsPanel);

        var right = new Grid
        {
            RowDefinitions = new RowDefinitions("*,16,220"),
        };
        Grid.SetColumn(right, 2);
        body.Children.Add(right);

        var conversationPanel = new Border
        {
            Background = Brush.Parse("#172033"),
            BorderBrush = Brush.Parse("#26364F"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(18),
            Child = BuildConversationPanel(),
        };
        Grid.SetRow(conversationPanel, 0);
        right.Children.Add(conversationPanel);

        var gatePanel = new Border
        {
            Background = Brush.Parse("#111827"),
            BorderBrush = Brush.Parse("#26364F"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(18),
            Child = BuildGatePanel(),
        };
        Grid.SetRow(gatePanel, 2);
        right.Children.Add(gatePanel);

        return root;
    }

    private StackPanel BuildSettingsStack()
    {
        _providerBox.ItemsSource = new[] { "groq", "openai" };
        _apiKeyBox.PasswordChar = '•';

        var stack = new StackPanel();
        AddSectionTitle(stack, "Connection");
        AddLabeled(stack, "RBClaw data dir", _dataDirBox);
        AddLabeled(stack, "Source group folder", _sourceGroupBox);
        AddLabeled(stack, "Target room JID", _chatJidBox);
        AddLabeled(stack, "Dashboard base URL", _dashboardUrlBox);
        AddLabeled(stack, "Dashboard token", _dashboardTokenBox);
        AddSectionTitle(stack, "Room focus");
        _roomSearchBox.Watermark = "Search room name or JID";
        AddLabeled(stack, "Find room", _roomSearchBox);
        var roomButtons = new UniformGrid { Columns = 2, Rows = 1 };
        roomButtons.Children.Add(MakeButton("Refresh rooms", RefreshRoomsButton_Click));
        roomButtons.Children.Add(MakeButton("Focus selected", FocusSelectedRoomButton_Click));
        stack.Children.Add(roomButtons);
        _roomList.ItemsSource = _rooms;
        _roomList.Height = 150;
        _roomList.Background = Brush.Parse("#0B1220");
        _roomList.BorderBrush = Brush.Parse("#26364F");
        _roomList.Foreground = Brush.Parse("#E5F2FF");
        _roomList.Margin = new Thickness(0, 8, 0, 10);
        stack.Children.Add(_roomList);
        _roomFocusStatusText.Text = "No room loaded.";
        _roomFocusStatusText.Foreground = Brush.Parse("#8EA3B7");
        _roomFocusStatusText.TextWrapping = TextWrapping.Wrap;
        stack.Children.Add(_roomFocusStatusText);
        _roomPreviewList.ItemsSource = _roomPreview;
        _roomPreviewList.Height = 120;
        _roomPreviewList.Background = Brush.Parse("#0B1220");
        _roomPreviewList.BorderBrush = Brush.Parse("#26364F");
        _roomPreviewList.Foreground = Brush.Parse("#E5F2FF");
        _roomPreviewList.Margin = new Thickness(0, 8, 0, 12);
        stack.Children.Add(_roomPreviewList);
        AddSectionTitle(stack, "Speech");
        AddLabeled(stack, "Sender name", _senderNameBox);
        AddLabeled(stack, "Wake phrase", _wakePhraseBox);
        AddLabeled(stack, "Session timeout minutes", _timeoutBox);
        AddLabeled(stack, "Silence debounce (ms)", _silenceMsBox);
        AddLabeled(stack, "Voice threshold", _voiceThresholdBox);
        AddLabeled(stack, "STT provider", _providerBox);
        AddLabeled(stack, "API key", _apiKeyBox);
        _ignoreWakePhraseBox.Content = "Ignore wake phrase";
        _ignoreWakePhraseBox.Margin = new Thickness(0, 0, 0, 12);
        stack.Children.Add(_ignoreWakePhraseBox);
        _readResponsesBox.Content = "Read AI responses aloud";
        _readResponsesBox.Margin = new Thickness(0, 0, 0, 12);
        stack.Children.Add(_readResponsesBox);
        _postTranscriptsBox.Content = "Post voice transcripts to Discord";
        _postTranscriptsBox.Margin = new Thickness(0, 0, 0, 12);
        stack.Children.Add(_postTranscriptsBox);
        AddSectionTitle(stack, "Controls");

        var buttons = new UniformGrid { Columns = 2, Rows = 3 };
        buttons.Children.Add(MakeButton("Start", StartButton_Click));
        buttons.Children.Add(MakeButton("Stop", StopButton_Click));
        buttons.Children.Add(MakeButton("Hotkey Active", HotkeyButton_Click));
        buttons.Children.Add(MakeButton("Stop speech", StopSpeechButton_Click));
        buttons.Children.Add(MakeButton("Save", SaveButton_Click));
        stack.Children.Add(buttons);
        stack.Children.Add(new TextBlock
        {
            Text = "Window hotkey: Ctrl + Alt + Space",
            Foreground = Brush.Parse("#8EA3B7"),
            Margin = new Thickness(0, 12, 0, 0),
        });
        return stack;
    }

    private Control BuildConversationPanel()
    {
        var grid = new Grid { RowDefinitions = new RowDefinitions("Auto,*") };
        var dock = new DockPanel { Margin = new Thickness(0, 0, 0, 12) };
        dock.Children.Add(new TextBlock
        {
            Text = "Live Conversation",
            FontSize = 20,
            FontWeight = FontWeight.SemiBold,
        });
        _meterText.Text = "level 0.000";
        _meterText.Foreground = Brush.Parse("#38BDF8");
        _meterText.FontWeight = FontWeight.SemiBold;
        DockPanel.SetDock(_meterText, Dock.Right);
        dock.Children.Add(_meterText);
        Grid.SetRow(dock, 0);
        grid.Children.Add(dock);

        _conversationList.ItemsSource = _conversation;
        _conversationList.Background = Brush.Parse("#0B1220");
        _conversationList.BorderBrush = Brush.Parse("#26364F");
        _conversationList.Foreground = Brush.Parse("#E5F2FF");
        Grid.SetRow(_conversationList, 1);
        grid.Children.Add(_conversationList);
        return grid;
    }

    private Control BuildGatePanel()
    {
        _manualInputBox.AcceptsReturn = true;
        _manualInputBox.MinHeight = 44;
        _dashboardTokenBox.PasswordChar = '•';

        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,220") };
        var left = new StackPanel();
        left.Children.Add(new TextBlock
        {
            Text = "Manual command",
            FontSize = 18,
            FontWeight = FontWeight.SemiBold,
        });
        left.Children.Add(_manualInputBox);
        _pendingApprovalText.Text = "No pending voice approval.";
        _pendingApprovalText.Foreground = Brush.Parse("#8EA3B7");
        _pendingApprovalText.TextWrapping = TextWrapping.Wrap;
        _pendingApprovalText.Margin = new Thickness(0, 10, 0, 0);
        left.Children.Add(_pendingApprovalText);
        Grid.SetColumn(left, 0);
        grid.Children.Add(left);

        var right = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom };
        right.Children.Add(MakeButton("Send manual text", SendManualButton_Click));
        _approveVoiceButton = MakeButton("Approve voice command", ApproveVoiceButton_Click);
        _approveVoiceButton.IsEnabled = false;
        right.Children.Add(_approveVoiceButton);
        Grid.SetColumn(right, 1);
        grid.Children.Add(right);
        return grid;
    }

    private static Button MakeButton(string text, EventHandler<RoutedEventArgs> handler)
    {
        var button = new Button
        {
            Content = text,
            Margin = new Thickness(4),
            Padding = new Thickness(14, 9),
            Background = Brush.Parse("#1E293B"),
            BorderBrush = Brush.Parse("#334155"),
            Foreground = Brush.Parse("#E5F2FF"),
        };
        button.Click += handler;
        return button;
    }

    private static void AddSectionTitle(StackPanel stack, string text)
    {
        stack.Children.Add(new TextBlock
        {
            Text = text,
            FontSize = 18,
            FontWeight = FontWeight.SemiBold,
            Margin = new Thickness(0, 8, 0, 12),
        });
    }

    private static void AddLabeled(StackPanel stack, string label, Control control)
    {
        stack.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush.Parse("#8EA3B7"),
        });
        control.Margin = new Thickness(0, 6, 0, 12);
        stack.Children.Add(control);
    }

    private void LoadSettingsToUi()
    {
        _settings = SettingsStore.Load();
        _settings.DataDir = IpcMessageWriter.NormalizeDataDir(_settings.DataDir);
        _settings.SourceGroup = IpcMessageWriter.NormalizeSourceGroup(
            _settings.SourceGroup,
            _settings.ChatJid);
        _dataDirBox.Text = _settings.DataDir;
        _sourceGroupBox.Text = _settings.SourceGroup;
        _chatJidBox.Text = _settings.ChatJid;
        _dashboardUrlBox.Text = _settings.DashboardBaseUrl;
        _dashboardTokenBox.Text = _settings.DashboardToken;
        _senderNameBox.Text = _settings.SenderName;
        _wakePhraseBox.Text = _settings.WakePhrase;
        _timeoutBox.Text = _settings.SessionTimeoutMinutes.ToString();
        _silenceMsBox.Text = _settings.SilenceMs.ToString(CultureInfo.InvariantCulture);
        _voiceThresholdBox.Text = _settings.VoiceThreshold.ToString(CultureInfo.InvariantCulture);
        _providerBox.SelectedItem = _settings.SttProvider;
        _apiKeyBox.Text = _settings.ApiKey;
        _ignoreWakePhraseBox.IsChecked = _settings.IgnoreWakePhrase;
        _readResponsesBox.IsChecked = _settings.ReadAiResponsesAloud;
        _postTranscriptsBox.IsChecked = _settings.PostVoiceTranscriptsToDiscord;
    }

    private CompanionSettings ReadSettingsFromUi()
    {
        var timeout = int.TryParse(_timeoutBox.Text?.Trim(), out var parsed)
            ? Math.Clamp(parsed, 1, 5)
            : 2;
        var silenceMs = int.TryParse(_silenceMsBox.Text?.Trim(), out var parsedSilenceMs)
            ? Math.Clamp(parsedSilenceMs, 250, 5000)
            : _settings.SilenceMs;
        var voiceThreshold = double.TryParse(
            _voiceThresholdBox.Text?.Trim(),
            NumberStyles.Float,
            CultureInfo.InvariantCulture,
            out var parsedVoiceThreshold)
            ? Math.Clamp(parsedVoiceThreshold, 0.001, 1.0)
            : _settings.VoiceThreshold;
        var chatJid = _chatJidBox.Text?.Trim() ?? "";
        var sourceGroup = IpcMessageWriter.NormalizeSourceGroup(
            _sourceGroupBox.Text?.Trim() ?? "",
            chatJid);
        return new CompanionSettings
        {
            DataDir = _dataDirBox.Text?.Trim() ?? "",
            SourceGroup = sourceGroup,
            ChatJid = chatJid,
            DashboardBaseUrl = _dashboardUrlBox.Text?.Trim() ?? "",
            DashboardToken = _dashboardTokenBox.Text?.Trim() ?? "",
            SenderName = IpcMessageWriter.NormalizeSenderName(_senderNameBox.Text ?? ""),
            WakePhrase = _wakePhraseBox.Text?.Trim() ?? "",
            SessionTimeoutMinutes = timeout,
            SttProvider = _providerBox.SelectedItem?.ToString() ?? "groq",
            ApiKey = _apiKeyBox.Text?.Trim() ?? "",
            SilenceMs = silenceMs,
            VoiceThreshold = voiceThreshold,
            IgnoreWakePhrase = _ignoreWakePhraseBox.IsChecked == true,
            ReadAiResponsesAloud = _readResponsesBox.IsChecked == true,
            PostVoiceTranscriptsToDiscord = _postTranscriptsBox.IsChecked == true,
        };
    }

    private bool EnsureRoutingConfigured(CompanionSettings settings)
    {
        if (IpcMessageWriter.TryValidateRouting(settings, out var error)) return true;

        _roomFocusStatusText.Text = error;
        AddLine("gate", error);
        return false;
    }

    private bool EnsureVoiceInputConfigured(CompanionSettings settings)
    {
        if (!IpcMessageWriter.TryValidateDataDir(settings.DataDir, out var error))
        {
            _roomFocusStatusText.Text = error;
            AddLine("gate", error);
            return false;
        }

        return EnsureRoutingConfigured(settings);
    }

    private void SaveButton_Click(object? sender, RoutedEventArgs e)
    {
        _settings = ReadSettingsFromUi();
        SettingsStore.Save(_settings);
        AddLine("system", "Settings saved.");
    }

    private void StartButton_Click(object? sender, RoutedEventArgs e)
    {
        _settings = ReadSettingsFromUi();
        if (!EnsureVoiceInputConfigured(_settings)) return;
        if (!_settings.IgnoreWakePhrase && string.IsNullOrWhiteSpace(_settings.WakePhrase))
        {
            const string error = "Set a wake phrase or enable Ignore wake phrase before starting.";
            _roomFocusStatusText.Text = error;
            AddLine("gate", error);
            return;
        }

        SettingsStore.Save(_settings);
        _cts = new CancellationTokenSource();
        _audio.Start(_settings);
        _dashboardPollInitialized = false;
        _sessionTimer.Start();
        _pollTimer.Start();
        if (_settings.IgnoreWakePhrase)
        {
            ActivateSession("Active");
            AddLine("system", "Wake phrase is ignored.");
            return;
        }

        SetState("Wake mode", "#38BDF8");
        AddLine("system", $"Listening for wake phrase: {_settings.WakePhrase}");
    }

    private void StopButton_Click(object? sender, RoutedEventArgs e)
    {
        _audio.Stop();
        _sessionTimer.Stop();
        _pollTimer.Stop();
        StopCurrentSpeech();
        ClearPendingVoiceApproval();
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
        DeactivateSession("Stopped");
        AddLine("system", "Stopped.");
    }

    private void HotkeyButton_Click(object? sender, RoutedEventArgs e)
    {
        ToggleHotkeyMode();
    }

    private void StopSpeechButton_Click(object? sender, RoutedEventArgs e)
    {
        StopCurrentSpeech();
        AddLine("system", "Speech stopped.");
    }

    private void ReadResponsesBox_IsCheckedChanged(object? sender, RoutedEventArgs e)
    {
        _settings.ReadAiResponsesAloud = _readResponsesBox.IsChecked == true;
        if (!_settings.ReadAiResponsesAloud)
        {
            StopCurrentSpeech();
        }
    }

    private async void RefreshRoomsButton_Click(object? sender, RoutedEventArgs e)
    {
        _settings = ReadSettingsFromUi();
        try
        {
            var token = _cts?.Token ?? CancellationToken.None;
            var rooms = await _dashboard.LoadAvailableGroupsAsync(_settings, token);
            _allRooms = rooms
                .OrderByDescending(room => room.IsRegistered)
                .ThenBy(room => string.IsNullOrWhiteSpace(room.Name) ? room.Jid : room.Name)
                .ToList();
            ApplyRoomFilter();
            _roomFocusStatusText.Text = $"Loaded {_allRooms.Count} rooms.";
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or ArgumentException)
        {
            _roomFocusStatusText.Text = $"Room list failed: {ex.Message}";
        }
    }

    private async void FocusSelectedRoomButton_Click(object? sender, RoutedEventArgs e)
    {
        if (_roomList.SelectedItem is not AvailableRoom room)
        {
            _roomFocusStatusText.Text = "Select a room first.";
            return;
        }

        var folder = room.Folder?.Trim() ?? "";
        if (folder.Length == 0)
        {
            _roomFocusStatusText.Text = "Selected room is not registered yet, so voice commands cannot be routed there.";
            return;
        }

        _settings = ReadSettingsFromUi();
        _settings.ChatJid = room.Jid.Trim();
        _settings.SourceGroup = folder;
        if (!EnsureRoutingConfigured(_settings)) return;

        _chatJidBox.Text = _settings.ChatJid;
        _sourceGroupBox.Text = _settings.SourceGroup;
        SettingsStore.Save(_settings);
        _dashboardPollInitialized = false;
        _roomFocusStatusText.Text = $"Focused: {room.Name} ({folder})";
        AddLine("system", $"Room focus changed: {room.Name} -> {room.Jid}");
        await LoadSelectedRoomPreviewAsync(room);
    }

    private async void RoomList_SelectionChanged(object? sender, SelectionChangedEventArgs e)
    {
        if (_roomList.SelectedItem is AvailableRoom room)
        {
            await LoadSelectedRoomPreviewAsync(room);
        }
    }

    private void ApplyRoomFilter()
    {
        var query = _roomSearchBox.Text?.Trim() ?? "";
        var filtered = _allRooms.Where(room =>
            query.Length == 0 ||
            room.Name.Contains(query, StringComparison.OrdinalIgnoreCase) ||
            room.Jid.Contains(query, StringComparison.OrdinalIgnoreCase) ||
            (room.Folder?.Contains(query, StringComparison.OrdinalIgnoreCase) ?? false));

        _rooms.Clear();
        foreach (var room in filtered.Take(100))
        {
            _rooms.Add(room);
        }
    }

    private async Task LoadSelectedRoomPreviewAsync(AvailableRoom room)
    {
        _roomPreview.Clear();
        _roomPreview.Add("Loading preview...");
        try
        {
            var settings = ReadSettingsFromUi();
            var token = _cts?.Token ?? CancellationToken.None;
            var lines = await _dashboard.LoadRoomPreviewAsync(settings, room.Jid, token);
            _roomPreview.Clear();
            if (lines.Count == 0)
            {
                _roomPreview.Add("No recent timeline entries.");
                return;
            }

            foreach (var line in lines.Skip(Math.Max(0, lines.Count - 8)))
            {
                _roomPreview.Add($"{line.At:MM-dd HH:mm} {line.Speaker}: {line.Text}");
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or ArgumentException)
        {
            _roomPreview.Clear();
            _roomPreview.Add($"Preview failed: {ex.Message}");
        }
    }

    private void MainWindow_KeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Space && e.KeyModifiers.HasFlag(KeyModifiers.Control) && e.KeyModifiers.HasFlag(KeyModifiers.Alt))
        {
            ToggleHotkeyMode();
            e.Handled = true;
        }
    }

    private void ToggleHotkeyMode()
    {
        _hotkeyActive = !_hotkeyActive;
        if (_hotkeyActive) ActivateSession("Hotkey active");
        else DeactivateSession("Wake mode");
    }

    private async void Audio_SegmentReady(object? sender, SpeechSegment segment)
    {
        await _segmentLock.WaitAsync();
        try
        {
            var token = _cts?.Token ?? CancellationToken.None;
            var text = await _transcriber.TranscribeAsync(_settings, segment.WavBytes, token);
            if (string.IsNullOrWhiteSpace(text)) return;
            await Dispatcher.UIThread.InvokeAsync(async () => await HandleTranscribedTextAsync(text));
        }
        catch (Exception ex)
        {
            Dispatcher.UIThread.Post(() => AddLine("error", ex.Message));
        }
        finally
        {
            _segmentLock.Release();
        }
    }

    private async Task HandleTranscribedTextAsync(string text)
    {
        AddLine("voice", text);
        if (_settings.IgnoreWakePhrase)
        {
            if (!_activeSession) ActivateSession("Active");
            await SendCommandAsync(text, voiceTranscriptText: text);
            return;
        }

        var wakePhrase = _settings.WakePhrase.Trim();
        if (!_activeSession)
        {
            if (wakePhrase.Length == 0 || text.Contains(wakePhrase, StringComparison.OrdinalIgnoreCase))
            {
                ActivateSession("Active");
                var afterWake = wakePhrase.Length == 0
                    ? text
                    : text.Replace(wakePhrase, "", StringComparison.OrdinalIgnoreCase).Trim();
                if (!string.IsNullOrWhiteSpace(afterWake))
                {
                    await SendCommandAsync(afterWake, voiceTranscriptText: afterWake);
                }
            }
            return;
        }

        await SendCommandAsync(text, voiceTranscriptText: text);
    }

    private async Task PostVoiceTranscriptToDiscordAsync(string text, bool resolveSourceGroup = true)
    {
        if (!_settings.PostVoiceTranscriptsToDiscord) return;
        if (!EnsureVoiceInputConfigured(_settings)) return;

        try
        {
            var token = _cts?.Token ?? CancellationToken.None;
            if (resolveSourceGroup) await ResolveSourceGroupForTargetRoomAsync(token);
            await Task.Run(() => _ipcWriter.WriteDiscordTranscriptMessage(_settings, text));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            AddLine("error", $"discord transcript failed: {ex.Message}");
        }
    }

    private async Task SendCommandAsync(
        string text,
        string? approvalLevel = null,
        string? approvalMethod = null,
        string? voiceTranscriptText = null)
    {
        if (!EnsureVoiceInputConfigured(_settings)) return;

        _lastActivity = DateTimeOffset.UtcNow;

        try
        {
            var token = _cts?.Token ?? CancellationToken.None;
            await ResolveSourceGroupForTargetRoomAsync(token);
            if (!string.IsNullOrWhiteSpace(voiceTranscriptText))
            {
                await PostVoiceTranscriptToDiscordAsync(voiceTranscriptText, resolveSourceGroup: false);
            }
            if (!string.IsNullOrWhiteSpace(voiceTranscriptText) && IsHighRiskVoiceRequest(text))
            {
                QueuePendingVoiceApproval(text);
                return;
            }
            await Task.Run(() => _ipcWriter.WriteMessage(_settings, text, approvalLevel, approvalMethod));
            AddLine("sent", text);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            AddLine("error", ex.Message);
        }
    }

    private async Task ResolveSourceGroupForTargetRoomAsync(CancellationToken cancellationToken)
    {
        try
        {
            var resolvedFolder = await _dashboard.ResolveRoomFolderAsync(_settings, cancellationToken);
            if (string.IsNullOrWhiteSpace(resolvedFolder))
            {
                AddLine(
                    "gate",
                    $"Could not resolve Source group folder from dashboard. Using configured value: {_settings.SourceGroup}");
                return;
            }
            if (!IpcMessageWriter.IsSafeSourceGroup(resolvedFolder))
            {
                AddLine("gate", "Dashboard returned an unsafe source group folder name.");
                return;
            }
            if (string.Equals(_settings.SourceGroup, resolvedFolder, StringComparison.Ordinal)) return;

            _settings.SourceGroup = resolvedFolder;
            _sourceGroupBox.Text = resolvedFolder;
            SettingsStore.Save(_settings);
            AddLine("system", $"Source group folder resolved: {resolvedFolder}");
        }
        catch
        {
            AddLine(
                "gate",
                $"Could not reach dashboard to resolve Source group folder. Using configured value: {_settings.SourceGroup}");
        }
    }

    private async void SendManualButton_Click(object? sender, RoutedEventArgs e)
    {
        var text = _manualInputBox.Text?.Trim();
        if (string.IsNullOrWhiteSpace(text)) return;
        _manualInputBox.Text = "";
        await SendCommandAsync(text);
    }

    private async void ApproveVoiceButton_Click(object? sender, RoutedEventArgs e)
    {
        var text = _pendingVoiceCommand?.Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            ClearPendingVoiceApproval();
            return;
        }

        _settings = ReadSettingsFromUi();
        if (!EnsureVoiceInputConfigured(_settings)) return;

        try
        {
            var token = _cts?.Token ?? CancellationToken.None;
            await ResolveSourceGroupForTargetRoomAsync(token);
            var requestId = $"voice-approved-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid():N}";
            await _dashboard.SendRoomMessageAsync(_settings, text, requestId, token);
            AddLine("approved", text);
            ClearPendingVoiceApproval();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or ArgumentException)
        {
            AddLine("error", $"voice approval failed: {ex.Message}");
        }
    }

    private void QueuePendingVoiceApproval(string text)
    {
        _pendingVoiceCommand = text.Trim();
        _pendingApprovalText.Text = $"Pending voice approval: {_pendingVoiceCommand}";
        if (_approveVoiceButton != null) _approveVoiceButton.IsEnabled = true;
        AddLine("gate", "High-risk voice command is waiting for button approval.");
    }

    private void ClearPendingVoiceApproval()
    {
        _pendingVoiceCommand = null;
        _pendingApprovalText.Text = "No pending voice approval.";
        if (_approveVoiceButton != null) _approveVoiceButton.IsEnabled = false;
    }

    private static bool IsHighRiskVoiceRequest(string text)
    {
        return HighRiskVoicePatterns.Any(pattern => pattern.IsMatch(text));
    }

    private void ActivateSession(string label)
    {
        _activeSession = true;
        _lastActivity = DateTimeOffset.UtcNow;
        SetState(label, "#A78BFA");
    }

    private void DeactivateSession(string label)
    {
        _activeSession = false;
        _hotkeyActive = false;
        SetState(label, label == "Stopped" ? "#64748B" : "#38BDF8");
    }

    private void CheckSessionTimeout()
    {
        if (_settings.IgnoreWakePhrase) return;
        if (!_activeSession) return;
        var timeout = TimeSpan.FromMinutes(Math.Clamp(_settings.SessionTimeoutMinutes, 1, 5));
        if (DateTimeOffset.UtcNow - _lastActivity >= timeout)
        {
            DeactivateSession("Wake mode");
            AddLine("system", "Session timed out. Wake phrase required again.");
        }
    }

    private async Task PollDashboardAsync()
    {
        try
        {
            var token = _cts?.Token ?? CancellationToken.None;
            var lines = await _dashboard.PollNewLinesAsync(_settings, token);
            var readAloud = _dashboardPollInitialized && _settings.ReadAiResponsesAloud;
            foreach (var line in lines)
            {
                AddLine(line.Speaker, line.Text);
                if (readAloud)
                {
                    _ = SpeakDashboardResponseAsync(line.Text);
                }
            }
            _dashboardPollInitialized = true;
        }
        catch
        {
            // Dashboard may be unavailable while RBClaw is restarting.
        }
    }

    private void AddLine(string speaker, string text)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {speaker}: {text}";
        _conversation.Add(line);
        while (_conversation.Count > 200) _conversation.RemoveAt(0);
        if (_conversation.Count == 0) return;

        var last = _conversation[^1];
        Dispatcher.UIThread.Post(() => _conversationList.ScrollIntoView(last), DispatcherPriority.Background);
    }

    private async Task SpeakDashboardResponseAsync(string text)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;
        var normalized = text.Trim();
        if (normalized.Length == 0) return;
        if (!_settings.ReadAiResponsesAloud) return;

        await _speechLock.WaitAsync();
        try
        {
            if (!_settings.ReadAiResponsesAloud) return;
            var textPayload = Convert.ToBase64String(Encoding.UTF8.GetBytes(normalized));
            var script = string.Join(
                "; ",
                "Add-Type -AssemblyName System.Speech",
                "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
                "$s.SetOutputToDefaultAudioDevice()",
                "$s.Rate = 0",
                "$s.Volume = 100",
                $"$s.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{textPayload}')))",
                "$s.Dispose()");
            var encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -ExecutionPolicy Bypass -EncodedCommand {encodedScript}",
                CreateNoWindow = true,
                UseShellExecute = false,
            });
            if (process != null)
            {
                lock (_speechProcessGuard)
                {
                    _speechProcess = process;
                }
                await process.WaitForExitAsync();
            }
        }
        catch
        {
            // TTS is best-effort; dashboard polling and command flow must continue.
        }
        finally
        {
            lock (_speechProcessGuard)
            {
                _speechProcess = null;
            }
            _speechLock.Release();
        }
    }

    private void StopCurrentSpeech()
    {
        Process? process;
        lock (_speechProcessGuard)
        {
            process = _speechProcess;
        }

        if (process == null) return;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Speech cancellation is best-effort.
        }
    }

    private void SetState(string text, string color)
    {
        _stateText.Text = text;
        _stateDot.Background = Brush.Parse(color);
    }

    private void DisposeServices()
    {
        StopCurrentSpeech();
        _audio.Dispose();
        _transcriber.Dispose();
        _dashboard.Dispose();
        _cts?.Dispose();
    }
}
