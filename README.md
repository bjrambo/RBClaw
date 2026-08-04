# RBClaw

![Version](https://img.shields.io/badge/version-0.2.3-blue)
![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.3.153-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.144.1-green)
![Bun](https://img.shields.io/badge/Bun-1.3+-f9f1e1?logo=bun&logoColor=black)
![Discord](https://img.shields.io/badge/Discord-Tribunal-5865F2?logo=discord&logoColor=white)

RBClaw는 Discord 위에서 동작하는 Tribunal 멀티에이전트 개발 보조 시스템입니다.
사용자 요청은 owner가 받고, reviewer가 자동 리뷰를 수행하며, 필요할 때 arbiter가 교착을 정리합니다.

## 프로젝트 배경

RBClaw의 코드 흐름은 [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)에서
출발해 [phj1081/EJClaw](https://github.com/phj1081/EJClaw)로 이어졌습니다.
이후 EJClaw의 개발 방향이 최신 모델 성능에 맞춰 agent harness를 더 얇게
가져가는 쪽으로 바뀌었습니다. 반면 실제 운영과 테스트를 거치면서 단순한
실행 하네스만으로는 부족하고, 작업 결과를 다시 검토하고 교착을 정리하는
구조화된 검증 시스템을 계속 유지할 필요가 있다고 판단했습니다.

이후 요구사항은 Discord 중심의 owner / reviewer / arbiter 역할 분리,
paired-runtime, room별 `workDir`, reviewer 읽기 전용 검증, 개인 설정과 공개
코드의 분리까지 확장됐습니다. 기존 프로젝트와 지향점이 점차 달라지면서 이
구조를 별도의 독립 프로젝트로 발전시키겠다는 계획이 만들어졌습니다.

그 결과 과거 Git 이력을 새 공개 저장소에 승계하지 않고 RBClaw을 첫
커밋부터 다시 시작했습니다. 현재는 Discord 기반 검증·중재 흐름을 중심으로
독립 개발·운영되고 있습니다.

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

### Persistent Supervisor

Tribunal phase와 장기 실행 상태를 분리합니다. `paired_tasks.id`가 Persistent
Goal ID이며, 같은 Goal 안에서 bounded Episode만 반복합니다.

- Episode owner/reviewer 왕복 기본 상한: 6
- Goal 자동 Arbiter 호출 기본 상한: 2
- 동일 progress fingerprint 기본 허용 횟수: 2
- 실행 불가 상태: `waiting_retry`, `waiting_external`, `waiting_user`,
  `parked`
- 대기 상태에서는 LLM을 polling 용도로 호출하지 않습니다.
- 사용자 입력은 같은 Goal을 재개하되 total round와 arbitration count를
  보존합니다.
- `completed`, `cancelled`, `superseded` 이후 새 요청만 새 Goal이 됩니다.

`플랜 시작: 1) ... 2) ...`, `플랜 상태`, `플랜 중지` 명령은 Checklist를
같은 Goal의 Episode 순서로 관리합니다. 마지막 item이 승인되어야 Goal이
완료됩니다.

Agent activity timeout과 별도로 `HARD_TURN_TIMEOUT`이 절대 벽시계 상한을
제공합니다. 출력이나 tool activity는 hard timeout을 연장하지 않습니다.

복구는 at-least-once 실행을 허용하되 reservation, execution lease, CAS,
stable delivery key로 RBClaw이 소유한 상태 전이·후속 turn·watcher·Discord
전달을 effective-once로 수렴시킵니다. 임의 shell/SSH/API 변경은 이 보장
범위가 아니며 확인할 수 없는 crash 경계에서는 자동 재실행하지 않습니다.

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

## 초보자 설치 가이드

처음에는 **Owner 봇 하나와 Codex 하나만 연결해 첫 응답을 확인**하는 것이
가장 쉽습니다. 이 경로가 성공한 뒤 Reviewer와 Arbiter를 추가하면 어느
단계에서 문제가 생겼는지 구분하기 쉽습니다.

설치 과정에서 토큰, API 키, OAuth 코드는 채팅이나 이슈에 올리지 마세요.
아래 명령은 RBClaw을 실행할 일반 사용자 계정으로 수행하고, `sudo`는 시스템
패키지를 설치할 때만 사용합니다.

### 1. 준비물

초보자에게 권장하는 환경은 Ubuntu 22.04 이상과 systemd user service입니다.

- Discord 서버에서 봇을 초대할 수 있는 권한
- Node.js 20 이상
- [Bun 1.3 이상](https://bun.sh/docs/installation)
- Git, `gcc`, `make`, `bubblewrap`, `socat`, `/usr/bin/unshare`
- Owner가 사용할 Codex 또는 Claude 계정
- Tribunal을 사용할 경우 Reviewer용 Claude 또는 Codex 계정

Ubuntu 시스템 도구를 먼저 설치합니다.

```bash
sudo apt update
sudo apt install -y build-essential bubblewrap curl git socat unzip util-linux
```

Node.js 20 이상을 설치한 뒤 버전을 확인합니다. Bun이 없다면 공식 설치
스크립트를 사용하고 새 터미널을 엽니다.

```bash
node --version

curl -fsSL https://bun.com/install | bash
bun --version
```

각 명령은 `node`가 `v20` 이상, `bun`이 `1.3` 이상을 출력해야 합니다.

### 2. AI CLI 설치와 로그인

가장 쉬운 첫 실행은 Owner를 Codex로 사용하는 것입니다.

```bash
npm install -g @openai/codex
codex login
codex login status
```

Tribunal에서 Claude Reviewer를 사용할 계획이면 Claude Code도 준비합니다.

```bash
npm install -g @anthropic-ai/claude-code
claude auth login --claudeai
claude auth status --text
```

두 CLI 모두 **RBClaw 서비스를 실행할 같은 OS 사용자 계정**에서 로그인해야
합니다. 서버가 headless 환경이면 터미널에 표시된 공식 로그인 URL을 다른
기기의 브라우저에서 열어 승인할 수 있습니다.

현재 runner 번들 기준 버전은 다음과 같습니다.

- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk@0.3.153`
- Codex SDK/CLI: `@openai/codex@0.144.1`

### 3. Discord Owner 봇 만들기

[Discord Developer Portal](https://discord.com/developers/applications)에서
애플리케이션을 하나 만들고 다음 순서로 설정합니다.

1. **Bot** 메뉴에서 Owner 봇 토큰을 발급해 비밀번호 관리자에 보관합니다.
2. **Message Content Intent**를 활성화합니다.
3. **Installation** 또는 **OAuth2**에서 `bot` scope를 선택합니다.
4. View Channel, Send Messages, Read Message History, Attach Files,
   Embed Links 권한을 선택하고 봇을 서버에 초대합니다.
5. Discord 사용자 설정의 **개발자 모드**를 켜고 제어할 채널의 ID를
   복사합니다.

Reviewer와 Arbiter 봇은 첫 응답을 확인한 뒤 같은 방법으로 추가해도 됩니다.
각 역할은 별도 Discord 봇 토큰을 사용합니다.

### 4. RBClaw 내려받기

```bash
git clone https://github.com/bjrambo/RBClaw.git
cd RBClaw
bash setup.sh
```

마지막 출력에서 다음 항목을 확인합니다.

```text
BUN_OK: true
DEPS_OK: true
STATUS: success
```

실패하면 먼저 `logs/setup.log`를 확인합니다. `setup.sh`는 시스템 패키지나
Bun을 자동 설치하지 않고, Bun 의존성을 설치한 뒤 상태를 보고합니다.

### 5. 최소 환경 설정

예시 파일을 복사하고 `.env`를 편집합니다.

```bash
cp .env.example .env
nano .env
```

첫 실행에서는 아래 항목만 확인하면 됩니다. 실제 토큰 값은 README 예시에
적지 않습니다.

```bash
DISCORD_OWNER_BOT_TOKEN=<Owner 봇 토큰>
OWNER_AGENT_TYPE=codex
ASSISTANT_NAME=claude
```

CLI 로그인을 사용하면 `OPENAI_API_KEY`를 `.env`에 넣지 않습니다. Reviewer를
아직 사용하지 않는다면 Reviewer와 Arbiter 토큰은 빈 값으로 둡니다.

```bash
chmod 600 .env
```

전체 환경 변수와 역할별 모델 설정은
[설정 문서](docs/configuration.md)를 참고합니다.

### 6. 환경과 runner 확인

```bash
bun run setup -- --step environment
bun run setup -- --step runners
```

첫 명령은 OS, `.env`, sandbox 도구, 기존 room 상태를 확인합니다. 두 번째
명령은 Codex와 Claude runner를 모두 빌드합니다. 성공하면 각 출력의 마지막
상태가 `STATUS: success`여야 합니다.

### 7. 최초 제어 채널 등록

아래 숫자를 앞에서 복사한 Discord 채널 ID로 바꿉니다. JID의 `dc:` 접두사는
삭제하지 않습니다.

```bash
bun run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #control" \
  --folder discord_main \
  --channel discord \
  --is-main
```

최초 room은 Owner만 실행하는 `single` 모드로 등록됩니다. `folder`는 영문이나
숫자로 시작하고 영문, 숫자, `_`, `-`만 사용하는 64자 이하의 고유한 이름으로
지정합니다. `global`은 예약된 이름입니다.

### 8. 서비스 시작과 첫 응답 확인

```bash
bun run setup -- --step service
bun run setup -- --step verify
```

Linux에서는 `~/.config/systemd/user/rbclaw.service`가 설치됩니다. 검증 출력의
마지막이 `STATUS: success`인지 확인한 뒤, 등록한 Discord 채널에서 Owner
봇에게 간단한 메시지를 보냅니다.

```text
안녕. 현재 작업 폴더와 브랜치만 알려줘.
```

응답이 오면 기본 설치가 끝난 것입니다. 응답이 없으면 다음 순서로 확인합니다.

```bash
systemctl --user status rbclaw --no-pager --lines=50
journalctl --user -u rbclaw --since "10 minutes ago" --no-pager
tail -n 100 logs/rbclaw.error.log
```

### 9. Tribunal 확장

Owner가 정상 응답한 뒤 Reviewer를 추가합니다.

1. Discord Developer Portal에서 Reviewer 봇을 만들고 Owner와 같은 권한을
   부여합니다.
2. Claude Code 또는 Reviewer로 사용할 provider의 CLI 로그인을 완료합니다.
3. `.env`에 Reviewer 토큰과 provider를 설정합니다.

```bash
DISCORD_REVIEWER_BOT_TOKEN=<Reviewer 봇 토큰>
REVIEWER_AGENT_TYPE=claude-code
```

설정을 읽도록 서비스를 재시작합니다.

```bash
systemctl --user restart rbclaw
bun run setup -- --step verify
```

Linux에서는 `bun run setup -- --step environment` 출력의
`HAS_BWRAP_READONLY_SANDBOX_CAPABILITY`도 `true`여야 합니다. `false`이면
Reviewer는 안전을 위해 실행을 거부합니다. 이 경우 전체 setup을 root로
실행하지 말고 `logs/setup.log`와 호스트의 AppArmor/user namespace 정책을
시스템 관리자와 확인합니다.

그다음 main room에서 개발 채널을 Tribunal room으로 등록하도록 요청합니다.

```text
다음 채널을 assign_room으로 등록해줘.
jid: dc:123456789012345679
name: My Server #development
room_mode: tribunal
work_dir: /absolute/path/to/project
owner_agent_type: codex
reviewer_agent_type: claude-code
requires_trigger: false
# 선택: Git 밖의 read-only 원격 진단 profile ID
review_access_profile: my-web-review
```

- `assign_room`은 main room에서만 실행할 수 있습니다.
- `work_dir`는 실제로 존재하는 절대경로여야 합니다.
- `single`은 Owner만, `tribunal`은 Owner와 Reviewer를 실행합니다.
- Arbiter가 필요하면 세 번째 Discord 봇 토큰과 `ARBITER_AGENT_TYPE`을 설정한
  뒤 room에 Arbiter provider를 지정합니다.
- `review_access_profile`은 선택 항목입니다. 설정한 방의 Reviewer에만
  `inspect_remote`가 열리며, URL·SSH profile·서비스·로그·설정 경로는
  private profile에서 가져옵니다. 형식과 보안 경계는
  [설정 문서](docs/configuration.md#reviewer-원격-진단)를 참고합니다.

### 개인 페르소나와 로컬 규칙

공개 프롬프트를 수정하지 않고 개인 페르소나, 말투, 프로젝트 경로 매핑,
로컬 접근 규칙과 작업 선호를 설정하려면 예시 파일을 복사합니다.

```bash
cp prompts/CUSTOM.example.md prompts/CUSTOM.md
```

- `prompts/CUSTOM.md`는 Owner 프롬프트에만 주입됩니다.
- Reviewer와 Arbiter에는 주입되지 않아 독립적인 검증 역할을 유지합니다.
- 이 파일은 Git에서 제외됩니다.
- 비밀번호, 토큰, 개인키는 저장하지 않습니다.

작성 예시는
[`prompts/CUSTOM.example.md`](prompts/CUSTOM.example.md)를 참고합니다.

### 웹 대시보드

로컬 대시보드는 기본적으로 꺼져 있습니다. `.env`에서 활성화한 뒤
`bun run build:all`과 서비스 재시작을 수행합니다.

```bash
WEB_DASHBOARD_ENABLED=true
WEB_DASHBOARD_HOST=127.0.0.1
WEB_DASHBOARD_PORT=8734
WEB_DASHBOARD_TOKEN=replace-with-a-long-random-token
```

기본 주소는 `http://127.0.0.1:8734`입니다. 다른 장치에서 접근할 때는
Tailscale, VPN 또는 SSH tunnel을 사용하고 토큰을 설정합니다. 공개 인터넷에
HTTPS와 접근 제어 없이 노출하지 않습니다.

### 업데이트와 배포

```bash
bun run deploy
```

이 명령은 clean worktree 확인, `git pull --ff-only`, 의존성 설치, 전체 빌드,
dist 검증, room migration, 서비스 재시작을 순서대로 수행합니다. 로컬 변경이나
untracked 파일이 있으면 시작 전에 차단됩니다.

```bash
systemctl --user status rbclaw --no-pager --lines=20
bun run setup -- --step verify
```

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
bun run dev
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

- [docs/easy-setup-wizard-design.md](docs/easy-setup-wizard-design.md) — 초보자용 간편 설치 wizard 설계
- [docs/architecture.md](docs/architecture.md) — 데이터 모델, 실행 흐름, 주요 파일
- [docs/configuration.md](docs/configuration.md) — `.env` 키와 디버깅 경로
- [apps/android/README.md](apps/android/README.md) — Android companion 빌드와 연결
- [apps/voice-companion/README.md](apps/voice-companion/README.md) — Windows Voice Companion
- [CONTRIBUTING.md](CONTRIBUTING.md) — 기여 범위와 검증 방법
- [docs/legacy-compat-removal-spec.md](docs/legacy-compat-removal-spec.md) — 남아 있는 레거시 제거 계획
- [CHANGELOG.md](CHANGELOG.md) — 릴리즈 이력

## 라이선스

MIT
