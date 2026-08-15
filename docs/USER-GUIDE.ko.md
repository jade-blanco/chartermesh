# CharterMesh 사용자 설명서

이 문서는 CharterMesh를 처음 접하는 사용자가 설치, 모델 연결, 작업 실행,
검토, 백업까지 한 흐름으로 사용할 수 있도록 설명하는 한국어 안내서입니다.

CharterMesh는 특정 LLM 공급자나 코딩 에이전트에 종속되지 않는 로컬 우선
작업 제어면입니다. 작업과 실행 상태는 Codex, Claude, Gemini 또는 모델
대화창이 아니라 프로젝트의 `.chartermesh` Control Plane에 기록됩니다.

> 현재 버전은 pre-alpha입니다. 실제 배포·금전 결제·중요 데이터 변경을
> 무인으로 맡기는 용도가 아니라, 사람이 계획과 변경 내용을 검토하는
> 로컬 작업 환경으로 사용하세요.
> `human:*` 표시는 Control Plane 정책상의 사람 역할이며, CLI나 SQLite에
> 직접 접근할 수 있는 로컬 프로세스에 대해 사람임을 암호학적으로 증명하지는
> 않습니다. 승인 세션은 코딩 에이전트와 분리해서 관리하세요.

## 1. CharterMesh가 하는 일

기본 흐름은 다음과 같습니다.

```text
프로젝트 검사
  → 조직·런타임 계획 생성
  → 사람이 정확한 계획 해시 승인
  → 프로젝트에 CharterMesh 적용
  → 작업 생성·담당 지정
  → LLM 또는 로컬 엔진 실행
  → 사람이 산출물 검토
  → 완료 또는 수정 요청
```

CharterMesh가 관리하는 것:

- 조직 역할과 작업 흐름
- WorkItem, Run, Attempt, Lease 상태
- 모델 실행 기록과 비용 상태
- 산출물과 SHA-256
- 사람의 산출물·도구 승인
- 실패, 취소, 대기, 재시도 이력
- 감사 내보내기와 Control Plane 백업

CharterMesh가 자동으로 제공하지 않는 것:

- LLM 계정, API 키 또는 유료 모델 이용권
- Ollama, llama.cpp, LM Studio 같은 모델 서버 설치
- 클라우드 배포나 운영 서버
- Git 저장소 자체의 백업
- 셸, 패키지 설치, 배포 권한

## 2. 가장 쉬운 시작: 코딩 에이전트에게 맡기기

Codex, Claude Code, Gemini CLI 또는 다른 코딩 에이전트에게 저장소 주소와
대상 프로젝트를 알려주고 다음처럼 요청할 수 있습니다.

```text
https://github.com/jade-blanco/chartermesh

이 프로젝트에 CharterMesh를 적용해줘.
먼저 읽기 전용으로 검사하고 정확한 적용 계획과 plan hash를 보여줘.
내가 그 hash를 승인하기 전에는 파일을 변경하지 마.
```

에이전트는 `BOOTSTRAP.md`를 읽고 저장소 CLI를 사용해야 합니다. 정상적인
에이전트의 진행 순서는 다음과 같습니다.

1. 대상 프로젝트를 읽기 전용으로 검사합니다.
2. `propose`와 `bootstrap` 미리보기를 실행합니다.
3. 변경 파일, 기존·예정 해시와 `planHash`를 보여줍니다.
4. 사용자가 그 해시를 명시적으로 승인할 때까지 멈춥니다.
5. 동일한 명령에 `--approve PLAN_HASH`를 붙여 적용합니다.
6. `doctor`로 설치 상태를 검증합니다.

일반적인 “적용해줘” 요청은 검사와 계획 생성까지 허용할 뿐, 아직 만들어지지
않은 계획의 쓰기 승인은 아닙니다.

### 2.1 완전히 새 프로젝트 폴더에서 시작하기

빈 폴더라면 요구사항을 짧은 브리프 파일로 만든 뒤 `bootstrap` 대신
`kickoff`를 사용합니다. 이 명령은 설치 파일뿐 아니라 프로젝트 브리프와
첫 번째 작업, 수락 기준까지 하나의 계획 해시에 묶습니다.

```powershell
$CM = "github:jade-blanco/chartermesh#v0.0.9-alpha.1"
$Target = "C:\path\to\new-project"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
npx --yes $CM kickoff `
  --target $Target `
  --brief-file C:\path\to\project-brief.md `
  --profile controlled `
  --engine fake `
  --json
