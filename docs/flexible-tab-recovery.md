# Tab diagnosis with an unresolved delivery

The popup separates the stored preparation failure from the current delivery owner.
A failure's diagnostic tab ID can refer to a different preparation attempt. It is not
evidence that the owned delivery was sent or that its page currently lacks a composer.

Use **모든 탭 상태 다시 확인** to inspect every supported open ChatGPT tab, including
multiple root tabs. Select a tab to see composer availability, content runtime version,
and current inspection errors. **선택한 탭 열기** focuses that tab after checking its URL.
Neither action injects content, rebinds a conversation, discards delivery records, or
sends a prompt. These checks work even when authentication or delivery recovery is blocked.

The diagnostic snapshot may become stale; repeat inspection after navigation or a
manual reload. A version mismatch suggests old content remains in a tab. Check the
original delivery and generation state before reloading that tab.

For the owned delivery, use **전송 상태 확인** and **대화 확인**. A matching server record
is recovered or discarded through **컨트롤러에서 해당 작업 확인**. An extension-only
record can be discarded only after the server confirms it is missing and the existing
operator confirmations are supplied. Composer absence alone never authorizes deletion.

An ownership change invalidates the popup's server inspection, even if the delivery ID
is unchanged. An active request observed in another document is not reported as the
owned delivery being in flight. Multiple roots do not trigger automatic rebinding.
