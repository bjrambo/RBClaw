# 설정

RBClaw의 설정 기준은 `.env` 하나입니다.
프로젝트 루트의 [`../.env.example`](../.env.example)를 기본 예시로 보고, 이 문서는 현재 런타임에서 의미가 있는 키만 추려 설명합니다.

## 기본 원칙

- Discord 토큰은 role-fixed canonical 키만 사용합니다
- reviewer 기본 provider는 `claude-code`
- owner 기본 provider는 `codex`
- room-level override는 provider 단위(`claudeModel`, `codexModel`)만 지원합니다
- `CLAUDE_CODE_OAUTH_TOKENS`가 canonical이고, `CLAUDE_CODE_OAUTH_TOKEN`은 legacy fallback입니다

## Discord 봇

```bash
DISCORD_OWNER_BOT_TOKEN=
DISCORD_REVIEWER_BOT_TOKEN=
DISCORD_ARBITER_BOT_TOKEN=
```

예전 service-based alias는 더 이상 허용되지 않습니다.

## 역할 / 모델 설정

```bash
# 역할별 provider
OWNER_AGENT_TYPE=codex
REVIEWER_AGENT_TYPE=claude-code
ARBITER_AGENT_TYPE=codex
# 사용 가능: codex | claude-code | glm-code
ARBITER_FORCE_POLITE_USER_TONE=true

# provider 기본 모델
# 공식 Claude API 모델 ID입니다.
CLAUDE_MODEL=claude-opus-4-8
CLAUDE_EFFORT=high
CLAUDE_THINKING=adaptive
CODEX_MODEL=gpt-5.5
CODEX_EFFORT=xhigh

# glm-code는 Claude Agent SDK 호환 runner로 실행됩니다.
# agent type만 glm-code로 바꾸고, 모델은 역할별 *_MODEL에 GLM 모델명을 넣습니다.
# OWNER_AGENT_TYPE=glm-code
# OWNER_MODEL=glm-5.2
# RBCLAW_GLM_CODE_CLI_PATH=/home/rbclaw/.local/bin/glm-code

# 역할별 override
OWNER_MODEL=gpt-5.5
OWNER_EFFORT=xhigh
OWNER_FALLBACK_ENABLED=true

REVIEWER_MODEL=claude-opus-4-8
REVIEWER_EFFORT=high
REVIEWER_FALLBACK_ENABLED=true

ARBITER_MODEL=gpt-5.5
ARBITER_EFFORT=xhigh
ARBITER_FALLBACK_ENABLED=true
```

설명:

- reviewer / arbiter provider 선택은 **전역 설정**
- 역할별 `*_MODEL`은 해당 역할의 provider에 맞춰 주입됩니다. `codex` 역할에는 Codex 모델을, `claude-code` 역할에는 Claude 모델을, `glm-code` 역할에는 GLM 모델명을 넣어야 합니다.
- 예를 들어 `ARBITER_AGENT_TYPE=claude-code`로 바꾸면 그때 `ARBITER_MODEL=claude-opus-4-8`을 사용할 수 있고, `ARBITER_AGENT_TYPE=glm-code`면 `ARBITER_MODEL=glm-5.2`를 사용할 수 있습니다.
- `glm-code`는 전역 `RBCLAW_CLAUDE_CLI_PATH`를 건드리지 않고 `RBCLAW_GLM_CODE_CLI_PATH` 또는 PATH의 `glm-code` launcher를 별도로 찾습니다. 그래서 기존 Claude reviewer를 Opus로 유지하면서 owner/arbiter만 GLM으로 바꿀 수 있습니다.
- `ARBITER_AGENT_TYPE`은 옵션이며, 설정하지 않으면 arbiter는 비활성 상태입니다
- `ARBITER_FORCE_POLITE_USER_TONE`은 기본값이 `true`입니다. Arbiter만 모든 방에서 인간 사용자를 중립 존칭인 `사용자님`으로 부르고, 관계 호칭을 추측하지 않으며, 항상 존댓말을 쓰고 명령조로 말하지 않도록 강제합니다. Owner/Reviewer에게 내리는 중재 directive의 구속력은 바뀌지 않습니다. `false`로 두면 이 역할 전용 말투 규칙만 비활성화됩니다.