```

미리보기는 대상 폴더에 쓰지 않습니다. 출력된 해시를 검토한 다음 모든
옵션을 그대로 반복하고 `--approve PLAN_HASH`를 붙입니다. 적용되면
`.chartermesh/PROJECT-BRIEF.md`와 첫 `operator` WorkItem이 함께 생성됩니다.
승인된 설치에는 `web-research`, `repository-diagnostics`,
`small-model-evidence`, `tool-grounded-implementation`, `integration-review`
등 5개의 Apache-2.0 공급자 중립 Agent Skill도 포함됩니다.

Codex나 Claude Code 세션에서 팀 역할을 사용하려면 설치 뒤 먼저 모델 호출이
없는 호스트 검사를 실행합니다.

```powershell
npx --yes $CM host doctor `
  --host codex --target $Target --json

npx --yes $CM configure-host `
  --host codex --target $Target `
  --allow-unrestricted-read --max-agents 4 --json
```

두 번째 명령도 별도 계획이므로 정확한 해시를 다시 승인해야 합니다.
`--host claude`를 사용하면 Claude Code용 역할과 MCP 설정을 만듭니다. 두
호스트 모두 같은 로컬 Control Plane을 사용하며, MCP에는 사람 승인 권한이
없습니다. 투영 전용 `host doctor`는 실행 파일과 CharterMesh가 선언한 호환성
hash를 보고할 뿐 각 기능을 실시간 탐지하거나 Codex app-server를 시작하지
않습니다. 직접 실행 프로토콜까지 검사할 때만 `host doctor --direct`를 사용합니다.

호스트 계획을 승인·적용한 뒤에는 기존 세션을 닫고 프로젝트 루트에서 새
Codex 또는 Claude Code 세션을 시작합니다. Codex에서는 프로젝트를 신뢰해
`.codex/config.toml`을 읽게 하고, Claude Code에서는 프로젝트 MCP를 한 번
승인한 뒤 `/mcp`로 확인합니다. `chartermesh_status`와
`chartermesh_work_next`가 보여야 합니다. 이 투영 후 상태 확인은 필수이며,
기존 세션의 역할·MCP 자동 재로딩은 가정하지 않습니다.

투영된 역할 파일은 네이티브 셸·쓰기 도구를 기본 차단하지만 부모 호스트 세션이
하위 권한을 덮어쓸 수 있습니다. 부모 세션도 네이티브 쓰기·셸 권한 없이
시작하고 이를 OS 보안경계가 아닌 pre-alpha 절차적 경계로 취급하세요. 구현 변경은 여러 파일의
경로, 승인 전 hash(또는 파일 없음), 승인 후 전체 내용을 하나의 제한된
change set으로 MCP에 요청합니다. 사람은 한 Decision Packet만 검토해
`approve-tool`로 승인하고, 새 claim이 저장된 정확한 바이트만 복구 가능한
트랜잭션으로 적용한 뒤 증거를 기록합니다.

현재 한 프로젝트 MCP bridge가 허용된 OrgSpec 역할 집합을 함께 제공합니다.
각 투영 역할은 자기 `ownerRole` 작업만 claim하도록 지시되지만, 공유 bridge는
호출한 네이티브 하위 에이전트의 신원을 인증하지 못합니다. 따라서 역할 간
분리는 이 alpha에서 절차적 경계이며, 공통 세션·run·lease fence는 계속 강제됩니다.

현재 직접 `chartermesh run` 실행 대상이 될 수 있는 호스트는 Codex
app-server뿐입니다. 원할 때만 계획과 승인 명령 양쪽에
`--activate-role operator`를 추가하세요. 이미 Codex 투영 계획에 포함된
`--allow-unrestricted-read`는 읽기 전용 샌드박스가 프로젝트 밖 읽기까지
제한하지는 않는다는 사실에 대한 명시적 확인입니다. 이 경로는 사용자 Codex 사용량을
소비할 수 있습니다. Claude Code는 현재 프로젝트 역할과 MCP 연동까지만
지원하며 직접 AgentHost 실행을 지원한다고 간주하면 안 됩니다.

## 3. 직접 설치하기

### 3.1 준비 사항

- Node.js 24 이상
- GitHub `npx` 경로로 설치할 때 Git 2.x
- GitHub 패키지를 받을 수 있는 네트워크
- CharterMesh를 적용할 프로젝트 경로

소스 개발과 전체 검증에는 pnpm 11이 추가로 필요하지만, 설치된
CharterMesh의 런타임에는 별도 npm 의존성이 없습니다. GitHub `npx` 방식은
의존성 없는 `prepare` 빌드를 위해 npm lifecycle script가 켜져 있어야 합니다.
조직 정책으로 `ignore-scripts`를 강제한다면 검토된 사전 빌드 패키지나 소스
체크아웃을 사용해야 합니다.

