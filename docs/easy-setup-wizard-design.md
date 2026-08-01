# RBClaw 간편 설치 Wizard 설계

## 상태

이 문서는 구현 전 설계안입니다. 현재 설치 명령은 그대로 유지되며, README는
현재 사용할 수 있는 수동 설치 절차만 안내합니다.

## 문제 정의

현재 설치는 각 단계가 분리되어 있어 숙련자는 실패 지점을 좁히기 쉽지만,
초보자는 다음 상태를 직접 연결해야 합니다.

1. Node.js, Bun, Linux sandbox 도구 설치
2. Codex와 Claude Code CLI 설치 및 OS 사용자별 로그인
3. Discord 애플리케이션, intent, 권한, 토큰 설정
4. `.env` 생성과 역할별 provider 선택
5. runner 빌드, 최초 room 등록, 서비스 설치, 최종 검증

현재 코드에서 확인된 주요 마찰 지점은 다음과 같습니다.

- `setup.sh`는 Bun을 자동 설치하지 않고 존재 여부만 확인합니다.
- bootstrap 이후 사용자가 여러 `--step` 명령을 정확한 순서로 실행해야 합니다.
- Discord 토큰과 provider 인증의 필요 조건이 room mode에 따라 달라집니다.
- 인증 검증이 실제 로그인 가능 여부보다 환경 변수 형태에 의존하는 부분이
  있어 false positive가 가능합니다.
- 최초 `register`는 `single` room을 만들지만, Tribunal 확장 시점과 방법이
  설치 흐름에서 충분히 분리되어 있지 않습니다.
- Ubuntu AppArmor가 unprivileged user namespace를 제한하면 Reviewer sandbox가
  fail-closed되지만, 현재는 privilege를 분리한 복구 step이 없습니다.
- 오류 출력은 기계 판독에는 적합하지만 초보자가 실행할 다음 명령을 항상
  제공하지는 않습니다.

## 목표

- fresh clone에서 첫 Discord Owner 응답까지 하나의 안내 흐름으로 완료합니다.
- `single`, `tribunal`, `custom` 설치를 명시적인 preset으로 구분합니다.
- 현재 상태를 매번 다시 탐지해 중단된 설치를 안전하게 재개합니다.
- 토큰과 OAuth 자격 증명을 로그, argv, shell history에 노출하지 않습니다.
- 기존 setup step과 canonical room assignment를 재사용합니다.
- 자동화할 수 없는 Discord Portal 작업은 정확한 체크리스트와 검증으로
  보조합니다.

## 비목표

- Discord 애플리케이션을 사용자 대신 자동 생성하지 않습니다.
- `sudo` 암호를 받거나 무단으로 시스템 패키지를 설치하지 않습니다.
- OAuth 비밀번호나 장기 토큰을 RBClaw 전용 DB에 복제하지 않습니다.
- 첫 MVP에서 웹 대시보드, 모바일 앱, MoA까지 설정하지 않습니다.
- 기존 고급 `.env` 옵션을 wizard 질문으로 전부 노출하지 않습니다.

## 사용자 진입점

기존 동작을 보존하면서 opt-in으로 시작합니다.

```bash
bash setup.sh --wizard
```

`setup.sh`가 Bun과 의존성을 준비한 뒤 다음 명령으로 넘깁니다.

```bash
bun run setup -- --step wizard
```

진단만 다시 실행하는 별도 진입점도 제공합니다.

```bash
bun run setup -- --step doctor
```

## 설치 preset

| Preset     | Discord 봇              | 기본 역할                    | 용도                    |
| ---------- | ----------------------- | ---------------------------- | ----------------------- |
| `single`   | Owner 1개               | Owner Codex                  | 가장 빠른 첫 실행       |
| `tribunal` | Owner 1개, Reviewer 1개 | Owner Codex, Reviewer Claude | 권장 검증 구성          |
| `custom`   | 선택                    | 역할별 provider 직접 선택    | 기존 운영자와 고급 설정 |

Arbiter는 첫 설치 성공 후 추가하는 것을 기본으로 합니다. `custom`에서는 처음부터
활성화할 수 있습니다.

## Wizard 흐름

### 1. Preflight

변경 없이 다음 항목을 검사합니다.

- OS와 service manager
- Node.js와 Bun 최소 버전
- Git, build tool, `bwrap`, `socat`, `unshare`
- AppArmor user namespace 상태
- 현재 Git checkout과 writable project root
- 기존 `.env`, room, service, credential 상태

각 실패는 원인과 다음 명령을 함께 출력합니다.

