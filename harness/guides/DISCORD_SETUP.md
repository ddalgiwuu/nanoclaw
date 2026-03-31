# Discord Server & Bot Setup Guide

## Step 1: Discord Bot 생성

1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. **New Application** → 이름: `NanoClaw` (또는 원하는 이름)
3. **Bot** 탭:
   - **Reset Token** → 토큰 복사 (**한 번만 보임!**)
   - **Privileged Gateway Intents** 활성화:
     - [x] MESSAGE CONTENT
     - [x] SERVER MEMBERS
     - [x] PRESENCE
4. **OAuth2 > URL Generator**:
   - Scopes: `bot`
   - Bot Permissions:
     - Send Messages
     - Read Message History
     - Manage Threads
     - Create Public Threads
     - Add Reactions
     - Use External Emojis
   - 생성된 URL 복사 → 브라우저에서 열어 서버에 초대

## Step 2: Discord 서버 구조

"코딩 워크스페이스" (또는 프로젝트명) 서버 생성 후:

```
CONTROL
├── #control          — Tribunal 메인 그룹, 하트비트, 리포트
└── #alerts           — 보안 이슈, CI 실패, 에스컬레이션

DEVELOPMENT
├── #dev-tasks        — 태스크 할당, Owner↔Reviewer 루프
├── #code-review      — PR 자동 리뷰
└── #testing          — 테스트 실행/결과

LOGS
├── #git-activity     — GitHub 웹훅 피드
└── #session-log      — 세션 요약

HUMAN
└── #general          — Ryan 자유 채팅 (@NanoClaw 멘션 시만 응답)
```

## Step 3: 채널 권한 설정

### NanoClaw Bot 역할
- CONTROL/DEVELOPMENT/LOGS: 읽기/쓰기
- HUMAN: 멘션 시만 응답

### 채널별 보안
- `#control`, `#dev-tasks`: Ryan만 명령 가능 (sender-allowlist)
- `#code-review`, `#testing`: 자동 트리거 허용
- `#git-activity`, `#session-log`: 웹훅 전용 (읽기 전용)

## Step 4: GitHub 웹훅 연동

1. `#git-activity` 채널 설정 > 통합 > 웹훅 > 새 웹훅 생성
2. 웹훅 URL 복사
3. GitHub repo > Settings > Webhooks > Add webhook
   - Payload URL: `<Discord_Webhook_URL>/github`
   - Content type: `application/json`
   - Events: Pull requests, Pushes, Check runs, Check suites

## Step 5: 환경변수

NanoClaw `.env`에 추가:
```bash
DISCORD_BOT_TOKEN=<봇_토큰>
```

## Step 6: 채널 ID 확인

Discord 개발자 모드 활성화 (설정 > 고급 > 개발자 모드) 후
각 채널 우클릭 > ID 복사

`discord-config.json` 작성 시 필요:
```json
{
  "guild_id": "<서버_ID>",
  "channel_map": {
    "<control_channel_id>": "main-control",
    "<dev_channel_id>": "dev-tasks",
    "<review_channel_id>": "code-review",
    "<test_channel_id>": "testing"
  }
}
```

## Troubleshooting

| 문제 | 확인 |
|------|------|
| 봇 오프라인 | DISCORD_BOT_TOKEN 확인, Intents 활성화 확인 |
| 메시지 안 온 | MESSAGE CONTENT intent 활성화 확인 |
| 권한 오류 | 봇 역할이 채널 접근 권한 있는지 확인 |
| 웹훅 안 오는 | GitHub webhook deliveries 확인, URL에 `/github` 붙었는지 |
