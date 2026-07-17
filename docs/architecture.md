# 아키텍처

## 서비스 구성

RBClaw는 단일 `rbclaw` 서비스가 세 Discord 봇과 paired runtime을 함께 운영하는 구조입니다.

- `rbclaw.service`: 단일 unified process
- Discord 봇:
  - `DISCORD_OWNER_BOT_TOKEN`
  - `DISCORD_REVIEWER_BOT_TOKEN`
  - `DISCORD_ARBITER_BOT_TOKEN`
- 저장소:
  - `store/`: SQLite DB
  - `groups/`: room별 로그 / 메모리 / 설정
  - `data/`: 세션과 런타임 보조 데이터
- SQLite는 WAL + `busy_timeout=5000` 기준으로 동작

## 핵심 데이터 모델

| 구성 요소             | 역할                                                       |
| --------------------- | ---------------------------------------------------------- |
| `room_settings`       | room-level SSOT                                            |
| `room_role_overrides` | 역할별 agent type / agentConfig override                   |
| `paired_tasks`        | paired runtime의 상태 머신                                 |
| `registered_groups`   | compatibility / materialized read-model 성격의 잔존 레이어 |

현재 기준에서 중요한 점:

- room 설정의 기준은 `room_settings`
- reviewer / arbiter는 room의 공개 진입점이 아니라 내부 역할
- `registered_groups`는 제거 진행 대상이지만 아직 완전히 사라진 것은 아님

## 실행 흐름

```text
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Owner (host process)
                                          │       │
                                          │       ▼
                                          ├──► Reviewer (mount namespace, workDir read-only)
                                          │       │
                                          │   verdict routing
                                          │       ├─ DONE → owner finalize
                                          │       ├─ feedback → owner loop
                                          │       └─ BLOCKED → arbiter / user
                                          │
                                          ├──► Arbiter (on-demand)
                                          │       │
                                          │   ┌───┴─── MoA ───┐
                                          │   │ Kimi / GLM    │
                                          │   │ 의견 수집      │
                                          │   └───────────────┘
                                          │
                                     IPC polling / host tools
                                          │
                              ┌────────── Router ──────────┐
                              ▼                            ▼
                    paired_turn_outputs            Discord display
```

## Tribunal 역할 분리

| 역할     | 기본 선택                                     | 설명                                   |
| -------- | --------------------------------------------- | -------------------------------------- |
| owner    | room별 `owner_agent_type` (기본 Codex)        | 사용자 요청 처리, 코드 작성, 최종 응답 |
| reviewer | 전역 `REVIEWER_AGENT_TYPE` (기본 Claude Code) | owner 결과 검토, 회귀 검증             |
| arbiter  | 전역 `ARBITER_AGENT_TYPE` (옵션)              | owner / reviewer 교착 시 판정          |

역할별 model / effort는 전역 env(`OWNER_*`, `REVIEWER_*`, `ARBITER_*`)로 정하고, room-level `agentConfig`는 provider별(`claudeModel`, `codexModel`) override만 제공합니다. `glm-code`는 Claude Agent SDK 호환 runner로 취급하되 전용 launcher(`RBCLAW_GLM_CODE_CLI_PATH` 또는 PATH의 `glm-code`)를 사용하므로, 기존 Claude Code reviewer와 분리해 owner/arbiter만 GLM으로 전환할 수 있습니다.

## Reviewer / Arbiter runtime

- `paired_tasks.work_dir`는 작업 생성 시 채널의 지정 폴더를 고정합니다
- owner는 지정 폴더를 기본 cwd로 사용하고, 사용자 지시와 room/local 규칙이 허용하면 다른 로컬 경로나 SSH·SFTP·FTP 원격 대상도 작업합니다
- reviewer / arbiter는 `unshare` mount namespace에서 호스트 홈과 지정 폴더를 read-only로 읽고, owner가 보고한 외부 로컬 경로와 비변경 원격 증거를 같이 검증합니다
- reviewer / arbiter namespace는 호스트 홈도 read-only로 잠그고, 역할 세션과 IPC 디렉토리만 쓰기 가능하게 다시 mount합니다
- sandbox 설정 뒤 mount capability를 제거하며, 경계 구성이나 경로 겹침 검증에 실패하면 agent를 실행하지 않습니다
- clone, snapshot, linked worktree는 생성하지 않습니다
- 채널에 `workDir`가 없거나 경로가 유효하지 않으면 다른 경로로 fallback하지 않고 실행을 차단합니다
- `workDir`는 기본 실행 위치와 잠금 키이며 owner의 절대 접근 경계가 아닙니다. 외부 접근 허용은 사용자 지시와 room/local 규칙이 결정합니다
- arbiter는 reviewer와 같은 read-only 작업 폴더를 쓰되, 세션 디렉토리는 매 호출마다 fresh하게 준비합니다

## 세션 / 프롬프트 구성

- owner는 채널의 지정 작업 폴더 + stable session을 사용
- reviewer / arbiter는 read-only 세션 디렉토리를 매 실행 전에 다시 준비
- `prepareReadonlySessionEnvironment()`가 `CLAUDE.md`, `.codex/AGENTS.md`, 설정 파일을 매번 재생성
- 그래서 reviewer 관련 프롬프트 / 세션 설정 변경은 기존 실행 중 프로세스에는 즉시 적용되지 않지만, **다음 reviewer 턴부터는 자동 반영**됩니다

## 검증 / 운영 경로

- 검증 명령은 `bun run check` 하나로 묶여 있음
  - format
  - typecheck
  - test
  - build
- reviewer / arbiter가 직접 로컬 빌드를 못 돌려도, host verification 경로로 `typecheck`, `test`, `build`를 수행할 수 있음
- startup precondition은 전용 오류로 올리고, `RestartPreventExitStatus=78`로 crash loop를 막음
- deploy는 `migrate-room-registrations`를 선행한 뒤 service restart를 수행

## 주요 파일

| 파일                              | 역할                                           |
| --------------------------------- | ---------------------------------------------- |
| `src/index.ts`                    | 전체 오케스트레이션 진입점                     |
| `src/message-runtime.ts`          | 메시지 루프, paired flow 연결                  |
| `src/message-turn-controller.ts`  | progress / final delivery 제어                 |
| `src/paired-execution-context.ts` | owner / reviewer / arbiter 실행 준비           |
| `src/agent-runner.ts`             | host process spawn, env/session wiring         |
| `src/db.ts`                       | 런타임 DB facade                               |
| `src/db/`                         | canonical room / paired state / migration 로직 |
| `runners/agent-runner/`           | Claude Code runner                             |
| `runners/codex-runner/`           | Codex runner                                   |
| `setup/`                          | setup / verify / service rendering             |
