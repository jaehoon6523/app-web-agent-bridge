import "dotenv/config";
import http from "node:http";
import { WebSocketServer } from "ws";
import { loadConfig } from "./src/config.js";
import { WebExtensionTransport, ChatGptWebSessionAdapter } from "./src/runtime/web/index.js";
import { 
  createWebSessionBinding, 
  canonicalConversationUrl, 
  extractConversationId 
} from "./src/runtime/web/binding.js";

const config = loadConfig();
const rawUrl = process.argv[2];

if (!rawUrl) {
  console.error("사용법: node test_web_turn.mjs <ChatGPT 대화 URL>");
  process.exit(1);
}

async function main() {
  const canonicalUrl = canonicalConversationUrl(rawUrl);
  const conversationId = extractConversationId(canonicalUrl);

  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const transport = new WebExtensionTransport(config.webExtension);
  const webSession = new ChatGptWebSessionAdapter({
    transport,
    responseTimeoutMs: 60000,
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/ws/extension") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  let rawSession = null;
  let unacknowledgedDeliveryId = null;

  wss.on("connection", (ws) => {
    console.log("-> 브라우저 확장 프로그램 웹소켓 연결 성공!");
    transport.attach(ws);
  });

  transport.on("message", (msg) => {
    const session = msg?.payload?.session;
    if (session && Number.isSafeInteger(session.tabId)) {
      rawSession = session;
    }
    if (msg?.payload?.currentDeliveryId) {
      unacknowledgedDeliveryId = msg.payload.currentDeliveryId;
    }
  });

  webSession.onEvent((event) => {
    console.log(`[WebSession Event]: ${event.type}`);
    if (event.payload?.text) {
      console.log("[ChatGPT 스트리밍]:\n", event.payload.text);
    }
  });

  await new Promise((resolve) => server.listen(8787, "127.0.0.1", resolve));
  console.log("=================================================");
  console.log("8787 포트 열림. ChatGPT 브라우저 창에서 F5를 누르세요.");
  console.log("=================================================");

  while (!transport.authenticated || !rawSession) {
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[탭 확인 완료] tabId: ${rawSession.tabId}`);

  console.log("화면 렌더링 안정화 대기 (6초)...");
  await new Promise((r) => setTimeout(r, 6000));

  const runId = "manual_run_" + Date.now();
  const sessionId = "manual_session_" + Date.now();

  const finalBinding = createWebSessionBinding({
    sessionId,
    runId,
    tabId: rawSession.tabId,
    windowId: rawSession.windowId,
    conversationUrl: canonicalUrl,
    conversationId: conversationId,
    title: rawSession.title || "ChatGPT",
    lastObservedUserMessageId: rawSession.lastObservedUserMessageId ?? null,
    lastObservedAssistantMessageId: rawSession.lastObservedAssistantMessageId ?? null,
    bindingStatus: "BOUND",
  });

  console.log("\n1. webSession.start() 바인딩 초기화...");
  await webSession.start({ binding: finalBinding, focus: true });
  console.log("-> 바인딩 성공 (SESSION_READY)!");

  const currentBinding = transport.snapshot?.binding || finalBinding;
  const activeRunId = currentBinding.runId;

  if (unacknowledgedDeliveryId) {
    console.log(`\n2. 미완료 턴(${unacknowledgedDeliveryId}) ACK 처리 중...`);
    try {
      await webSession.acknowledgeDelivery({ turnId: unacknowledgedDeliveryId });
      console.log("-> acknowledgeDelivery 성공!");
    } catch (ackErr) {
      console.warn("-> ACK 처리 통과:", ackErr.message);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("\n3. submitTurn() 메시지 전송 시작 (브라우저 확인)...");
  const turnId = "turn_" + Date.now();
  const controllerMessageId = "msg_" + Date.now();

  const { completion } = await webSession.submitTurn({
    turnId,
    controllerMessageId,
    runId: activeRunId,
    text: "안녕하세요! 브릿지 연결 테스트입니다. 한 줄로 짧게 답변해주세요.",
  });

  console.log("-> 메시지 전송 완료! ChatGPT 응답 스트리밍 수신 대기 중...");
  const turnResult = await completion;

  console.log("\n==========================================");
  console.log("[ChatGPT 웹 응답 수신 성공!]");
  console.log(JSON.stringify(turnResult, null, 2));
  console.log("==========================================");

  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[오류 발생]:", err.message);
  if (err.details) console.error("Details:", JSON.stringify(err.details, null, 2));
  process.exit(1);
});