```text
[FAIL] Bun 1.3+ not found
Fix: curl -fsSL https://bun.com/install | bash
Then: open a new shell and rerun bash setup.sh --wizard
```

시스템 변경이 필요한 항목은 실행 전에 명령을 보여주고 사용자 승인을
받습니다. 기본값은 자동 실행이 아니라 안내입니다.

전체 wizard를 root로 다시 실행하도록 안내하면 안 됩니다. sandbox 정책 변경이
필요하면 별도의 좁은 privileged helper가 변경 파일과 sysctl 값을 미리 보여주고,
그 helper만 명시적으로 승인받아 실행합니다.

### 2. Preset 선택

처음에는 세 가지 질문만 합니다.

1. Owner만 먼저 실행할지 Tribunal까지 구성할지
2. Owner provider를 Codex, Claude Code, GLM Code 중 무엇으로 할지
3. 설치할 Discord 제어 채널 ID와 작업 폴더

모델, effort, MoA, dashboard는 기본값을 사용하고 설치 후 설정 문서로
안내합니다.

### 3. Provider 인증

선택한 역할에 필요한 provider만 검사합니다.

- Codex: `codex login status`와 최소 비변경 probe
- Claude Code: `claude auth status`와 최소 비변경 probe
- API token 방식: 환경 변수 존재가 아니라 실제 provider 응답으로 검증

로그인이 없으면 공식 CLI 로그인 명령을 자식 프로세스로 실행합니다. headless
서버에서는 일회성 공식 URL을 보여주고 브라우저 승인을 기다립니다. 비밀번호,
OAuth code, access token은 setup 로그에 기록하지 않습니다.

현재 `verify`의 credential 판정도 역할별 실제 요구사항을 사용하도록 바꿉니다.
예를 들어 Codex Owner만 있는 `single` room은 Claude credential 때문에 실패하면
안 됩니다.

### 4. Discord 안내와 검증

Discord Portal 작업은 자동화하지 않고 역할별 체크리스트를 한 화면씩
제공합니다.

- bot token 발급
- Message Content Intent 활성화
- 필요한 channel permission 선택
- 서버 초대
- 개발자 모드에서 channel ID 복사

토큰은 no-echo 입력으로 받고 argv에 넣지 않습니다. Discord API 검증 결과는
봇 이름, bot ID, 대상 channel 접근 가능 여부만 표시하고 토큰은 redaction합니다.

검증할 항목:

- 토큰이 실제 bot token인지
- Owner, Reviewer, Arbiter 토큰이 서로 다른 봇인지
- 대상 channel을 조회할 수 있는지
- 메시지를 보내고 기록을 읽을 권한이 있는지
- Gateway 연결 시 Message Content Intent 오류가 발생하지 않는지

### 5. 설정 반영

`.env.example`을 기준으로 기존 `.env`의 알 수 없는 키와 주석을 보존합니다.

1. 변경 예정값을 redacted diff로 표시
2. 동일 디렉터리에 임시 파일 작성
3. 문법과 필수값 검증
4. 원자적으로 rename
5. 권한을 `0600`으로 설정

기존 `.env`가 있으면 timestamp가 붙은 로컬 백업을 만들되, 백업 경로와 보존
정책을 사용자에게 명시합니다. 백업 파일도 `0600`을 유지하고 Git에서
제외합니다.

### 6. Room 등록

기존 `assignRoom` application service를 호출합니다. SQL을 직접 작성하지
않습니다.

- `single`: main room을 Owner 전용으로 등록
- `tribunal`: main room 또는 선택한 개발 room을 Tribunal로 등록
- `workDir`: `realpath`, 존재 여부, Git 상태를 확인한 뒤 저장

등록 전에 최종 요약을 보여줍니다.

```text
Room: dc:123456789012345678
Mode: tribunal
WorkDir: /home/user/projects/example
Owner: codex
Reviewer: claude-code
```

### 7. Build, service, smoke test

기존 step을 순서대로 재사용합니다.

1. `runners`
2. `service`
3. `verify`
4. Discord Gateway 연결 확인
5. 선택적 first-response smoke test

Wizard가 임의 source build 명령을 복제하지 않도록 각 setup module을 함수로
호출합니다. 성공 시 다음 정보를 출력합니다.

- 서비스 상태
- 등록된 room과 mode
- 역할별 bot 연결 상태
- 역할별 provider 인증 상태
- Discord에서 보낼 첫 메시지
- 로그와 재실행 명령

## 재실행과 복구

별도의 "설치 완료" boolean을 신뢰하지 않습니다. 각 실행에서 실제 상태를
다시 probe하고 완료된 단계는 건너뜁니다.