### 방별(role별) 모델 override

역할별 `*_MODEL`/`*_EFFORT`는 전역 기본값이고, 방마다 role별로 덮어쓸 수 있습니다.
저장 위치는 `room_role_overrides.agent_config_json`이며 입력 경로는 두 가지입니다.

- 웹 대시보드 → 설정 → 모델 → "방별 모델" 카드
- `assign_room` 도구의 `owner_model` / `owner_effort` / `reviewer_model` / `reviewer_effort` / `arbiter_model` / `arbiter_effort` 파라미터 (빈 문자열이면 해당 override 삭제)

우선순위는 `방 role override > 전역 *_MODEL/*_EFFORT > provider 기본값`입니다.
tribunal 방은 다음 턴부터 즉시 적용되고, single 방의 owner override는 재시작(또는 `assign_room` 재실행) 후 적용됩니다.

## Reviewer 원격 진단

웹 프로젝트 방에서 Reviewer가 실제 개발·프로덕션 사이트와 서버 상태를
읽기 전용으로 조사해야 할 때만 활성화합니다. 채널 ID나 서버 주소를 코드에
하드코딩하지 않습니다.

설정은 세 층으로 분리됩니다.

1. 공통 코드: 고정 진단 동작과 보안 검증
2. `room_settings.review_access_profile`: 방에 연결된 profile ID
3. Git 밖의 private JSON: 환경별 URL, SSH profile, 서비스와 허용 경로

main room의 `assign_room`에서 profile을 연결합니다.

```text
assign_room
jid: dc:123456789012345678
room_mode: tribunal
review_access_profile: my-web-review
```

CLI setup에서는 다음 옵션을 사용할 수 있습니다.

```bash
bun run setup -- --step register --review-access-profile my-web-review
```

빈 문자열 또는 `null`로 지정하면 방 연결이 해제됩니다. profile이 없는 방과
Owner/Arbiter에는 원격 진단 도구가 활성화되지 않습니다.

private JSON의 기본 경로는
`~/.server-access/review-access-profiles.json`입니다. 다른 절대경로를 쓰려면
다음 환경 변수를 지정합니다.

```bash
REVIEW_ACCESS_PROFILES_FILE=/home/rbclaw/.server-access/review-access-profiles.json
```

파일 권한은 `600`이어야 하며 예시는 다음과 같습니다.

```json
{
  "version": 1,
  "profiles": {
    "my-web-review": {
      "environments": {
        "production": {
          "web": {
            "baseUrl": "https://example.com",
            "paths": ["/", "/health"],
            "allowedOrigins": ["https://cdn.example.com"],
            "allowedPrivateCidrs": []
          },
          "remote": {
            "sshProfile": "example-prod",
            "allowedRoots": ["/etc/nginx", "/var/log/nginx"],
            "serviceUnits": ["nginx"],
            "journalUnits": ["nginx"],
            "logFiles": [
              { "id": "nginx-error", "path": "/var/log/nginx/error.log" }
            ],
            "configFiles": [
              { "id": "nginx-main", "path": "/etc/nginx/nginx.conf" }
            ]
          }
        }
      }
    }
  }
}
```

지원 검사는 다음 5개입니다.

- `inspect_web`: HTTPS GET과 일회성 PC·모바일 Playwright 렌더링으로 status,
  title, content hash, Console/Page error, 실패한 Network 응답 확인
- `inspect_service_status`: allowlist systemd unit의 상태 확인
- `inspect_recent_logs`: allowlist journal/file의 최근 80줄을 PII 제거 후 확인
- `inspect_config_shape`: 설정 원문 대신 key/directive 구조와 SHA-256만 확인
- `compare_environments`: development와 production의 설정 구조·hash 비교

