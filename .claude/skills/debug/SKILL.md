---
name: debug
description: Debug RBClaw runtime issues on the current Discord-only, host-process architecture.
---

# RBClaw Debugging

현재 기준 RBClaw는 디스코드 전용이고, 에이전트는 컨테이너가 아니라 호스트 프로세스로 실행됩니다. 디버깅은 `채널`, `서비스`, `러너`, `DB 등록`, `자격 증명` 순서로 좁혀갑니다.

## 빠른 점검 순서

1. 타입과 테스트부터 확인
   ```bash
   bun run typecheck
   bun test
   ```
2. 서비스 상태 확인
   ```bash
   bun run setup -- --step verify
   ```
3. 런타임 로그 확인
   ```bash
   tail -f logs/rbclaw.log
   tail -f logs/rbclaw.error.log
   ls -t groups/*/logs/agent-*.log | head
   ```
4. 러너 빌드 확인
   ```bash
   bun run build:runners
   ```

## 핵심 파일

- `src/index.ts` - 메시지 루프, 세션 명령, 라우팅
- `src/channels/discord.ts` - 디스코드 수신/송신, 멘션, 첨부파일, 음성 전사
- `src/agent-runner.ts` - 러너 실행, 환경 변수 전달, 워크디렉터리 처리
- `runners/agent-runner/src/index.ts` - Claude Code / GLM Code 러너
- `runners/codex-runner/src/index.ts` - Codex 러너
- `src/db.ts` - 등록 그룹, 세션, 스케줄 저장
- `setup/register.ts` - 디스코드 채널 등록
- `setup/verify.ts` - 설치 상태 검증

## 자주 보는 문제

### 봇이 아예 말이 없음

```bash
bun run setup -- --step verify
```

- `DISCORD_OWNER_BOT_TOKEN`이 없으면 owner 채널이 붙지 않습니다.
- tribunal room에는 `DISCORD_REVIEWER_BOT_TOKEN`도 필요합니다.
- arbiter를 활성화했다면 `DISCORD_ARBITER_BOT_TOKEN`도 필요합니다.
- 세 봇의 Message Content Intent와 대상 채널 권한을 확인합니다.
- `ASSIGNED_ROOMS=0`이면 room 등록이 안 된 상태입니다.
- 토큰 값을 로그나 명령 출력으로 노출하지 말고 설정 여부만 확인합니다.

### 에이전트가 실행 직후 죽음

```bash
ls -t groups/*/logs/agent-*.log | head -3
```

- Claude Code 계열은 `CLAUDE_CODE_OAUTH_TOKENS`,
  `CLAUDE_CODE_OAUTH_TOKEN` 또는 `ANTHROPIC_API_KEY`가 필요합니다.
- Codex 계열은 서비스를 실행하는 OS 계정의 Codex CLI OAuth 세션을
  사용하며 `OPENAI_API_KEY`를 child process에 넘기지 않습니다.
- 러너 로그에 인증 실패나 CLI 실행 오류가 바로 찍힙니다.

### 음성 전사가 안 됨

```bash
tail -f logs/rbclaw.log | grep -iE 'transcri|audio|whisper|groq'
```

- 기본 우선순위는 Groq Whisper, 없으면 OpenAI Whisper fallback입니다.
- 키가 없으면 디스코드 채널은 음성 첨부를 텍스트로 확장하지 못합니다.
- 키 원문 대신 `.env`의 키 존재 여부만 확인합니다.

### 등록은 되어 있는데 응답이 이상함

```bash
sqlite3 store/messages.db \
  "select chat_jid, room_mode, folder, requires_trigger, is_main, owner_agent_type, work_dir from room_settings;"
```

- `chat_jid`는 `dc:<channel_id>` 형식이어야 합니다.
- `folder`는 `discord_main` 또는 `discord_<name>` 형태를 유지합니다.
- `work_dir`는 존재하는 절대경로여야 합니다. 누락되거나 유효하지 않으면
  다른 경로로 fallback하지 않고 실행을 차단합니다.
- 세션 명령 문제면 `src/session-commands.ts`와 `src/index.ts` 호출부를 같이 봅니다.

### 대시보드에서 조회는 되지만 명령이 실패함

```bash
grep -q '^WEB_DASHBOARD_TOKEN=.' .env \
  && echo 'WEB_DASHBOARD_TOKEN=set' \
  || echo 'WEB_DASHBOARD_TOKEN=missing'
```

- GET 조회는 localhost에서 토큰 없이 가능할 수 있지만 mutating API에는
  `WEB_DASHBOARD_TOKEN`이 필요합니다.
- 외부 장치에서는 Tailscale, VPN, SSH tunnel과 bearer token을 사용합니다.

## 원칙

- 채널 문제와 에이전트 문제를 섞지 말고 분리해서 봅니다.
- `.env`, DB 등록, 서비스, 러너 빌드 중 하나라도 틀리면 상위 증상이 비슷하게 보입니다.
- `.env`, 토큰, OAuth 파일의 원문을 출력하지 않고 존재·권한·해시만
  확인합니다.
- 컨테이너 전제 문서는 무시하고 `runners/*`와 `setup/*` 기준으로 확인합니다.
