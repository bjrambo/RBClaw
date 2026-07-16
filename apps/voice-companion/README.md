# RBClaw Voice Companion

Windows-oriented C# companion app for voice-driven RBClaw input without opening Discord.

## Current scope

- Captures microphone audio and groups utterances with a short silence debounce.
- Transcribes audio through Groq/OpenAI Whisper-compatible APIs.
- Sends text to RBClaw through the existing IPC inbox:
  `DATA_DIR/ipc/<source-group>/messages/*.json`
- Polls the RBClaw dashboard room timeline for responses.
- Keeps an active voice session after the wake phrase or hotkey until the configured timeout.
- Can ignore the wake phrase when the operator enables the option, so every
  recognized utterance is sent to the currently focused room.
- Voice commands that look high-risk are held in the app until the operator
  clicks `Approve voice command`; the approved message is sent through the
  dashboard-authenticated room message route.
- The focused Discord room JID and source group are stored only in
  `%APPDATA%\RBClawVoiceCompanion\settings.json`. On first launch, refresh the
  room list and focus a registered room before starting voice input.
- The RBClaw data directory has no repository-provided default. Enter its
  absolute Windows or WSL UNC path once; it is then restored from the same
  local `settings.json` file.
- The sender name, wake phrase, silence debounce, and voice threshold use
  neutral repository defaults. Operator-specific values are configured in the
  app and persist only in the same local `settings.json` file.

## Security boundary

- `approvalLevel` and `approvalMethod` are client-provided metadata and are
  not accepted as high-risk approval by the server.
- `voice_companion` IPC messages that look high-risk are blocked server-side.
- High-risk voice commands must be approved by a non-voice UI action. The
  companion approval button sends through the dashboard token-protected
  `/api/rooms/{jid}/messages` route instead of treating voice metadata as
  approval.

Do not enable voice-driven commit, push, deploy, restart, SSH, DB mutation, or
deletion based only on companion metadata.

Before high-risk automatic execution is allowed, RBClaw still needs a
server-side hard gate at the actual execution boundary. That hard gate must
independently inspect trusted approval provenance instead of trusting fields
supplied by the companion.

## Build

```bash
dotnet build apps/voice-companion/RBClaw.VoiceCompanion.csproj -c Release
```

WSL can verify compilation. Microphone capture, Windows UI behavior, STT network calls, and WSL IPC path access must be tested on Windows.