보안 경계:

- Reviewer는 SSH 비밀번호·키, 임의 URL·경로·명령을 받거나 제출하지 않습니다.
- HTTPS, origin/path allowlist, DNS 재검증, private/loopback/metadata IP 차단,
  redirect·응답 크기·timeout 제한을 적용합니다.
- `allowedOrigins`는 렌더링에 필요한 CDN origin만 추가합니다. 각 origin도 DNS와
  private address 검사를 통과하며 main navigation에는 사용할 수 없습니다.
- private CIDR은 `allowedPrivateCidrs`에 명시된 범위만 예외로 허용합니다.
- 원격 파일은 절대경로와 `allowedRoots`를 모두 만족해야 하며 symlink의 실제
  경로도 서버에서 다시 검사합니다.
- traversal, glob, `.env`, key/pem, credential/secret 경로는 거부합니다.
- 설정 원문은 host에서 구조/hash로 변환된 뒤 Reviewer에게 전달됩니다.
- 파일 변경, service restart/reload, 배포·rollback, DB write, POST 요청은
  지원하지 않습니다.
- Playwright 검사는 screenshot이나 페이지 본문을 저장하지 않고 종료 시 browser
  context를 폐기합니다. 외부 origin과 POST 요청은 route 단계에서 차단합니다.
- 모든 요청은 room, task, role, environment, check, 성공 여부와 함께 host
  로그에 감사 기록을 남깁니다. 로그 본문과 자격증명은 감사 필드에 넣지 않습니다.

## 인증

```bash
# Claude Code OAuth
CLAUDE_CODE_OAUTH_TOKENS=
CLAUDE_CODE_OAUTH_TOKEN=

# Claude host env (선택)
ANTHROPIC_API_KEY=
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_BASE_URL=
```

설명:

- `CLAUDE_CODE_OAUTH_TOKENS`: canonical, 쉼표 구분
- `CLAUDE_CODE_OAUTH_TOKEN`: 단일 토큰 legacy fallback
- 실제 runner에는 현재 선택된 Claude 토큰 하나만 주입됩니다

Codex 쪽은 현재 **OAuth 세션 파일** 기준으로 동작합니다. `OPENAI_API_KEY`를 Codex child process에 넘겨서 빌링하는 구조는 사용하지 않습니다.

## 음성 전사

```bash
GROQ_API_KEY=
OPENAI_API_KEY=
```

- 기본은 Groq Whisper
- `GROQ_API_KEY`가 없으면 `OPENAI_API_KEY`로 OpenAI Whisper를 사용합니다
- `OPENAI_API_KEY`는 음성 전사 fallback 용도이며 Codex child process에는
  전달되지 않습니다

## 웹 대시보드

```bash
WEB_DASHBOARD_ENABLED=false
WEB_DASHBOARD_HOST=127.0.0.1
WEB_DASHBOARD_PORT=8734
WEB_DASHBOARD_TOKEN=
```

- 기본값은 비활성화, `127.0.0.1:8734`입니다
- localhost의 GET 조회는 token 없이 사용할 수 있습니다
- 메시지 전송, 설정 변경, 서비스 재시작 같은 mutating API에는
  `WEB_DASHBOARD_TOKEN`이 반드시 필요합니다
- private / tailnet bind는 token 없이 시작할 수 있지만 network-level trust에
  의존하므로 token 설정을 권장합니다
- public host bind는 `WEB_DASHBOARD_TOKEN`이 없으면 시작을 거부합니다
- 외부 접근은 Tailscale, VPN, SSH tunnel 또는 HTTPS reverse proxy 뒤에서
  운영합니다

## MoA

