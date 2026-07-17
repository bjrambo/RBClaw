---
name: setup
description: Run initial RBClaw setup for the unified single-service Discord architecture.
---

# RBClaw Setup

설치는 `bash setup.sh`로 부트스트랩하고, 나머지는 `bun run setup -- --step <name>`으로 진행합니다. 현재 기준 채널은 디스코드만 지원합니다.

RBClaw는 현재 **단일 서비스**로 동작합니다:

- **rbclaw** — 통합 런타임 서비스

owner / reviewer / arbiter provider는 `.env`와 room 설정으로 선택합니다.
Codex와 Claude Code는 별도 서비스가 아니라 통합 서비스 내부 runner로
실행됩니다.

## 1. 부트스트랩

```bash
bash setup.sh
```

- Node 20 이상과 의존성이 준비되어야 합니다.
- Linux reviewer 격리에는 `bubblewrap`, `socat`, `unshare`가 필요합니다.
- Discord의 owner / reviewer / arbiter 봇은 모두 Message Content Intent와
  대상 채널의 읽기·전송·기록 조회·첨부 권한이 필요합니다.
- 실패하면 `logs/setup.log`를 먼저 봅니다.

## 2. 현재 상태 확인

```bash
bun run setup -- --step environment
```

여기서 확인할 것:

- `.env` 존재 여부
- 기존 등록 그룹 존재 여부
- 이미 초기화된 설치인지 여부

## 3. 필수 환경 변수

### 기본 환경 변수 (.env)

`.env`에 최소한 아래 값이 있어야 합니다.

```bash
DISCORD_OWNER_BOT_TOKEN=...       # 필수
DISCORD_REVIEWER_BOT_TOKEN=...    # tribunal room 사용 시
DISCORD_ARBITER_BOT_TOKEN=...     # arbiter 사용 시

OWNER_AGENT_TYPE=codex
REVIEWER_AGENT_TYPE=claude-code
# ARBITER_AGENT_TYPE=codex

CLAUDE_CODE_OAUTH_TOKENS=token1,token2
ASSISTANT_NAME=claude
```

Codex는 서비스를 실행하는 OS 계정의 Codex CLI OAuth 세션을 사용합니다.
Claude Code는 같은 계정의 CLI 인증 또는
`CLAUDE_CODE_OAUTH_TOKENS` / `ANTHROPIC_API_KEY`가 필요합니다.

```bash
CODEX_MODEL=gpt-5.5
CODEX_EFFORT=xhigh
CLAUDE_MODEL=claude-opus-4-8
CLAUDE_EFFORT=high
```

### 선택 환경 변수

```bash
# 사용량 대시보드
STATUS_CHANNEL_ID=...                # 상태 업데이트 디스코드 채널
USAGE_DASHBOARD=true

# 웹 대시보드
WEB_DASHBOARD_ENABLED=true
WEB_DASHBOARD_HOST=127.0.0.1
WEB_DASHBOARD_PORT=8734
WEB_DASHBOARD_TOKEN=...              # mutating API에 필수

# 고급 설정
MAX_CONCURRENT_AGENTS=5
SESSION_COMMAND_ALLOWED_SENDERS=...  # 세션 명령 허용 유저 ID (쉼표 구분)
```

## 4. 러너 빌드

```bash
bun run setup -- --step runners
```

이 단계는 아래 두 runner를 빌드합니다.

- `runners/agent-runner` (Claude Code / GLM Code)
- `runners/codex-runner` (Codex)

서비스는 하나지만, 내부 역할 라우팅과 paired 흐름에서 두 러너를 모두 쓸 수 있어서 둘 다 빌드합니다.

실패하면 보통 `bun run build:runners` 출력과 각 러너의 `package.json` 의존성을 같이 보면 됩니다.

## 5. 디스코드 채널 등록

먼저 디스코드에서 개발자 모드를 켜고 채널 ID를 복사합니다. 등록 JID는 `dc:<channel_id>` 형식입니다.

채널 등록은 기본적으로 한 번 하면 됩니다.

예시:

```bash
bun run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #general" \
  --folder discord_main \
  --channel discord \
  --is-main
```

`register` setup step은 최초 main room 부트스트랩용입니다. `--trigger`,
`--no-trigger-required`, `--assistant-name`은 지원하지 않습니다.

추가 room은 서비스 시작 후 main room에서 `assign_room` 도구로 등록합니다.

```text
다음 채널을 assign_room으로 등록해줘.
jid: dc:123456789012345679
name: My Server #ops
room_mode: tribunal
work_dir: /absolute/path/to/project
owner_agent_type: codex
reviewer_agent_type: claude-code
requires_trigger: false
```

`work_dir`는 실제로 존재하는 절대경로여야 합니다.

## 6. 서비스 시작

```bash
bun run setup -- --step service
```

이 명령은:

- **rbclaw** 서비스를 설치하고 시작합니다

플랫폼별:

- Linux (systemd): `~/.config/systemd/user/rbclaw.service`
- macOS: `~/Library/LaunchAgents/com.rbclaw.plist`
- WSL (no systemd): `start-rbclaw.sh`

수동으로 서비스 관리:

```bash
# Linux (systemd)
systemctl --user status rbclaw
systemctl --user restart rbclaw

# 로그
journalctl --user -u rbclaw -f
```

## 7. 최종 검증

```bash
bun run setup -- --step verify
```

성공 기준:

- **rbclaw** 서비스가 running
- Claude 자격 증명이 configured
- owner Discord token이 configured
- tribunal room이 있으면 reviewer Discord token이 configured
- arbiter task가 있으면 arbiter Discord token이 configured
- assigned room 수가 1 이상
- legacy room migration과 unexpected data-state 오류가 없음

## 빠른 문제 해결

- 빌드 문제: `bun run typecheck`, `bun test`, `bun run build:runners`
- 서비스 문제: `logs/rbclaw.error.log` 또는
  `journalctl --user -u rbclaw -f`
- Codex 실행 문제: 서비스 계정의 Codex CLI OAuth 세션과
  `CODEX_MODEL`, `CODEX_EFFORT` 확인
- 디스코드 연결 문제: role별 canonical token, Message Content Intent,
  채널 권한과 등록된 `dc:*` JID 확인
- room 실행 문제: `room_settings.work_dir`가 존재하는 절대경로인지 확인
- 응답 문제: `tail -f logs/rbclaw.log`