아래 예시는 PowerShell을 기준으로 합니다.

```powershell
$CM = "github:jade-blanco/chartermesh#v0.0.9-alpha.1"
$Target = "C:\path\to\your-project"
```

이 태그는 친구 시험용 버전을 선택하지만 Git 태그 자체는 이동할 수 있으며
특정 commit을 암호학적으로 증명하지 않습니다. 더 강한 공급망 경계가 필요하면
검토한 로컬 설치나 commit SHA로 고정한 배포물을 사용하세요.

### 3.2 소스 체크아웃 없이 실행

```powershell
npx --yes $CM version --json
npx --yes $CM propose `
  --target $Target `
  --profile balanced
```

다운로드 없이 이미 체크아웃한 CharterMesh 소스에서 실행하려면 이후 예제의
명령 앞부분을 다음과 같이 바꿉니다.

```powershell
node bin/chartermesh.mjs propose --target $Target --profile balanced
```

### 3.3 조직 프로필 선택

| 프로필 | 구성 | 권장 용도 |
|---|---|---|
| `lean` | 작업자 1명, 가장 낮은 기본 실행 한도 | 작은 개인 프로젝트 |
| `balanced` | 작업자 1명, 일반적인 로컬 한도 | 처음 시작할 때 권장 |
| `controlled` | 작업자와 검증자, 별도 검증 단계 | 검수 분리가 필요한 작업 |

프로필은 프로젝트의 파일명과 디렉터리 메타데이터, 언어, 테스트, CI 신호를
바탕으로 제안됩니다. 이 단계에서는 대상 파일을 변경하지 않습니다.

### 3.4 오프라인 엔진으로 설치 계획 만들기

처음에는 무료·결정적·오프라인인 `fake` 엔진을 권장합니다.

```powershell
npx --yes $CM bootstrap `
  --target $Target `
  --profile balanced `
  --engine fake
```

출력에서 다음을 확인합니다.

- 새로 만들거나 교체할 파일
- 기존 파일 해시 또는 `absent`
- 적용 뒤 파일 해시
- 하나의 `planHash`

미리보기는 대상에 쓰지 않습니다. 내용을 검토한 뒤 정확한 해시를 승인합니다.

```powershell
npx --yes $CM bootstrap `
  --target $Target `
  --profile balanced `
  --engine fake `
  --approve PLAN_HASH
```

계획을 만든 뒤 대상 파일이 달라지면 기존 해시는 무효가 되며 새 계획을
승인해야 합니다.

### 3.5 설치 확인

```powershell
npx --yes $CM doctor --target $Target
```

`doctor`는 다음을 확인하지만 모델을 호출하거나 파일을 복구하지는 않습니다.

- 설치 버전과 구성 파일
- OrgSpec과 runtime 스키마
- 역할·엔진·러너 참조
- 어댑터별 설정
- 중단된 파일 교체 journal의 존재와 명시적 복구 필요 여부

미완료 journal이 있으면 증거를 검토한 뒤 `recover`를 명시적으로 실행하거나,
정확히 승인했던 동일한 적용 명령을 반복해 그 작업을 재개해야 합니다.

## 4. 대시보드 시작과 읽는 법

```powershell
npx --yes $CM dashboard `
  --target $Target `
  --port 4173
```

브라우저에서 `http://127.0.0.1:4173`을 엽니다. 대시보드는 로컬
loopback에만 바인딩됩니다. 명령을 실행한 터미널을 종료하면 대시보드도
종료됩니다.

### 4.1 상단 숫자의 의미

| 카드 | 의미 |
|---|---|
| 내 결정 | 산출물·정확한 도구 호출·사용자 입력처럼 사람만 처리할 수 있는 항목 |
| 에이전트 작업 | role/runner가 실행·수정·인계할 항목 |
| 대기 | 현재 누구도 실행할 수 없는 항목과 해소 조건 |
| 이력 | 완료·취소·실패가 확정되어 보존된 기록 |

첫 화면은 `내 결정` 필터로 시작합니다. 카드를 누르면 해당 항목만
표시됩니다.

실패 이력은 사람 검토나 현재 조치 건수에 포함되지 않습니다. 사용자가
명시적으로 다시 시도하기로 결정했을 때만 CLI 또는 운영 흐름에서 복구합니다.

### 4.2 주요 상태

