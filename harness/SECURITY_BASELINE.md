# NanoClaw Security Baseline

## Container Security

### Mount Rules
- `mount-allowlist.json`: 프로젝트 디렉토리만 허용
- `.env` → `/dev/null`로 마운트 (시크릿 숨김)
- 비메인 그룹: 기본 read-only
- Session 격리: 각 그룹 별도 `.claude/` 디렉토리

### Blocked Patterns (mount-allowlist.json)
```json
{
  "blockedPatterns": [
    ".ssh", ".gnupg", ".gpg", ".aws", ".azure", ".kube",
    ".docker", ".env", ".netrc", ".npmrc",
    "id_rsa", "id_ed25519", "credentials", ".secret",
    "service_role"
  ]
}
```

### Resource Limits
- MAX_CONCURRENT_CONTAINERS: 3
- CONTAINER_TIMEOUT: 600000ms (10분)
- IDLE_TIMEOUT: 300000ms (5분)
- MAX_DAILY_RUNS: 50
- CONTAINER_MAX_OUTPUT_SIZE: 10MB

## Code Security (리뷰 시 체크)

### 절대 차단 패턴
- `sk_live_`, `sk_test_` (Stripe)
- `AKIA[0-9A-Z]{16}` (AWS)
- `eyJhbGciOi` (JWT)
- `ghp_`, `gho_`, `github_pat_` (GitHub)
- `-----BEGIN.*PRIVATE KEY`
- `service_role`, `SUPABASE_SERVICE_ROLE`
- DB URL with credentials: `postgres://user:pass@host`

### 리뷰 시 확인
- [ ] .env 파일 커밋 여부
- [ ] 코드에 하드코딩된 시크릿
- [ ] RLS 활성화 여부 (Supabase 프로젝트)
- [ ] 입력 검증 (Zod/Joi 등)
- [ ] 인증 확인 (미인증 엔드포인트 없는지)
- [ ] service_role은 서버 사이드에서만 사용

### 즉시 에스컬레이션 (반복 없이 @Ryan)
- 시크릿이 커밋에 포함
- RLS 비활성화 시도
- service_role이 클라이언트 코드에 노출
- 인증 없는 위험 엔드포인트 발견

## Git Security

- Protected branch (main/staging/develop) force push 금지
- .env, .env.local, .env.production 커밋 금지
- chmod 777 금지
- rm -rf / 또는 rm -rf * 금지

## Network Security (컨테이너)

- 외부 API 접근은 프로젝트별 설정
- 내부 서비스 직접 접근 불가
- DNS resolution은 허용 (npm install 등 필요)
