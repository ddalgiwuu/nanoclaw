# Discord Adapter Development Guide

NanoClaw에 Discord 채널 어댑터를 추가하는 개발 가이드.

## Prerequisites

- Discord 봇 토큰 준비 (DISCORD_SETUP.md 참조)
- NanoClaw 개발 환경 동작 중

## Step 1: 의존성 설치

```bash
npm install discord.js@^14
```

## Step 2: Channel 인터페이스 이해

NanoClaw의 모든 채널은 `src/types.ts`의 `Channel` 인터페이스를 구현:

```typescript
interface Channel {
  name: string;                                    // 'discord'
  connect(): Promise<void>;                        // 로그인
  sendMessage(jid: string, text: string): Promise<void>;  // 메시지 전송
  isConnected(): boolean;                          // 연결 상태
  ownsJid(jid: string): boolean;                   // JID 소유 확인
  disconnect(): Promise<void>;                     // 연결 해제
  setTyping?(jid: string, isTyping: boolean): Promise<void>;  // 타이핑 표시
  syncGroups?(force: boolean): Promise<void>;      // 그룹 동기화
}
```

채널 팩토리는 `ChannelOpts`를 받음:

```typescript
interface ChannelOpts {
  onMessage: OnInboundMessage;      // 인바운드 메시지 콜백
  onChatMetadata: OnChatMetadata;   // 채팅 메타데이터 콜백
  registeredGroups: () => Record<string, RegisteredGroup>;  // 등록된 그룹 조회
}
```

## Step 3: `src/channels/discord.ts` 구현

```typescript
import { Client, GatewayIntentBits, TextChannel, Message } from 'discord.js';
import { registerChannel, type ChannelOpts } from './registry.js';
import { type Channel, type NewMessage } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;

// 토큰 없으면 등록만 하고 null 반환 (선택적 채널)
registerChannel('discord', (opts: ChannelOpts): Channel | null => {
  if (!DISCORD_TOKEN) {
    logger.info('Discord: DISCORD_BOT_TOKEN not set, skipping');
    return null;
  }
  return new DiscordChannel(opts);
});

class DiscordChannel implements Channel {
  name = 'discord';
  private client: Client;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async connect(): Promise<void> {
    // 메시지 수신 핸들러
    this.client.on('messageCreate', (msg: Message) => {
      // 봇 자신의 메시지 무시
      if (msg.author.bot) return;

      const jid = this.messageToJid(msg);
      const newMsg: NewMessage = {
        id: msg.id,
        chat_jid: jid,
        sender: msg.author.id,
        sender_name: msg.author.displayName || msg.author.username,
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        is_from_me: false,
      };

      // 채팅 메타데이터 전달
      const channelName = (msg.channel as TextChannel).name || 'unknown';
      this.opts.onChatMetadata(
        jid,
        msg.createdAt.toISOString(),
        channelName,
        'discord',
        !msg.channel.isDMBased(),
      );

      // 메시지 전달
      this.opts.onMessage(jid, newMsg);
    });

    this.client.on('ready', () => {
      logger.info(`Discord: logged in as ${this.client.user?.tag}`);
    });

    await this.client.login(DISCORD_TOKEN);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = this.jidToChannelId(jid);
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      // Discord 2000자 제한 — 분할 전송
      const chunks = this.splitMessage(text, 2000);
      for (const chunk of chunks) {
        await (channel as TextChannel).send(chunk);
      }
    }
  }

  isConnected(): boolean {
    return this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('discord:');
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  async setTyping(jid: string): Promise<void> {
    const channelId = this.jidToChannelId(jid);
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).sendTyping();
    }
  }

  async syncGroups(): Promise<void> {
    // Discord 채널 목록을 그룹으로 동기화 (필요시 구현)
  }

  // --- Private helpers ---

  private messageToJid(msg: Message): string {
    // 스레드면 스레드 ID 포함
    if (msg.channel.isThread()) {
      return `discord:${msg.channel.parentId}:thread:${msg.channel.id}`;
    }
    return `discord:${msg.channel.id}`;
  }

  private jidToChannelId(jid: string): string {
    // discord:<channel_id> 또는 discord:<channel_id>:thread:<thread_id>
    const parts = jid.replace('discord:', '').split(':thread:');
    return parts.length > 1 ? parts[1] : parts[0];
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      // 줄바꿈 기준 분할 (가능하면)
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }
}
```

## Step 4: `src/channels/index.ts` 업데이트

기존 `// discord` 주석을 import로 교체:

```typescript
// 변경 전
// discord

// 변경 후
import './discord.js';
```

## Step 5: 테스트

```bash
# 1. 빌드
npm run build

# 2. 실행 (테스트)
npm run dev

# 3. Discord 채널에서 메시지 전송
# NanoClaw 로그에서 'Discord: logged in as ...' 확인
# 메시지 수신 로그 확인
```

## Step 6: 그룹 등록

Discord `#control` 채널에서 NanoClaw에게 메시지:

```
그룹 등록:
- main-control → #control (메인 그룹, 트리거 불필요)
- dev-tasks → #dev-tasks (트리거: @nano)
- code-review → #code-review (트리거: @nano)
- testing → #testing (트리거: @nano)
```

## JID 매핑 규칙

| Discord 요소 | NanoClaw JID |
|-------------|-------------|
| 채널 | `discord:<channel_id>` |
| 스레드 | `discord:<parent_channel_id>:thread:<thread_id>` |
| DM | `discord:dm:<user_id>` |

## 주의사항

1. **Discord 2000자 제한** — 긴 메시지 자동 분할 필요
2. **Rate limit** — discord.js가 자동 처리하지만, 대량 전송 시 주의
3. **Intents** — MESSAGE_CONTENT 필수 (privileged intent)
4. **봇 자신 메시지 무시** — `msg.author.bot` 체크 필수 (무한 루프 방지)
5. **테스트 서버 권장** — 개발 중에는 테스트용 Discord 서버 사용