| 화면 상태 | 뜻 | 다음 행동 |
|---|---|---|
| 요청됨 | 새 요청이 아직 담당 역할을 받지 않음 | 담당 지정 |
| 준비 | 실행 가능한 작업 | 모델 실행 |
| 진행 중 | 모델 또는 러너가 실행 중 | 기다리거나 취소 |
| 승인 대기 | 산출물 또는 정확한 도구 호출을 사람이 검토해야 함 | 내용 검토 후 결정 |
| 수정 요청됨 | 사람 검토가 끝났고 담당 역할이 피드백을 반영해야 함 | 표시된 사유를 확인하고 모델 실행 |
| 승인됨 | CLI 등에서 산출물 승인이 끝났지만 아직 닫히지 않음 | 완료 확정 |
| 완료 | 정상적으로 닫힌 작업 | 필요하면 보관 |
| 실패 | 종료된 실패 이력 | 원인 검사 후 선택적으로 재시도 |
| 취소 | 사람이 중단한 작업 | 필요하면 새 요청 생성 |

`수정 요청됨`은 새로운 사람 검토 요청이 아닙니다. 검토자는 이미 결정을
내렸고, 오른쪽 검사기에 표시된 수정 사유를 담당 역할이나 모델이 반영해야
한다는 뜻입니다.

### 4.3 오른쪽 작업 검사기

작업을 선택하면 다음 내용을 확인할 수 있습니다.

- 현재 상태와 다음 조치
- 담당 역할과 실행 대상
- 대기 이유
- 검토자가 남긴 수정 요청 사유
- 제작자가 보고한 산출물 요약·확인·위험·자체 신뢰도
- 현재 Tool Runtime이 같은 실행에서 실제 확인한 근거와 미확인 완료 기준
- 원문 산출물, 정확한 SHA-256과 Decision Packet SHA-256
- 도구 변경 대상, 영향, 안전장치와 정확한 호출 해시

모델이 적은 `checks`는 작업자의 주장으로 표시됩니다. 현재 버전에서는 같은
실행의 Tool Runtime이 남긴 hash-bound evidence만 `검증됨`으로 표시됩니다.
`host_validator`는 증거 계약에 예약된 출처이며, 호스트 검증 결과를 수집하는
경로는 후속 구현 대상입니다. 사람은
제목이나 모델의 자체 신뢰도만 보고 승인하지 말고, 근거 출처와 미확인
예외를 확인해야 합니다.

## 5. 첫 작업 실행

### 5.1 데모로 전체 흐름 확인

```powershell
npx --yes $CM seed-demo --target $Target
npx --yes $CM dashboard --target $Target
```

데모는 실제 유료 모델 없이 요청, 실행, 산출물 검토 흐름을 확인하기 위한
로컬 데이터입니다.

### 5.2 CLI에서 새 작업 만들기

```powershell
npx --yes $CM request `
  "릴리스 노트 작성" `
  --summary "변경 내용을 확인하고 사람이 검토할 간결한 릴리스 노트를 작성한다." `
  --target $Target
```

출력된 `work-000001` 같은 WorkItem ID를 이후 명령에 사용합니다.

### 5.3 담당 역할 지정

```powershell
npx --yes $CM triage `
  --id work-000001 `
  --role operator `
  --target $Target
```

`controlled` 프로필에서는 조직안에 정의된 다른 역할을 선택할 수 있습니다.
역할 ID는 `$Target\.chartermesh\organization.json`에서 확인합니다.

### 5.4 실행

```powershell
npx --yes $CM run `
  --id work-000001 `
  --target $Target
```

정상적으로 산출물을 제출하면 WorkItem은 `승인 대기`가 됩니다. 실행 성공과
산출물 승인은 서로 다른 상태입니다.

### 5.5 산출물 결정

대시보드에서 내용을 검토하는 것이 가장 쉽습니다. CLI에서는 실행 결과의
정확한 artifact SHA-256과 현재 Decision Packet SHA-256을 함께 사용합니다.

먼저 현재 결정 패킷을 확인합니다.

```powershell
npx --yes $CM decision-packet `
  --id work-000001 `
  --target $Target `
  --json
```

승인:

```powershell
npx --yes $CM decide `
  --id work-000001 `
  --decision approve `
  --artifact-hash ARTIFACT_SHA256 `
  --packet-hash PACKET_SHA256 `
  --note "내용과 근거를 검토했습니다." `
  --target $Target
```

수정 요청:

```powershell
npx --yes $CM decide `
  --id work-000001 `
  --decision changes_requested `
  --artifact-hash ARTIFACT_SHA256 `
  --packet-hash PACKET_SHA256 `
  --note "호환성 범위와 검증 근거를 보완하세요." `
  --target $Target
```

수정 요청 뒤에는 `retry`가 아니라 다시 `run`합니다.

```powershell
npx --yes $CM run `
  --id work-000001 `
  --target $Target
