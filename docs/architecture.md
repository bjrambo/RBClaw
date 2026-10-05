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

## 진행 표시와 교신 출력 분리

- 첫 완성된 공개 진행 문구는 다음 agent 이벤트를 기다리지 않고 즉시 전송합니다. Codex의 token delta, plan, reasoning은 이 표시 경로로 스트리밍하지 않습니다.
- Codex app-server의 허용된 도구 `item/started`와 `item/completed` 이벤트는 `tool-activity`로 전달합니다. 도구 종류와 시작·완료·실패·중단·거부 상태에 허용된 명령 접두어(예: `bun run test …`) 또는 안전한 파일명(예: `읽기 package.json`) 요약을 덧붙입니다. 임의 인자·환경변수 값·전체 경로·도구 결과·reasoning은 복사하지 않습니다.
- `functions.exec` 같은 실행 묶음은 정적으로 읽을 수 있는 `tools.exec_command({cmd: "..."})` 호출만 요약합니다. 코드를 실행하거나 변수를 해석하지 않으며, 동적 문자열·spread·중복 cmd·지원하지 않는 문법은 일반 도구 표시로 남깁니다. 요약은 최대 3건·약 100자로 제한합니다.
- Claude의 완성된 공개 assistant 문구도 즉시 `progress`로 전달합니다. `PreToolUse`·`PostToolUse`·`PostToolUseFailure`는 시작·완료·실패·중단을 `tool-activity`로 보내며, Codex와 같은 shared 안전 요약기를 사용합니다. 훅은 표시용 부수 출력만 내고 모델 입력에 `additionalContext`나 도구 결과를 추가하지 않습니다. 기존 Bash 시크릿 제거·리뷰어 읽기 전용 훅은 유지합니다.
- Claude의 원시 tool_use/tool_result·자유 형식 tool_use_summary·reasoning은 표시 경로에 복사하지 않습니다. 정식 SDK result 또는 명시적 assistant end_turn만 최종으로 인정하며, 중간 문구는 스트림 종료·close·빈 결과에서 최종 답변으로 승격하지 않습니다. 정식 결과 없는 비정상 스트림 종료는 오류로 보고합니다.
- 주 실행의 도구 활동은 최근 8건을 유지하고 1초 주기의 coalescing 편집으로 갱신합니다. 개별 활동마다 새 Discord 메시지를 만들지 않으며, 긴 진행 문구에서도 최신 활동이 Discord 길이 제한 안에 남도록 렌더링합니다.
- 전달받은 활동 메타데이터는 scoped runtime log의 `Agent tool activity`로 기록합니다. 이는 도구 내부의 모든 마우스 동작이나 원시 실행 결과를 수집한다는 뜻은 아닙니다.
- 초기 진행 메시지 전송과 최종 메시지 교체는 직렬화합니다. paired owner/reviewer/arbiter 턴은 최종 출력이 없더라도 진행 문구나 기본 heading을 최종 답변으로 재사용하지 않습니다.
- owner↔reviewer 교신은 canonical `paired_turn_outputs`와 현재 사용자 지시를 기준으로 구성합니다. canonical 출력이 없는 fallback에서도 task-status 표시 메시지는 프롬프트에서 제외합니다.
- 이 경로는 진행 표시 지연을 줄입니다. 마우스 실행 속도, 사용자 추가 지시의 턴 전환, 메시지 폴링 주기 자체는 변경하지 않습니다.

구현 경계는 `runners/codex-runner/src/app-server-tool-activity.ts`,
`runners/codex-runner/src/app-server-client.ts`,
`runners/shared/src/tool-activity-summary.ts`,
`runners/agent-runner/src/claude-tool-activity.ts`,
`runners/agent-runner/src/claude-query-runner.ts`,
`src/message-turn-controller.ts`, `src/message-runtime-prompts.ts`입니다.

## Tribunal 역할 분리

| 역할     | 기본 선택                                     | 설명                                   |
| -------- | --------------------------------------------- | -------------------------------------- |
| owner    | room별 `owner_agent_type` (기본 Codex)        | 사용자 요청 처리, 코드 작성, 최종 응답 |
| reviewer | 전역 `REVIEWER_AGENT_TYPE` (기본 Claude Code) | owner 결과 검토, 회귀 검증             |
| arbiter  | 전역 `ARBITER_AGENT_TYPE` (옵션)              | owner / reviewer 교착 시 판정          |

