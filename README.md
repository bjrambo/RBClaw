# RBClaw

![Version](https://img.shields.io/badge/version-0.2.3-blue)
![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.3.153-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.144.1-green)
![Bun](https://img.shields.io/badge/Bun-1.3+-f9f1e1?logo=bun&logoColor=black)
![Discord](https://img.shields.io/badge/Discord-Tribunal-5865F2?logo=discord&logoColor=white)

RBClaw는 Discord 위에서 동작하는 Tribunal 멀티에이전트 개발 보조 시스템입니다.
사용자 요청은 owner가 받고, reviewer가 자동 리뷰를 수행하며, 필요할 때 arbiter가 교착을 정리합니다.

RBClaw는 [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)에서 출발하고 [phj1081/EJClaw](https://github.com/phj1081/EJClaw)의 흐름을 별도로 포크해 발전시킨 프로젝트입니다. 기존 Git 이력은 승계하지 않고, RBClaw의 Discord/paired-runtime 구조를 중심으로 새로운 시스템으로 독립 개발하고 있습니다.

## 개요

- 단일 `rbclaw` 서비스가 owner / reviewer / arbiter 세 역할과 세 Discord 봇을 함께 관리합니다.
- 사용자 진입점은 owner 하나이며, reviewer와 arbiter는 내부 역할로 동작합니다.
- room-level 설정은 `room_settings`를 기준으로 하며, `assign_room`이 공개 assignment 인터페이스입니다.
- owner / reviewer / arbiter는 채널에 지정된 `workDir`를 기본 실행·검증 기준으로 공유합니다.
- owner는 사용자 지시와 room/local 규칙이 허용한 외부 로컬 경로와 원격 시스템을 작업할 수 있고, reviewer / arbiter는 같은 대상을 읽기 전용으로 검증합니다.
- paired runtime은 SQLite(WAL), direct work directory, turn/lease 추적, host verification으로 구성됩니다.

## 핵심 기능

- Tribunal 3-에이전트 루프: owner / reviewer / arbiter
- Mixture of Agents(MoA): 외부 모델 의견을 arbiter 판단에 주입
- 역할별 agent type / model / effort 설정
- role-fixed Discord 봇 3개 체계
- reviewer / arbiter read-only mount namespace
- 승인 후 변경 감지와 재리뷰
- Claude 장애 시 Codex로 넘기는 global failover
- Claude OAuth 멀티 토큰 로테이션
- `assign_room` 기반 명시적 room assignment
- Bun + SQLite 기반 빠른 런타임

## Tribunal 시스템

| 역할     | 현재 기본값                                   | 설명                                   |
| -------- | --------------------------------------------- | -------------------------------------- |
| Owner    | room별 `owner_agent_type` (기본 Codex)        | 사용자 요청 처리, 코드 작성, 최종 응답 |
| Reviewer | 전역 `REVIEWER_AGENT_TYPE` (기본 Claude Code) | owner 결과 비판적 리뷰, 회귀 검증      |
| Arbiter  | 전역 `ARBITER_AGENT_TYPE` (옵션)              | owner/reviewer 교착 시 판정            |

```text
사용자 메시지
  → Owner 응답
    → Reviewer 자동 실행
      → verdict:
          DONE               → Owner finalize → 완료
          DONE_WITH_CONCERNS → Owner 수정 → 재리뷰 루프
          BLOCKED/NEEDS_CONTEXT
            ├─ Arbiter enabled  → Arbiter 판정
            └─ Arbiter disabled → 사용자로 에스컬레이션
      → 왕복이 누적되면 arbiter 자동 요청 가능
```

### MoA

MoA가 켜져 있으면 arbiter가 판정하기 전에 Kimi, GLM 같은 외부 모델 의견을 병렬 수집하고, 그 결과를 arbiter 프롬프트에 주입합니다. 최종 판정은 여전히 RBClaw arbiter가 내립니다.

## 방 설정 모델

현재 room 설정의 기준은 다음과 같습니다.

- `room_settings`: room-level SSOT
- `room_role_overrides`: owner / reviewer / arbiter 역할별 override
- `paired_tasks.work_dir`: 작업 생성 시 고정한 채널 프로젝트 경로
- `registered_groups`: 완전히 제거되지는 않았지만, canonical source가 아니라 compatibility/read-model 성격으로 남아 있는 레이어

운영적으로는:

- `single` → owner만 실행
- `tribunal` → owner + reviewer + optional arbiter

중요한 점:

- `workDir`가 없거나 유효하지 않으면 다른 경로로 대체하지 않고 실행을 차단합니다.
- `workDir`는 기본 cwd와 작업 잠금을 정하지만 owner의 절대 접근 경계가 아닙니다. 외부 경로·SSH·SFTP·FTP·실서버 작업은 사용자 지시와 room/local 규칙으로 허용합니다.
- RBClaw는 채널용 clone, snapshot, branch, linked worktree를 만들지 않습니다.
- 같은 실제 폴더를 여러 채널이 공유하면 실행 잠금으로 동시 수정을 직렬화합니다.
- reviewer와 arbiter는 호스트 홈과 `workDir`를 읽기 전용으로 잠그고 역할 세션·IPC 경로만 쓰기 허용한 mount namespace에서 실행됩니다. owner가 보고한 외부 작업 경로와 비변경 원격 증거도 같이 검증합니다.

## 아키텍처

```text
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Owner (host process)
                                          │       │
                                          │       ▼
                                          ├──► Reviewer (mount namespace, workDir read-only)
                                          │       │
                                          │   verdict routing
                                          │       ├─ DONE → finalize
                                          │       ├─ feedback → owner loop
                                          │       └─ BLOCKED → arbiter / user
                                          │
                                          ├──► Arbiter (on-demand, fresh session)
                                          │       │
                                          │   ┌───┴─── MoA ───┐
                                          │   │ Kimi / GLM    │
                                          │   │ 의견 수집      │
                                          │   └───────────────┘
                                          │
                                     IPC follow-up / host tools
                                          │
                              ┌────────── Router ──────────┐
                              ▼                            ▼
                    paired_turn_outputs            Discord display
```

## 시작하기

### 요구사항

- Linux(Ubuntu 22.04+)와 systemd user service
- Node.js 20 이상
- [Bun](https://bun.sh/) 1.3+
- Git, `gcc`, `make`
- reviewer / arbiter 격리를 위한 `bubblewrap`, `socat`, user namespace와
  `/usr/bin/unshare`
- Claude Code CLI
- Codex CLI
- Discord 봇 토큰(owner 필수, tribunal은 reviewer, arbiter 사용 시 arbiter)

현재 runner 번들 기준 버전:

- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk@0.3.153`
- Codex SDK/CLI: `@openai/codex@0.144.1`

Ubuntu에서는 시스템 패키지를 먼저 준비합니다.

```bash
sudo apt update
sudo apt install -y build-essential bubblewrap git socat util-linux
```

### Discord 봇 준비

Discord Developer Portal에서 owner, reviewer, arbiter용 애플리케이션과 봇을
각각 만듭니다.

1. 세 봇 모두 **Message Content Intent**를 활성화합니다.
2. OAuth2의 `bot` scope로 서버에 초대합니다.
3. 사용할 채널에 View Channel, Send Messages, Read Message History,
   Attach Files, Embed Links 권한을 부여합니다.
4. Discord의 개발자 모드를 켜고 최초 제어 채널 ID를 복사합니다.

owner 봇은 항상 필요합니다. tribunal room에는 reviewer 봇이 필요하고,
arbiter를 사용하려면 arbiter 봇과 `ARBITER_AGENT_TYPE` 설정이 필요합니다.
토큰은 채팅, 문서, 이슈에 붙이지 않습니다.

### 설치와 초기 설정

```bash
git clone https://github.com/bjrambo/RBClaw.git
cd RBClaw
bash setup.sh
cp .env.example .env
```

`.env`에는 사용할 역할의 Discord 토큰과 provider 설정을 입력합니다.
전체 키 설명은 [docs/configuration.md](docs/configuration.md)를 봅니다.

```bash
DISCORD_OWNER_BOT_TOKEN=       # 필수
DISCORD_REVIEWER_BOT_TOKEN=    # tribunal room 사용 시
DISCORD_ARBITER_BOT_TOKEN=     # arbiter 사용 시

OWNER_AGENT_TYPE=codex
REVIEWER_AGENT_TYPE=claude-code

# Arbiter를 사용할 때만 활성화
# ARBITER_AGENT_TYPE=codex

CLAUDE_CODE_OAUTH_TOKENS=
```

Codex는 서비스를 실행할 OS 계정의 Codex CLI OAuth 세션을 사용합니다.
Claude Code도 같은 계정에서 CLI 로그인을 완료하거나
`CLAUDE_CODE_OAUTH_TOKENS`를 설정해야 합니다. `.env` 권한은 다른 사용자가
읽지 못하도록 제한하는 것을 권장합니다.

```bash
chmod 600 .env
```

환경과 runner를 확인합니다.

```bash
bun run setup -- --step environment
bun run setup -- --step runners
```

최초 owner 제어 채널을 main room으로 등록합니다. JID는
`dc:<Discord channel ID>` 형식이고, `--trigger`나
`--no-trigger-required` 옵션은 사용하지 않습니다.

```bash
bun run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #control" \
  --folder discord_main \
  --channel discord \
  --is-main
```

서비스를 설치하고 전체 상태를 검증합니다.

```bash
bun run setup -- --step service
bun run setup -- --step verify
```

Linux에서는 `~/.config/systemd/user/rbclaw.service`가 설치됩니다. 최초 main
room의 `workDir`가 비어 있으면 서비스 프로젝트 루트로 한 번 복구됩니다.

### 추가 room 등록

추가 room은 main room에서 `assign_room` 도구로 등록합니다. Discord main
room에 다음과 같이 요청하면 됩니다.

```text
다음 채널을 assign_room으로 등록해줘.
jid: dc:123456789012345679
name: My Server #development
room_mode: tribunal
work_dir: /absolute/path/to/project
owner_agent_type: codex
reviewer_agent_type: claude-code
requires_trigger: false
```

- `assign_room`은 main room에서만 실행할 수 있습니다.
- `room_mode`는 `single` 또는 `tribunal`입니다.
- `work_dir`는 실제로 존재하는 절대경로여야 합니다.
- `folder`, 역할별 model / effort, arbiter provider도 room별로 덮어쓸 수
  있습니다.
- `workDir`는 기본 cwd와 잠금 기준이며, 별도 승인된 외부 경로 접근을
  차단하는 경계가 아닙니다.

### 개인 페르소나와 로컬 규칙

공개 프롬프트를 수정하지 않고 개인 페르소나, 말투, 프로젝트 경로 매핑,
로컬 접근 규칙과 작업 선호를 설정하려면 예시 파일을 복사합니다.

```bash
cp prompts/CUSTOM.example.md prompts/CUSTOM.md
```

- `prompts/CUSTOM.md`는 owner 프롬프트 맨 앞에 한 번 주입됩니다.
- reviewer와 arbiter에는 주입되지 않아 독립적인 검증 역할을 유지합니다.
- 이 파일은 Git에서 제외되므로 개인 설정을 공개 저장소에 커밋하지 않습니다.
- 비밀번호, 토큰, 개인키 같은 자격증명은 저장하지 말고 `.env` 또는 지원되는
  비밀 저장소를 사용합니다.

자세한 작성 항목은
[`prompts/CUSTOM.example.md`](prompts/CUSTOM.example.md)를 참고합니다.

### 개발 실행

```bash
bun run dev
```

프로덕션 서비스 상태와 로그는 다음 명령으로 확인합니다.

```bash
systemctl --user status rbclaw --no-pager --lines=20
journalctl --user -u rbclaw -f
```

### 웹 대시보드

로컬 대시보드는 기본적으로 꺼져 있습니다. `.env`에서 활성화한 뒤
`bun run build:all`과 서비스 재시작을 수행합니다.

```bash
WEB_DASHBOARD_ENABLED=true
WEB_DASHBOARD_HOST=127.0.0.1
WEB_DASHBOARD_PORT=8734
WEB_DASHBOARD_TOKEN=replace-with-a-long-random-token
```

기본 주소는 `http://127.0.0.1:8734`입니다. 조회 전용 localhost 사용은
토큰 없이 가능하지만 메시지 전송, 설정 변경, 서비스 재시작 같은 mutating
API에는 `WEB_DASHBOARD_TOKEN`이 필요합니다. 다른 장치에서 접근할 때는
Tailscale, VPN 또는 SSH tunnel을 사용하고 토큰을 설정합니다. 공개
인터넷에는 HTTPS reverse proxy와 접근 제어 없이 노출하지 않습니다.

### 배포

```bash
bun run deploy
```

이 스크립트는 다음을 순서대로 수행합니다.

1. Git 작업 트리가 깨끗한지 확인
2. `git pull --ff-only`
3. `bun install --frozen-lockfile`
4. `bun run build:all`
5. `bun run verify:dist`
6. `migrate-room-registrations`
7. `systemctl --user restart rbclaw`

배포 후에는 서비스와 설치 상태를 다시 확인합니다.

```bash
systemctl --user status rbclaw --no-pager --lines=20
bun run setup -- --step verify
```

로컬 변경이나 untracked 파일이 있으면 배포가 시작되기 전에 차단됩니다.
데이터베이스 마이그레이션과 서비스 재시작이 포함되므로 운영 환경에서는
변경 내용을 검토하고 백업한 뒤 실행합니다.

## 데이터, 보안, 백업

다음 경로는 Git에 포함되지 않는 로컬 운영 데이터입니다.

| 경로                    | 내용                                     |
| ----------------------- | ---------------------------------------- |
| `.env`                  | Discord 토큰과 provider 자격 증명        |
| `store/`                | SQLite 데이터베이스                      |
| `data/`                 | 세션, IPC, 첨부파일과 런타임 보조 데이터 |
| `groups/`               | room별 메모리와 로그                     |
| `logs/`                 | 서비스와 setup 로그                      |
| `prompts/CUSTOM.md`     | owner 전용 개인 프롬프트                 |
| `runners/local-skills/` | 로컬 전용 skill override                 |

- `.env`, `data/`, 세션 로그와 shell snapshot은 자격 증명이나 대화 내용을
  포함할 수 있으므로 공개 저장소와 공유 파일에 넣지 않습니다.
- 백업은 저장소 밖의 접근 제한된 위치에 보관합니다.
- SQLite를 복사할 때는 서비스를 중지하거나 SQLite backup 방식으로 일관된
  snapshot을 만듭니다.
- 복구에 필요한 `.env`, `store/`, `data/`, `groups/`,
  `prompts/CUSTOM.md`, `runners/local-skills/`를 함께 관리합니다.
- 토큰이나 키는 문서, `CUSTOM.md`, Git 커밋에 저장하지 말고 노출되면 즉시
  폐기하고 재발급합니다.

## 개발

```bash
bun run build
bun run build:runners
bun run test
bun run typecheck
bun run check
```

Pull request CI는 Node.js 20과 Bun에서 `bun run check`를 실행합니다. runner,
dashboard 또는 runtime 경로를 수정했으면 `bun run build:all`과
`bun run verify:dist`도 확인합니다.

## 문제 해결

기본 점검 순서:

```bash
bun run setup -- --step environment
bun run setup -- --step verify
systemctl --user status rbclaw --no-pager --lines=50
journalctl --user -u rbclaw --since "30 minutes ago" --no-pager
tail -n 100 logs/rbclaw.error.log
```

- 봇이 연결되지 않으면 role별 Discord 토큰, Message Content Intent, 채널
  권한을 확인합니다.
- 메시지는 보이지만 실행되지 않으면 room JID, `room_mode`, 유효한
  `workDir`를 확인합니다.
- 에이전트가 즉시 종료되면 서비스 계정의 Claude / Codex 인증과
  `groups/<folder>/logs/`의 최신 agent 로그를 확인합니다.
- source 변경 후 import 오류가 나면 `bun run build:all`과
  `bun run verify:dist`로 stale dist를 확인합니다.
- setup 실패의 상세 기록은 `logs/setup.log`에 있습니다.

## 문서

- [docs/architecture.md](docs/architecture.md) — 데이터 모델, 실행 흐름, 주요 파일
- [docs/configuration.md](docs/configuration.md) — `.env` 키와 디버깅 경로
- [apps/android/README.md](apps/android/README.md) — Android companion 빌드와 연결
- [apps/voice-companion/README.md](apps/voice-companion/README.md) — Windows Voice Companion
- [CONTRIBUTING.md](CONTRIBUTING.md) — 기여 범위와 검증 방법
- [docs/legacy-compat-removal-spec.md](docs/legacy-compat-removal-spec.md) — 남아 있는 레거시 제거 계획
- [CHANGELOG.md](CHANGELOG.md) — 릴리즈 이력

## 라이선스

MIT