```

거절:

```powershell
npx --yes $CM decide `
  --id work-000001 `
  --decision reject `
  --artifact-hash ARTIFACT_SHA256 `
  --packet-hash PACKET_SHA256 `
  --note "요청 목적과 맞지 않아 종료합니다." `
  --target $Target
```

### 5.6 승인된 작업 완료

```powershell
npx --yes $CM complete `
  --id work-000001 `
  --target $Target
```

## 6. 프로젝트 파일 변경 승인

모델이 `workspace.write_file` 또는 여러 파일 change set을 요청해도
CharterMesh는 즉시 실행하지 않습니다. WorkItem은 실패가 아니라 정확한
도구 승인 대기가 됩니다. 여러 파일은 파일마다 승인하지 않고 하나의
content-addressed change set과 Decision Packet으로 압축할 수 있습니다.

대시보드에서 다음을 검토합니다.

- 변경할 모든 상대 경로
- 각 파일의 승인 전 SHA-256 또는 `없음`
- 각 파일의 승인 후 SHA-256, 크기와 읽기 쉬운 변경 요약
- 경로 제한과 실패 시 동작
- 정확한 call hash
- 현재 Decision Packet hash

CLI 승인:

```powershell
npx --yes $CM approve-tool `
  --id work-000001 `
  --call-hash CALL_SHA256 `
  --tool workspace.write_file `
  --packet-hash PACKET_SHA256 `
  --note "경로와 변경 내용을 검토했습니다." `
  --target $Target
```

승인하면 WorkItem이 `준비`로 돌아갑니다. 새 claim은 경로·승인 전 상태·내용을
다시 생성하지 않고 Control Plane에 저장된 그 정확한 호출만 복구 가능한
트랜잭션으로 재생합니다. 파일 하나라도 승인 뒤 바뀌었으면 전체 change set을
적용하지 않고 새 계획과 승인을 요구합니다.

허용하지 않을 경우 대시보드에서 `거부하고 작업 종료`를 선택하거나 CLI에서
현재 패킷 해시에 결박해 거부합니다. 이때 도구는 실행되지 않고 WorkItem은
감사 이력을 보존한 채 `취소`로 종료됩니다.

```powershell
npx --yes $CM deny-tool `
  --id work-000001 `
  --call-hash CALL_SHA256 `
  --tool workspace.write_file `
  --packet-hash PACKET_SHA256 `
  --note "이 변경은 허용하지 않습니다." `
  --target $Target
```

```powershell
npx --yes $CM run `
  --id work-000001 `
  --target $Target

npx --yes $CM tool-evidence `
  --id work-000001 `
  --target $Target `
  --json
```

경로, 인자 또는 내용이 달라지면 해시도 달라지므로 새 승인이 필요합니다.

## 7. 실제 LLM 연결

엔진 변경도 프로젝트 파일 변경과 마찬가지로 `계획 → 정확한 해시 승인`
절차를 사용합니다.

### 7.1 로컬 OpenAI 호환 서버

Ollama, llama.cpp server, LM Studio, vLLM 등 Chat Completions 호환 서버를
사용할 수 있습니다.

| 런타임 | 흔히 사용하는 base URL |
|---|---|
| Ollama | `http://127.0.0.1:11434/v1` |
| llama.cpp server | `http://127.0.0.1:8080/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |

포트와 모델 ID는 CharterMesh가 정하는 값이 아닙니다. 실제 모델 서버의
설정을 확인하세요.

```powershell
npx --yes $CM configure-engine `
  --target $Target `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:11434/v1 `
  --model YOUR_MODEL_ID `
  --structured-output prompt `
  --reasoning disabled
```

출력된 계획을 검토하고 동일한 명령에 해시를 붙입니다.

```powershell
# 위와 동일한 인자를 유지해야 합니다.
npx --yes $CM configure-engine `
  --target $Target `
  --engine openai-compatible `
  --endpoint http://127.0.0.1:11434/v1 `
  --model YOUR_MODEL_ID `
  --structured-output prompt `
  --reasoning disabled `
  --approve PLAN_HASH

npx --yes $CM doctor --target $Target
```

모델 서버가 OpenAI 방식의 function call을 실제 지원할 때만
`--tool-calling`을 추가합니다. 이 옵션은 도구 전송 능력을 선언할 뿐,
OrgSpec 허용 목록이나 사람 승인을 우회하지 않습니다.

`--structured-output prompt`는 대부분의 로컬 서버에서 사용할 수 있습니다.
서버가 OpenAI JSON Schema response format을 지원한다고 확인한 경우에만
`json-schema`를 선택하세요.

