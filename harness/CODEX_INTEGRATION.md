# Codex CLI Integration Guide

## Overview

NanoClaw 컨테이너 내에서 Codex CLI를 크로스 밸리데이션 도구로 사용.
Claude Code가 구현한 코드를 Codex가 독립적으로 평가.

## Prerequisites

- Codex CLI 설치: `npm install -g @openai/codex`
- OpenAI API key 설정 (컨테이너 환경변수)

## Usage Pattern

### 1. 코드 리뷰 요청

```bash
codex --approval-mode full-auto --quiet \
  "You are a code reviewer for a production application.

   ## Context
   Project: <project-name>
   Branch: <branch-name>
   Changed files:
   <file_list_with_diffs>

   ## Eval Rubric
   Score each criterion 1-10. Fail if any below threshold.
   - Functionality (threshold: <N>): Requirements met? Edge cases?
   - Code Quality (threshold: <N>): Conventions? Readability? Duplication?
   - Security (threshold: <N>): Secrets? Input validation? Auth?

   ## Output (JSON only)
   {
     \"scores\": {\"functionality\": N, \"code_quality\": N, \"security\": N},
     \"pass\": true/false,
     \"feedback\": [\"actionable item with file:line references\"],
     \"issues\": [{\"file\": \"path\", \"line\": N, \"issue\": \"description\"}]
   }"
```

### 2. 아키텍처 리뷰

```bash
codex --approval-mode full-auto --quiet \
  "Review the architecture of these changes.
   Focus on: dependency direction, separation of concerns, scalability.
   Project structure: <tree output>
   Changes: <summary>
   Output JSON with recommendations."
```

### 3. 테스트 검증

```bash
codex --approval-mode full-auto --quiet \
  "Review test coverage for these changes.
   Source files: <list>
   Test files: <list>
   Check: edge cases covered? Mocking appropriate? Assertions meaningful?
   Output JSON with gaps found."
```

## Handling Codex Output

1. Parse JSON response
2. If `pass: true` → 통과, @Ryan 승인 요청으로 진행
3. If `pass: false` → 피드백을 Claude Code에 전달
4. If JSON 파싱 실패 → 재시도 1회, 재실패 시 @Ryan 에스컬레이션

## Cost Control

- Codex 리뷰는 iteration당 1회만 (중복 호출 금지)
- 전체 파일 대신 diff 위주로 컨텍스트 제공
- 리뷰 크기 제한: diff 500줄 초과 시 파일별 분리 리뷰

## Fallback

Codex CLI 사용 불가 시 (API 오류, 한도 초과):
1. Claude Code가 self-review (차선책이지만 무리뷰보다 나음)
2. @Ryan에게 "Codex 사용 불가, 수동 리뷰 필요" 멘션
3. 실패 레지스트리에 기록