```bash
MOA_ENABLED=true
MOA_REF_MODELS=kimi,glm

MOA_KIMI_MODEL=kimi-k2.7
MOA_KIMI_BASE_URL=https://api.kimi.com/coding
MOA_KIMI_API_KEY=sk-kimi-xxx
MOA_KIMI_API_FORMAT=anthropic

MOA_GLM_MODEL=glm-5.2
MOA_GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
MOA_GLM_API_KEY=xxx
MOA_GLM_API_FORMAT=anthropic
```

MoA는 arbiter 판정 전에 외부 모델 의견을 수집해 prompt에 주입합니다.
대시보드 설정 화면에서 `MOA_ENABLED`, `MOA_REF_MODELS`, 모델명, base URL,
API format, API key 교체와 연결 테스트를 관리할 수 있습니다. 저장 후에는
스택 재시작이 필요합니다.

## 운영 / 배포 관련 설정

```bash
ASSISTANT_NAME=claude
STATUS_CHANNEL_ID=
SESSION_COMMAND_ALLOWED_SENDERS=
MAX_CONCURRENT_AGENTS=5
```

## Persistent Supervisor

```bash
HARD_TURN_TIMEOUT=7200000
PAIRED_MAX_EPISODE_ROUND_TRIPS=6
PAIRED_MAX_ARBITRATIONS=2
PAIRED_STAGNATION_THRESHOLD=2
PAIRED_RETRY_BASE_DELAY_MS=30000
PAIRED_RETRY_MAX_DELAY_MS=1800000
```

- `HARD_TURN_TIMEOUT`은 출력·tool activity와 무관한 turn 전체 벽시계 상한입니다.
- `AGENT_TIMEOUT`과 `IDLE_TIMEOUT`의 기존 activity 기반 의미는 유지됩니다.
- Episode limit은 현재 step의 왕복만 제한하고 Goal total counter는 유지합니다.
- retry/external/user/parked 상태에서는 runnable gate가 Agent 호출을 차단합니다.
- `PAIRED_MAX_ROUND_TRIPS`는 legacy 호환 입력이며 새 설정을 우선합니다.

## Discord 이미지 첨부 allowlist

```bash
RBCLAW_ATTACHMENT_ALLOWED_DIRS=~/Pictures/Screenshots,~/Downloads/rbclaw-images
```

- 콤마 또는 플랫폼 path delimiter(Linux는 `:`)로 여러 폴더를 지정합니다.
- 지정한 폴더 하위의 PNG/JPEG/GIF/WebP/BMP만 Discord 첨부 후보가 됩니다.
- `realpath`, 이미지 signature, size cap 검증은 그대로 적용됩니다.
- `/home/**` 전체보다 자주 쓰는 스크린샷/이미지 출력 폴더만 추가하는 것을 권장합니다.

- `ASSISTANT_NAME`은 owner trigger 기본 이름을 만듭니다
- paired room에서도 사용자 진입점은 owner가 기준입니다
- status dashboard와 session command는 선택 설정입니다

## 디버깅 경로

| 항목                   | 경로 / 명령                      |
| ---------------------- | -------------------------------- |
| DB                     | `store/messages.db`              |
| 서비스 로그            | `journalctl --user -u rbclaw -f` |
| room 로그              | `groups/{folder}/logs/`          |
| owner/reviewer 세션    | `data/sessions/{folder}*`        |
| channel project        | room 설정의 `work_dir`           |
| Claude 플랫폼 프롬프트 | `prompts/claude-platform.md`     |
| reviewer 프롬프트      | `prompts/claude-paired-room.md`  |
| arbiter 프롬프트       | `prompts/arbiter-paired-room.md` |
| Codex 플랫폼 프롬프트  | `prompts/codex-platform.md`      |
| 글로벌 메모리          | `groups/global/CLAUDE.md`        |

## 문서와 실제 코드의 우선순위

문서보다 실제 동작이 우선입니다. 동작 기준을 확인할 때는 아래를 먼저 봅니다.

1. `.env.example`
2. `src/config/load-config.ts`
3. `src/agent-runner-environment.ts`
4. `src/paired-execution-context.ts`