### 7.2 원격 모델 공급자

API 키 값은 프로젝트 파일에 넣지 않고 환경변수로 설정합니다.

```powershell
$env:CHARTERMESH_MODEL_API_KEY = "your-secret"

npx --yes $CM configure-engine `
  --target $Target `
  --engine openai-compatible `
  --endpoint https://provider.example/v1 `
  --model YOUR_MODEL_ID `
  --api-key-env CHARTERMESH_MODEL_API_KEY
```

CharterMesh에는 환경변수 이름만 기록됩니다. 자격증명을 포함한 원격 연결은
HTTPS가 필요하며 redirect는 따라가지 않습니다.

### 7.3 임의의 로컬 실행 파일

HTTP 호환 서버가 없는 로컬 엔진은 중립 JSON stdin/stdout 계약을 구현한
wrapper로 연결할 수 있습니다.

```powershell
npx --yes $CM configure-engine `
  --target $Target `
  --engine command-process `
  --command C:\absolute\path\to\engine.exe `
  --command-arg --chartermesh-json `
  --model LOCAL_MODEL_LABEL `
  --pass-env LOCAL_MODEL_HOME `
  --timeout-ms 60000
```

CharterMesh는 셸을 사용하지 않고 절대 경로의 실행 파일을 직접 시작합니다.
승인된 실행 파일 SHA-256과 현재 파일이 다르면 실행을 거부합니다. 실행 파일을
업데이트한 경우 새 설정 계획을 승인해야 합니다.

상세 프로토콜은 [LLM 연결 안내](LLM-CONNECTIONS.md)를 참고하세요.

### 7.4 모델 품질 시험

```powershell
npx --yes $CM evaluate-model `
  --target $Target `
  --live `
  --json
```

`--live`는 실제 모델 호출에 대한 명시적 동의입니다. 이 시험은 세 개의 합성
작업만 보내며 프로젝트 파일은 보내지 않습니다.

### 7.5 소형 모델 멀티에이전트 시험

일반 실행은 하나의 worker입니다. 아래처럼 `--delegated`를 붙이면 같은
ModelEngine을 planner → implementer → verifier → synthesizer 순서로 네 번
독립 실행합니다. 각 역할은 부모 Run 아래 별도 Attempt와 모델 사용량으로
기록되고 마지막 산출물 하나만 사람 검토로 올라옵니다.

```powershell
npx --yes $CM run `
  --id work-000001 `
  --delegated `
  --target $Target
```

이 모드는 깊이 1, 역할 4개, 순차 실행, parent-only 전달로 제한된 실험
기능입니다. 에이전트가 사람 승인을 대신하지 않으며, 파일 쓰기 도구는
기존과 똑같이 정확한 호출 해시 승인을 받아야 합니다. Codex나 Claude의
네이티브 subagent/agent team을 사용한다는 뜻도 아닙니다.

단일 실행과 위임 실행의 품질을 같은 합성 업무로 비교하려면:

```powershell
npx --yes $CM evaluate-collaboration `
  --target $Target `
  --live `
  --repetitions 3 `
  --json
```

이 평가는 프로젝트 파일을 보내지 않습니다. 두 조건의 최대 출력 토큰 요청
상한은 같지만 입력+출력 총 토큰이 같다고 주장하지 않으며, 실제 사용량은
공급자가 제공한 값 그대로 별도 표시합니다.

## 8. 비용과 실행 한도

CharterMesh 자체에는 모델 가격이 없습니다. 사용자가 선택한 모델, 계정,
로컬 전력 또는 원격 공급자 요금은 사용자가 관리합니다.

OrgSpec의 주요 한도:

- `maxConcurrentRuns`: 동시 실행 수
- `maxDailyModelStarts`: 하루 모델 시작 수
- `monthlyCostLimitUsd`: 월 비용 한도
- `unknownCostPolicy`: 가격을 모를 때의 정책
- `maxArtifactBytes`: 산출물 한 건의 크기
- `maxWorkItemArtifactBytes`: WorkItem 전체 산출물 크기

가격을 모를 때:

| 정책 | 동작 |
|---|---|
| `warn` | 실행을 허용하고 비용을 `unknown`으로 보존 |
| `block` | 알 수 없는 비용의 엔진 또는 이후 실행을 보수적으로 차단 |
| `estimate` | 사용자가 입력·출력 토큰 가격을 제공해야 실행 |

가격을 제공하려면 엔진 설정에 두 값을 함께 추가합니다.

```text
--input-price-per-million 0.20
--output-price-per-million 0.60
```

이 값은 CharterMesh 가격이 아니라 사용자가 선택한 모델·계정의 가격입니다.
공급자 측 결제 한도가 최종적인 비용 안전장치입니다.

## 9. 실패, 취소와 대기

### 실패

실패는 종료된 이력이며 자동으로 재실행되지 않습니다. 먼저 오류와 이전
산출물·도구 증거를 검사합니다. 다시 실행하기로 사람이 결정한 경우:

```powershell
npx --yes $CM retry `
  --id work-000001 `
  --target $Target

