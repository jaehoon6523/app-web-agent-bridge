# Concept A 전환 계약

| 기능 | 기존 DOM / 이벤트 | API 또는 확장 명령 | 상태 출처 | 새 화면 위치 | 회귀 검증 |
| --- | --- | --- | --- | --- | --- |
| 프로젝트 선택·새 작업 | runList / newRun / newProjectTask click | GET /api/state | runs, projectConversations, workflow | 프로젝트 탐색, 작업 문서 | dashboard-model, first-load |
| Run 이어서 작업 | continueProject click | POST /api/preparations, followUpRunId | 선택된 Run | 작업 문서의 이전 작업 안내 | preparation-api |
| 대화 URL 지정·저장 대화 | conversationUrl / reuseProjectConversation input | POST /api/preparations, conversationUrl, reuseProjectConversation | 프로젝트 경로와 정확히 일치하는 매핑 | 작업 문서의 대화 선택 | preparation-api |
| 준비 시작·수정·승인·취소 | startForm / reviseRequirements / projectForm / closeProject / cancelInitialPreparation | 기존 preparation POST 경로 | workflow, agreement, commandCapabilities, 요청 진행 상태 | 작업 문서의 주요 행동과 보조 행동 | preparation-critical, preparation-capabilities |
| 대화 확인 | planningUrl / projectConversationLink | 조회된 URL 열기·복사 | preparation.webSession, preparation.conversationUrl, 프로젝트 저장 매핑 | 접힌 대화 정보 | dashboard-io-depth |
| 실행·감사·복구 | runPanel, runActionTiers, evidenceDialog | 기존 /api/commands 및 복구 경로 | run, capabilities, delivery, evidence | 기존 Run 화면 | dashboard-controller, delivery-recovery-ui |
| 팝업 연결·인증·재확인 | save / reconnect / openPairing | 기존 설정·페어링·bridge.getState | 확장 연결 및 인증 | 팝업 연결 설정 | browser-extension-suite |
| 팝업 탭·로그 | inspectTabs / choosePreparationTab / exportAgentDiagnostics | bridge.inspectTabs 및 기존 상세 명령 | 후보별 진단 결과 | 탭 진단과 로그 | browser-extension-suite |
| 팝업 전송·소유권 | inspectDelivery / selectDelivery / discardOrphan | bridge.inspectDelivery 및 기존 소유권 정리 | 전송 및 서버 기록 대조 | 전송 확인 | extension-delivery-review |

전환 시 접힌 기술 정보와 프로젝트 탐색을 찾아갈 수 있는지 확인한다. Run의 Worker, Intervention, JUDGE·CRITIC, 적용과 종료에는 기존 화면을 사용하며 개별 화면의 새 디자인은 후속 과제다.

## 전환 확인

- 작은 화면에서는 프로젝트 보기 버튼으로 목록을 펼친다. 긴 프로젝트명과 다수의 기록이 있는 경우 첫 화면에서 작업 문서를 찾는 시간과 키보드 이동 경로를 확인한다.
- 대화 시트에는 현재 준비의 URL과 같은 프로젝트의 저장 URL이 각각 표시된다. 두 링크가 다른 경우 준비 업무의 대상 대화와 저장된 프로젝트 매핑을 구별할 수 있어야 한다. 준비 ID가 바뀌면 열린 시트를 닫는다.
- 팝업의 탭 진단은 사용자가 펼친다. 전송을 확인할 때 소유 대상이 바뀌면 진행 중이던 조회 결과를 폐기한다. 팝업 정상, 연결 오류, 수신 확인 대기, 서버 기록 누락 및 소유권 정리 화면에서 동작을 확인한다.
- 전환 기준은 후보 브라우저 검증과 전체 검증 결과다. 운영 대시보드, Chrome 프로필, 사용자 데이터에는 후보를 적용하지 않는다.