```text
[OK] Dependencies installed
[OK] Codex authenticated
[OK] Owner bot can access channel
[SKIP] Main room already registered with the same values
[FIX] rbclaw.service installed but stopped
```

등록값이 다르면 자동 덮어쓰지 않고 old/new diff와 선택지를 표시합니다.
서비스 설치 전 실패하면 서비스를 건드리지 않습니다. 서비스 설치 후 smoke
test가 실패하면 기존 설정을 자동 삭제하지 않고 상태와 복구 명령을 남깁니다.

## 보안 경계

- secret은 stdin 또는 no-echo prompt로만 입력합니다.
- secret을 CLI 인자, process title, setup log, telemetry에 넣지 않습니다.
- 출력 redaction은 token prefix뿐 아니라 입력 전체값의 exact match를
  기준으로 적용합니다.
- `.env`와 백업 파일은 `0600`입니다.
- auth probe는 최소 요청만 수행하고 응답 본문을 저장하지 않습니다.
- Discord와 provider 로그인 URL은 공식 origin allowlist를 검사합니다.
- root 작업, service restart, 기존 room 변경은 실행 전에 별도 확인합니다.

## 코드 구조

```text
setup/
  wizard.ts                 # 상태 머신과 화면 흐름
  doctor.ts                 # read-only preflight와 fix 안내
  sandbox-doctor.ts         # namespace probe와 privilege 분리 안내
  provider-auth.ts          # 역할별 auth probe
  discord-onboarding.ts     # bot/channel 검증
  env-editor.ts             # redacted, atomic .env update
  smoke-test.ts             # service/Gateway/first-response 확인
```

기존 `environment.ts`, `runners.ts`, `register.ts`, `service.ts`, `verify.ts`는
재사용 가능한 함수와 CLI adapter로 분리합니다. Wizard가 subprocess의 텍스트
출력을 다시 파싱하지 않고 typed result를 직접 받게 합니다.

## MVP 범위

첫 구현에서 반드시 닫을 구멍은 다음 하나입니다.

> 사용자가 fresh clone에서 필요한 역할만 선택하고, 누락된 준비물과 인증을
> 안내받으며, 첫 Discord 응답까지 중단 후 재개 가능한 한 흐름으로 완료한다.

MVP 포함:

- `single`과 `tribunal` preset
- read-only doctor
- Reviewer sandbox capability 검사와 fail-closed 안내
- 역할별 provider auth probe
- Discord token과 channel 접근 검증
- atomic `.env` 작성
- canonical room 등록
- 기존 build/service/verify 호출
- redacted 결과와 재개

MVP 제외:

- 웹 기반 설치 화면
- QR code와 모바일 onboarding
- Discord 애플리케이션 자동 생성
- dashboard, MoA, voice companion 설정
- 자동 OS package 설치
- 원격 서버 fleet 배포

## 후속 단계

### Phase 2: 로컬 웹 Onboarding

`127.0.0.1`에 일회성 setup UI를 열고 SSH tunnel이나 Tailscale을 통해 폰에서
접속합니다. CLI wizard와 같은 typed setup service를 사용하며 별도 설치
로직을 만들지 않습니다.

### Phase 3: 비대화형 설치

secret 값 대신 환경 변수 이름이나 secret file reference만 담는 YAML을
지원합니다.

```yaml
preset: tribunal
work_dir: /home/user/projects/example
discord:
  owner_token_env: DISCORD_OWNER_BOT_TOKEN
  reviewer_token_env: DISCORD_REVIEWER_BOT_TOKEN
room:
  jid: dc:123456789012345678
```

### Phase 4: 업데이트와 복구

설치 wizard와 별도로 backup, migration preview, deploy, health check, revert
안내를 묶은 upgrade command를 제공합니다. 신규 설치와 운영 배포의 권한 및
실패 경계를 섞지 않습니다.

## 완료 기준

- Ubuntu fresh VM에서 문서 확인을 제외한 터미널 명령은 두 개 이내입니다.
- `single` preset은 Owner bot과 하나의 provider만으로 성공합니다.
- `tribunal` preset은 Owner와 Reviewer 실제 응답을 각각 smoke test합니다.
- 잘못된 token, intent, channel ID, provider login을 해당 단계에서 탐지합니다.
- 중간 종료 후 재실행하면 완료 단계를 안전하게 재사용합니다.
- 반복 실행해도 room, service, `.env`에 중복 항목이 생기지 않습니다.
- setup log와 프로세스 목록에 secret이 노출되지 않습니다.
- 기존 수동 setup step과 배포 경로의 회귀 테스트가 모두 통과합니다.