npx --yes $CM run `
  --id work-000001 `
  --target $Target
```

재시도는 새 generation을 만들므로 이전 worker가 새 실행에 결과를 제출할
수 없습니다.

도구 실행은 끝났지만 증거 저장이 실패한 `TOOL_OUTCOME_UNKNOWN` 상태에서는
일반 재시도를 거부합니다. 작업공간에 변경이 실제로 생겼는지 먼저 확인한 뒤
CLI에서는 `--acknowledge-tool-outcome`을 추가하거나, 대시보드의 재시도 확인창에
동의해야 합니다. 이는 쓰기 작업의 중복 실행을 막기 위한 사람 확인 절차입니다.

### 실행 취소

```powershell
npx --yes $CM cancel `
  --id work-000001 `
  --target $Target
```

대시보드 취소, 별도 CLI 취소와 실행 중 `Ctrl+C`는 동일한 Control Plane
취소 요청을 사용합니다.

### 사용자 입력 대기

```powershell
npx --yes $CM wait `
  --id work-000001 `
  --type user_input `
  --reason "배포 대상 지역을 선택해야 합니다." `
  --target $Target
```

입력을 받은 뒤에는 일반 `resume`으로 우회하지 않고 현재 입력 요청 패킷에
응답을 결박합니다. 대시보드의 `요청된 입력 제공`을 사용하거나 CLI에서:

입력 원문은 로컬 Control Plane에 저장되고 다음 모델 실행 컨텍스트로 전달됩니다.
비밀번호, API 키, 토큰, 인증서 같은 비밀정보는 이 경로에 입력하지 말고 환경
변수나 별도 secret 관리 경로를 사용하세요. CLI의 `--response` 값은 셸 기록이나
프로세스 인자 목록에 남을 수 있습니다. 비밀이 아닌 민감한 일반 응답도 가능하면
로컬 대시보드 입력 폼을 사용하고, 비밀정보 자체는 대시보드에도 입력하지 마세요.
active review time과 상세 열람 횟수는
완료된 결정의 로컬 UX 추정치로만 기록되며 정확도나 전체 검토 시간을 뜻하지
않습니다.

```powershell
npx --yes $CM decision-packet `
  --id work-000001 `
  --target $Target `
  --json

npx --yes $CM provide-input `
  --id work-000001 `
  --packet-hash PACKET_SHA256 `
  --response "대한민국 리전으로 진행하세요." `
  --target $Target
```

## 10. 운영과 데이터 관리

### 활성 작업 목록

```powershell
npx --yes $CM list `
  --target $Target `
  --active-only `
  --limit 100 `
  --json
```

### 전체 시스템 일시 정지

```powershell
npx --yes $CM system pause `
  --reason "점검" `
  --target $Target

npx --yes $CM system resume --target $Target
```

일시 정지는 새 모델 실행만 막습니다. 이미 실행 중인 작업을 자동 취소하지
않습니다.

### Control Plane 백업

```powershell
npx --yes $CM backup create `
  --target $Target `
  --json

npx --yes $CM backup list `
  --target $Target `
  --json
```

이 백업은 `.chartermesh/state.db`와 그 DB가 참조하는 산출물을 보호합니다.
사용자 프로젝트 파일과 Git 저장소는 백업하지 않습니다.

복원은 먼저 무쓰기 계획을 만듭니다.

```powershell
npx --yes $CM restore `
  --backup BACKUP_ID `
  --target $Target `
  --json
```

계획을 검토한 뒤 동일한 명령에 `--approve PLAN_HASH`를 추가합니다.

### 감사 기록 내보내기

```powershell
npx --yes $CM audit export `
  --target $Target `
  --json
```

기본 출력은 `$Target\.chartermesh\exports` 아래 JSONL입니다. 허용된 ID,
해시, 상태, 역할·엔진 이름과 시간 증거만 내보내며 자격증명과 원문 도구
인자는 포함하지 않습니다.

### 완료 작업 보관

```powershell
npx --yes $CM archive `
  --id work-000001 `
  --target $Target
