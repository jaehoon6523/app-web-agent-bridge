# Extension lifecycle and delivery recovery verification

이 변경의 기준은 `2559db9fc8585f6cda4c61c57c3f628dca98a717`이다. 확장 버전은 0.2.2이며, 로드된 확장의 버전만으로 저장소와 동일한 소스임을 입증할 수 없다.

Windows PowerShell에서 Node 24 이상을 사용한다. 최초 준비는 다음과 같다.

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
npx playwright-core install chromium
if ($LASTEXITCODE -ne 0) { throw "Chromium installation failed" }
```

검증은 저장소 루트에서 한 명령으로 실행한다.

```powershell
npm run verify:all
```

매 실행은 `.agent-controller/latest-verification.log`를 덮어쓴다. 이 로그가 모든 단계의 통합 로그다. 내부 완료 확인용 JSON은 별도로 유지된다. 이전 실패나 확인되지 않은 검사 결과를 이후 성공으로 덮어쓰지 않는다.

| 단계 | 범위 |
| --- | --- |
| `check` | lint, architecture, TypeScript, 전체 Node 회귀 검사 |
| `test:browser` | 실제 Chromium DOM, 생산 모듈·WebSocket, Chrome API 및 provider 페이지 fixture |
| `test:extension:native` | 임시 프로필의 실제 확장 로더·Chrome API·서비스 워커, provider 페이지 fixture |
| `test:platform:browser` | 생산 서버·실제 Chromium 대시보드 |
| `test:e2e:ci` | 기존 전체 E2E 워크플로 |

종료 코드 0은 모든 단계 PASS, 1은 실패, 2는 나머지 단계 통과 후 네이티브 확장 검증 불가(PARTIAL)다. 네이티브 로더 미시작은 UNVERIFIED이며 PASS로 취급하지 않는다. 정상 로더 시작 후 단언 실패는 FAIL이다. 실제 ChatGPT 서비스와 사용자 Chrome 프로필은 이 fixture 검사 범위에 포함되지 않는다.

`UI_BROWSER_EXECUTABLE`이 설정되어 있으면 지정한 실행 파일을 사용한다. 네이티브 검증에는 확장을 지원하는 전체 Chromium이 필요하다. 설치된 일반 Chromium을 사용하려면 기존 override를 확인하고 필요한 경우 제거한다.

```powershell
Get-Item Env:UI_BROWSER_EXECUTABLE -ErrorAction SilentlyContinue
Remove-Item Env:UI_BROWSER_EXECUTABLE -ErrorAction SilentlyContinue
npm run verify:all
```

네이티브 검사는 임시 복사본에 listener 등록 횟수를 세는 observer 파일만 앞에 추가하며, 생산 JS 파일은 그대로 복사한다. 임시 프로필과 복사본은 검사 종료 시 삭제한다. 실제 로그인·실제 프롬프트 전송은 하지 않는다.

팝업의 ‘전송 상태 확인’은 페이지 상태와 인증된 컨트롤러의 전송 메타데이터를 읽는다. ‘대화 확인’은 정확한 대화 탭을 열거나 활성화한다. ‘컨트롤러에서 해당 작업 확인’은 대상 전송 식별자가 포함된 확인 페이지를 연다. 보관된 다른 세션의 전송은 먼저 선택해 확인한다. 이전 버전의 보관 기록에 작업·대화 정보가 없으면 이를 추측하지 않으며, 컨트롤러의 정확한 세션 복구가 필요하다.

확장에만 전송이 남으면 서버의 모든 기록 조회가 성공하고 MISSING인 경우에만 팝업의 명시적 폐기를 사용할 수 있다. 서버·확장 양쪽 기록은 대상 소유권이 일치해야 한다. 서버에만 전송이 남으면 확장의 동일 바인딩·활성 전송 없음·보관 전송 없음이 확인되고 추가 확인란을 선택해야 한다. 다른 전송·세션·작업으로 기록이 이동했거나 조회가 실패하면 기록을 보존한다. 활성 생성 중 폐기는 거부한다.

Reviewer 응답의 저장된 증거가 존재하는 ACK_PENDING은 확인 페이지에서 ACK를 확인할 수 있다. 결과가 불명확한 전송은 ACK하지 않는다. 준비 응답의 검증 및 ACK 복구는 기존 준비 작업의 대화 확인·복구 경로를 사용한다. 명시적 폐기와 ACK 확인은 프롬프트를 다시 보내지 않는다.

준비 작업에서는 DOM 생성 표시가 없어도 정확한 전송 ID의 content 작업이 응답을 기다리는 busy 상태이면 ‘상태 확인’ 후 ‘생성 종료’를 사용할 수 있다. 작업 종료만으로 ACK하거나 소유권을 지우지 않는다. 종료를 확인한 후 별도의 명시적 폐기를 수행한다.

제품 런타임의 종료 정책은 이 변경 범위에 포함되지 않는다. Windows 검사 통과와 사용자 환경에서 오류가 사라졌다는 확인은 별도의 증거다.
