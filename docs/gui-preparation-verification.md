# 협의 화면 검증 기록

2026-11-24 KST · 운영 Bridge의 별도 검증용 협의에서 확인했다.

| 항목 | 판정 | 운영 검증 |
| --- | --- | --- |
| GUI-04A | 검증 완료 | 응답이 저장되고 ACK가 대기 중일 때 두 상태가 따로 표시됐다. 확장 쪽 전송 ID가 일치하지 않는 동안 화면에 막힌 이유와 다음 행동이 나타났다. |
| GUI-04B | 검증 완료 | ACK 대기 중 누른 종료가 보류됐다. 원래 전송 ID를 복원하자 같은 응답 해시로 ACK가 확인됐고, 재전송이나 추가 종료 클릭 없이 협의와 Bridge 소유 탭이 종료됐다. 기존 Chrome 탭은 열린 상태였다. |
| GUI-07A | 검증 완료 | 같은 협의의 다른 대시보드 탭에서 검증 메시지를 보냈다. 응답 대기 진입과 ACK 후 협의 복귀를 포함한 실제 자동 렌더링 5회 모두에서 관찰 탭의 초안, 답변 입력칸 포커스, `READY` 선택 범위(18–23)가 유지됐다. 관찰 탭의 초안은 보내지 않았고 수동 새로고침 없이 확인했다. |

GUI-04A·04B의 검증용 협의는 `prep_e4a19490-56e0-4600-b3f5-57391abb0660`, 전송은 `delivery_df9057b6-991c-4173-8f5c-272f9651379b`다. GUI-07A의 검증용 협의는 `prep_5668ab5e-fb4c-4d3e-848b-3d61b42c2e59`다. 전송 ID 불일치와 화면 렌더링을 관찰하기 위해 사용한 임시 코드는 검증 후 제거했다.

사용자가 운영 작업 트리에서 ACK 대기 테스트와 종료 보류·입력 보존 테스트를 각각 실행했고, 둘 다 통과했다. 아래 명령은 배포 브랜치에서 분리한 GUI 변경을 검증할 때 사용한다.

```powershell
node --test --test-name-pattern 'a stored response stays visibly unfinished while acknowledgement is pending' tests/public/workflow-runtime.test.js
node --test --test-name-pattern 'preparation refresh preserves the reply draft and controls while closure awaits ACK' tests/public/workflow-runtime.test.js
```

이 변경은 서버가 반환한 상태를 화면에 표시한다. 운영 검증에서 사용한 종료 보류와 탭 닫힘 영수증을 생성하는 서버·확장 변경은 이 GUI 변경에 포함되지 않으며, 해당 증거가 없으면 화면은 확인된 범위까지만 표시한다.