```

보관은 완료 또는 취소된 작업을 기본 목록에서 숨길 뿐, 이력과 증거를
삭제하지 않습니다.

## 11. 로컬 파일 구조

적용 뒤 대상 프로젝트에 다음 구조가 생깁니다.

```text
.chartermesh/
├─ proposal.json       프로젝트 검사 결과와 제안 근거
├─ organization.json   승인된 조직·역할·워크플로·정책
├─ runtime.json        엔진과 러너 설정
├─ installation.json   설치 버전과 계획 해시
├─ AGENT-ENTRYPOINT.md 코딩 에이전트 진입 안내
├─ skills/             공급자 중립 Agent Skills
├─ state.db            변경 가능한 Control Plane 원장
├─ artifacts/          SHA-256 기반 검토 산출물
├─ backups/            Control Plane 백업
├─ engine-work/        command-process 전용 작업 디렉터리
└─ exports/            감사 JSONL 내보내기
```

`state.db`, 산출물, 백업과 engine 작업 디렉터리는 기본적으로 Git에
커밋하지 않습니다.

정본의 구분:

- 원하는 조직과 런타임: `organization.json`, `runtime.json`
- 현재 작업 상태: `state.db`
- 검토 대상: content-addressed artifact와 SHA-256
- 화면 숫자: 서버가 생성한 `DashboardProjection`

## 12. 문제 해결

| 증상 | 확인할 사항 | 조치 |
|---|---|---|
| `Node.js 24 or newer` 오류 | `node --version` | Node.js 24 이상 설치 |
| 계획 해시 불일치 | 계획 뒤 대상 파일이 변경됨 | 같은 명령으로 새 계획 생성 후 새 해시 검토 |
| `doctor`가 runtime 오류 보고 | 수동 편집, 중복 ID, 잘못된 엔진 참조 | 오류 경로를 수정하거나 새 `configure-engine` 계획 사용 |
| 모델 서버 연결 실패 | endpoint, 포트, 모델 ID, 서버 실행 상태 | 모델 서버 설정을 확인하고 `doctor` 재실행 |
| API 키를 찾지 못함 | 현재 터미널에 환경변수가 없음 | 키 값을 저장소 밖 환경변수에 다시 설정 |
| 구조화 산출물 실패 | 모델이 요구 JSON 형식을 지키지 못함 | reasoning 비활성화, prompt 모드, 더 적합한 모델 사용 |
| 도구 승인을 요구함 | 모델이 쓰기 또는 외부 검색을 요청함 | 변경 내용과 정확한 call hash 검토 후 승인 |
| 작업이 실패 목록에 있음 | 실행이 이미 종료됨 | 원인을 검사한 뒤 필요할 때만 `retry` |
| 수정 요청됨 | 이전 검토자가 보완 사유를 남김 | 검사기의 사유를 확인하고 바로 `run` |
| 대시보드가 열리지 않음 | 명령 터미널 종료, 포트 충돌 | 대시보드를 다시 시작하거나 다른 `--port` 사용 |
| 복원 중 maintenance 오류 | 대시보드 등 쓰기 프로세스가 열려 있음 | 관련 로컬 프로세스를 중지하고 복원 재시도 |

구성 파일 교체 중 프로세스가 종료되었다면 journal을 수동 삭제하지 마세요.
`doctor`와 다음 계획 명령은 파일을 바꾸지 않고 미완료 상태를 보고합니다.
내용을 확인한 뒤 다음 명시적 복구 명령을 실행하세요.

```powershell
npx --yes $CM recover --target $Target --json
```

## 13. 안전하게 제거하기

현재 자동 삭제 명령은 없습니다.

1. 대시보드와 scheduler watcher를 종료합니다.
2. 필요한 감사 기록과 Control Plane 백업을 보관합니다.
3. `.chartermesh`에 필요한 증거가 없는지 확인합니다.
4. 사람이 정확한 대상 경로를 확인한 뒤 `.chartermesh` 디렉터리를
   명시적으로 삭제합니다.

이 디렉터리를 삭제하면 로컬 WorkItem 원장, 실행 기록, 승인과 산출물을
복구할 수 없습니다. 프로젝트의 Git 파일은 별도로 관리해야 합니다.

## 14. 추가 문서

- [최초 실행 안내](FIRST-RUN.md)
- [LLM 연결 안내](LLM-CONNECTIONS.md)
- [운영 명령 상세](USAGE.md)
- [모델 품질 평가](MODEL-EVALUATION.md)
- [대시보드 설계](DASHBOARD-DESIGN.md)
- [제품·아키텍처 정본](PRODUCT-DESIGN.md)
- [보안 정책](../SECURITY.md)