## Persistent Goal / Supervisor

`paired_tasks.id`가 canonical Persistent Goal ID입니다. 기존 `status`는
Tribunal phase를 유지하고, `supervisor_state`는 실행 가능 여부를 별도로
관리합니다.

```text
Persistent Goal (paired_tasks.id)
└─ Checklist Plan (plan_notes versioned JSON)
   └─ Episode / Checklist Step
      └─ Tribunal Round
         ├─ Owner Turn
         ├─ Reviewer Turn
         └─ Arbiter Turn
```

- `round_trip_count`: 현재 Episode 왕복 수
- `total_round_trip_count`: Goal 전체 누적 왕복 수
- `arbitration_count`: 실제 Arbiter claim 누적 수
- `progress_fingerprint`: Git/source/output/feedback/blocker의 결정론적 지문
- `runnable`: 후속 turn 예약 가능
- `waiting_retry`: `resume_at` 이후 watchdog가 한 번 재개
- `waiting_external`: 연결된 Goal watcher terminal event만 재개
- `waiting_user`: 새 사용자 입력으로 같은 Goal 재개
- `parked`: 자동 실행 중지, 사용자 입력으로 명시적 재개

Arbiter의 `PROCEED`, `REVISE`, `RESET`은 새 Episode를 열어 episode counter만
초기화합니다. total counter는 Goal 종료까지 감소하지 않습니다. Arbiter
directive는 runner structured output에서 SQLite까지 보존하며 canonical JSON
fingerprint로 같은 지시 반복을 차단합니다.

Agent turn은 activity timeout과 독립적인 hard wall-clock timeout을 가집니다.
hard timeout은 정상 close 요청 후 grace period를 거쳐 SIGTERM/SIGKILL 정책을
적용하고, retryable failure는 즉시 재실행하지 않고 backoff 상태로 전환합니다.

GitHub watcher는 `paired_task_id + external_wait_ref`로 Goal과 연결됩니다. 같은
chat의 다른 Goal은 terminal event로 깨어나지 않습니다. Discord work item은
전송 전에 stable delivery key를 저장하고 Discord nonce/enforceNonce를
chunk별로 사용합니다. native idempotency가 없는 Channel의 모호한 결과는
자동 재전송하지 않고 `waiting_user`로 격리합니다.

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

### 진행 표시 배포 확인 (2026-10-05)

- 구현 커밋 `9756cdb`는 승인된 runtime/test 14파일만 포함하며, 개발 `main`과 GitHub `main`에 동일하게 반영했습니다. 기존 fixtures, 시크릿 백업, 임시 검증 자료는 커밋에서 제외했습니다.
- 운영 `/home/qw5414/bot/EJClaw`은 기존 작업 보존을 위해 `feature/dotnet-runtime`의 HEAD `115bcc7`을 유지합니다. 적용된 14파일은 구현 커밋과 동일하지만, 운영 checkout은 기존 사용자 작업과 배포 파일을 포함한 의도된 미커밋 상태입니다. 운영 HEAD나 전체 트리가 원격 `main`과 같다는 뜻은 아닙니다.
- 개발·운영 테스트 1,706개 통과·3개 건너뜀, 전체 runtime 빌드와 282개 source 파일의 dist freshness 검증을 통과했습니다. 재시작 후 서비스 `active/running`, `ExecMainStatus=0`과 compiled production 경로의 `RBCLAW_PROGRESS_LIVE_OK` 실호출을 확인했습니다.
- 실호출의 표시 검증은 테스트 수신부를 사용했습니다. 재시작 후 owner↔reviewer 흐름은 정상 실행됐지만, 별도의 새 사용자 Discord 메시지 왕복 테스트와 실제 마우스 실행 속도 측정은 수행하지 않았습니다.
- 운영의 다른 미커밋 작업을 정리하거나 전체 checkout을 reset하지 않습니다. 재배포·롤백 시에도 승인된 변경과 기존 사용자 작업을 구분하고, 배포 소스가 해당 구현 커밋과 일치하는지 확인해야 합니다.

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
