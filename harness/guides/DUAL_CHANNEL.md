# Telegram + Discord 동시 운영 가이드

## Overview

하나의 NanoClaw 프로세스에서 두 채널을 동시 운영:

| 채널 | 용도 | JID Prefix |
|------|------|------------|
| **Telegram** | 일상, 크론잡, 빠른 질문, 알림 | `telegram:` |
| **Discord** | 코딩, Tribunal 루프, PR 리뷰, 테스트, GC | `discord:` |

## Architecture

```
NanoClaw (single process)
├── Telegram Channel (기존)
│   ├── 일상 그룹
│   ├── 크론잡 (리마인더, 모니터링)
│   └── 빠른 질답
│
└── Discord Channel (신규)
    ├── #control (Tribunal 메인)
    ├── #dev-tasks (Owner↔Reviewer 루프)
    ├── #code-review (PR 자동 리뷰)
    ├── #testing (테스트 실행/결과)
    ├── #git-activity (GitHub 웹훅)
    ├── #session-log (세션 요약)
    └── #general (Ryan 자유 채팅)
```

**공유 리소스**: SQLite DB, 컨테이너 풀, 파일시스템
**분리 리소스**: JID로 채널 구분, 그룹별 격리

## 채널별 그룹 분리

### Telegram 그룹 (기존 유지)
| 그룹 | 용도 |
|------|------|
| 기존 메인 그룹 | 일상 대화, 크론잡, 알림 |

### Discord 그룹 (신규)
| 그룹 | Discord 채널 | 역할 |
|------|-------------|------|
| `main-control` | #control | Tribunal 메인, 하트비트, 리포트 |
| `dev-tasks` | #dev-tasks | Owner↔Reviewer 코딩 루프 |
| `code-review` | #code-review | PR 자동 리뷰 |
| `testing` | #testing | 테스트 실행/결과 |

## .env 설정

```bash
# Telegram (기존)
TELEGRAM_BOT_TOKEN=<기존_텔레그램_토큰>

# Discord (신규 추가)
DISCORD_BOT_TOKEN=<디스코드_봇_토큰>
```

**둘 다 설정하면 NanoClaw가 자동으로 양쪽 채널 시작.**
하나만 설정하면 해당 채널만 시작. 기존 텔레그램은 영향 없음.

## sender-allowlist.json

`~/.config/nanoclaw/sender-allowlist.json`에 Discord 채널 추가:

```json
{
  "telegram:<기존_그룹_id>": {
    "allow": "*",
    "mode": "trigger"
  },
  "discord:<control_channel_id>": {
    "allow": ["<ryan_discord_user_id>"],
    "mode": "trigger"
  },
  "discord:<dev_channel_id>": {
    "allow": ["<ryan_discord_user_id>"],
    "mode": "trigger"
  },
  "discord:<review_channel_id>": {
    "allow": "*",
    "mode": "trigger"
  },
  "discord:<test_channel_id>": {
    "allow": "*",
    "mode": "trigger"
  }
}
```

## Tribunal은 Discord에서만

Tribunal 루프 (Owner↔Reviewer↔Arbiter)는 Discord `#dev-tasks` 채널에서만 동작.
Telegram은 Tribunal 루프를 트리거하지 않음.

## @Ryan 멘션 채널

| 우선순위 | 채널 |
|---------|------|
| 긴급 (보안) | Telegram DM + Discord #alerts |
| 높음 (ESCALATE) | Discord #control + Telegram |
| 일반 (작업 완료) | Discord #control |
| 낮음 (리포트) | Discord #session-log |

긴급 알림은 **양쪽 모두** 전송하여 확실히 전달.

## 확인 체크리스트

설정 후 확인:

- [ ] NanoClaw 시작 시 로그에 "Telegram: connected" + "Discord: logged in" 둘 다 표시
- [ ] Telegram에 메시지 → NanoClaw 응답 (기존과 동일)
- [ ] Discord #control에 메시지 → NanoClaw 응답
- [ ] Discord #code-review에 @nano → NanoClaw 응답
- [ ] 하트비트가 Discord #control에 포스트되는지
- [ ] Telegram과 Discord의 그룹이 독립적으로 동작하는지
