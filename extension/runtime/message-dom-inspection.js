// Serialized by chrome.scripting; keep this function independent of module state.
export function inspectMessageDom(request, requestId) {
  // Only an accessibility heading outside message content can prove its single sibling branch.
  function headingRole(node, content) {
    const labels = new Map([["내가 한 말:", "user"], ["You said:", "user"],
      ["ChatGPT 답변:", "assistant"], ["ChatGPT said:", "assistant"]]);
    for (let parent = content; parent; parent = parent.parentElement) {
      const children = [...(parent.children ?? [])];
      const headings = children.filter(child => child.tagName === "H4" && child.classList?.contains("sr-only"));
      if (!headings.length) continue;
      if (headings.length !== 1 || children.length !== 2) return null;
      const heading = headings[0], branch = children.find(child => child !== heading);
      const label = (heading.textContent ?? "").trim(), role = labels.get(label);
      const bodySelector = "[data-markdown-text-tone='user-message'], [data-markdown-text-style='assistant-message'], [data-testid='collapsible-user-message-content'], [data-message-content], .markdown";
      if (!role || !content.matches?.(bodySelector) || heading.closest(bodySelector) || !branch?.contains(content) || (node !== parent && !branch.contains(node) && !node.contains(parent))
        || parent.querySelectorAll("h4.sr-only").length !== 1) return null;
      // An outer turn wrapper is eligible only when all message evidence belongs to this one inner block.
      if (node !== parent && node.contains(parent) && (node.querySelectorAll("h4.sr-only").length !== 1
        || [...node.querySelectorAll(bodySelector + ", [data-message-author-role], [data-chatgpt-search-unit-key]")]
          .some(item => !parent.contains(item)))) return null;
      const bodies = [branch, ...branch.querySelectorAll(bodySelector)].filter(item => item.matches(bodySelector));
      const roots = bodies.filter(item => !bodies.some(other => other !== item && other.contains(item)));
      if (roots.length !== 1 || !roots[0].contains(content)) return null;
      const roleNodes = [node, parent, ...parent.querySelectorAll("[data-message-author-role], [data-chatgpt-search-unit-key]")];
      for (const item of roleNodes) {
        const explicit = item.getAttribute("data-message-author-role");
        const suffix = item.getAttribute("data-chatgpt-search-unit-key")?.match(/:(user|assistant)$/u)?.[1];
        if ((explicit && explicit !== role) || (suffix && suffix !== role)) return null;
      }
      // Distinct sibling units under one heading cannot borrow each other's role proof.
      const units = [...branch.querySelectorAll("[data-chatgpt-search-unit-key]")];
      if (branch.getAttribute("data-chatgpt-search-unit-key") !== null) units.unshift(branch);
      if (units.length > 1 || parent.querySelectorAll("[data-message-author-role]").length > 1) return null;
      return { role, proof:{ source:"PAGE_ACCESSIBILITY_HEADING", tagName:"H4", label,
        relation:"DIRECT_SIBLING_MESSAGE_BRANCH", headingCount:1, messageBranchCount:1 } };
    }
    return null;
  }
  let stage = "page_url", cause = "URL_ACCESS_EXCEPTION";
  // Do not turn an injected exception into a successful executeScript result.
  const report = (code, cause) => {
    try {
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(requestId) && Number.isSafeInteger(request.tabId))
        console.warn(JSON.stringify({ layer:"extension_page", requestId, tabId:request.tabId,
          at:new Date().toISOString(), stage, code, cause }));
    } catch { /* Diagnostics must not alter inspection. */ }
  };
  try {
    if (location.href !== request.conversationUrl) {
      report("TAB_CHANGED", "URL_MISMATCH");
      return { errorCode: "TAB_CHANGED" };
    }
    stage = "content_dom";
    cause = "SELECTOR_QUERY_EXCEPTION";
    const selectors = ["[data-message-author-role]", "[data-chatgpt-search-unit-key]", "article[data-testid^='conversation-turn-']"];
    const contentSelectors = ["[data-markdown-text-tone='user-message']", "[data-markdown-text-style='assistant-message']",
      "[data-testid='collapsible-user-message-content']", "[data-message-content]", ".markdown"];
    let nodes = [], selector = null;
    for (const candidate of selectors) {
      const found = [...document.querySelectorAll(candidate)];
      if (found.length && selector === null) selector = candidate;
      for (const node of found) if (!nodes.includes(node)) nodes.push(node);
    }
    cause = "DOM_READ_EXCEPTION";
    const attribute = (node, name) => {
      const value = node?.getAttribute(name) ?? null;
      const safe = value !== null && value.length <= 160 && /^[\w:.-]*$/u.test(value)
        && (name !== "data-message-content" || ["", "true", "false"].includes(value));
      return { present:value !== null, value:safe ? value : null, length:value?.length ?? null,
        kind:value === null ? "ABSENT" : value === "" ? "EMPTY" : safe ? "TOKEN" : "REDACTED_CONTENT" };
    };
    const attributes = node => Object.fromEntries(["data-message-id", "data-testid", "data-message-content",
      "data-message-author-role", "data-chatgpt-search-unit-key", "data-chatgpt-search-message-ids", "id"]
      .map(name => [name, attribute(node, name)]));
    const matches = [], seenContents = new Map();
    let userCount = 0, assistantCount = 0, unknownCount = 0;
    nodes.forEach((node, index) => {

      let content = node, contentSelector = null;
      for (const candidate of contentSelectors) {
        cause = "SELECTOR_QUERY_EXCEPTION";
        const found = node.querySelector(candidate);
        cause = "DOM_READ_EXCEPTION";
        if (found) { content = found; contentSelector = candidate; break; }
      }
      const evidence = headingRole(node, content), role = evidence?.role ?? null;
      if (seenContents.has(content)) {
        const previous = matches.find(match => match.index === seenContents.get(content));
        // Multiple selector aliases may share a body; none may contradict its role evidence.
        if (previous?.roleConfirmed && (!evidence || previous.role !== role)) {
          if (previous.role === "user") userCount--; else assistantCount--;
          unknownCount++;
          previous.role = null; previous.roleConfirmed = false; previous.roleProof = null;
        }
        return;
      }
      seenContents.set(content, index);
      if (role === "user") userCount++; else if (role === "assistant") assistantCount++; else unknownCount++;
      const text = content.innerText ?? content.textContent ?? "";
      const controllers = [...text.matchAll(/^\[controller_message_id:([^\]\r\n]+)\]\r?$/gm)].map(m => m[1]);
      const runs = [...text.matchAll(/^\[run_id:([^\]\r\n]+)\]\r?$/gm)].map(m => m[1]);
      const controllerMatch = controllers.includes(request.controllerMessageId), runMatch = runs.includes(request.runId);
      if (!controllerMatch && !runMatch) return;
      const container = node.closest("[data-message-id]") ?? node.closest("article[data-testid^='conversation-turn-']") ?? node;
      const roleConfirmed = evidence !== null;
      matches.push({ index, role, roleConfirmed,
        roleProof:roleConfirmed ? { ...evidence.proof, messageIndex:index } : null,
        controllerMatch, runMatch, controllerMarkerCount:controllers.length, runMarkerCount:runs.length,
        exactMarkers:controllerMatch && runMatch && controllers.length === 1 && runs.length === 1,
        node:{ tagName:node.tagName, attributes:attributes(node) },
        container:{ tagName:container.tagName, attributes:attributes(container) },
        content:{ tagName:content.tagName, selector:contentSelector, fallback:contentSelector === null, attributes:attributes(content) } });
    });
    const complete = matches.length <= 20;
    return { observedUrl:location.href, observedAt:new Date().toISOString(),
      result:complete && matches.length === 1 && matches[0].role === "user" && matches[0].roleConfirmed && matches[0].exactMarkers ? "FOUND" : "NOT_CONFIRMED",
      selector, selectorFallback:selector !== null && selector !== selectors[0], selectorsTried:selectors,
      scope:{ messageCount:nodes.length, userCount, assistantCount, unknownCount,
        firstIndex:nodes.length ? 0 : null, lastIndex:nodes.length ? nodes.length - 1 : null,
        coverage:"CURRENT_DOM_ONLY", historyComplete:false, matchedCount:matches.length, matchesTruncated:!complete },
      matches:matches.slice(0, 20) };
  } catch (error) {
    report("MESSAGE_DOM_INSPECTION_FAILED", cause);
    throw error;
  }
}

export async function replyToMessageDomInspection(chromeApi, send, message) {
  const request = message.payload;
  const fail = (code, stage, cause) => {
    const diagnostic = stage ? { stage, cause } : undefined;
    try {
      if (stage && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(message.requestId))
        console.warn(JSON.stringify({ layer:"extension", requestId:message.requestId, tabId:request.tabId,
          at:new Date().toISOString(), stage, code, cause }));
    } catch { /* Preserve the original reply if the log sink fails. */ }
    return send({ type:"extension.message-dom.inspected", requestId:message.requestId,
      payload:{ errorCode:code, ...(diagnostic && { diagnostic }) } });
  };
  if (!Number.isSafeInteger(request?.tabId) || request.tabId < 0
    || ![request.conversationUrl, request.controllerMessageId, request.runId].every(value => typeof value === "string")
    || !/^https:\/\/chatgpt\.com\/c\/[a-f0-9-]{36}$/u.test(request?.conversationUrl ?? "")
    || !/^delivery_[a-f0-9-]{36}$/u.test(request?.controllerMessageId ?? "")
    || !/^prep_[a-f0-9-]{36}$/u.test(request?.runId ?? "")) return fail("INVALID_DOM_INSPECTION_REQUEST");
  let stage = "tab_query";
  try {
    const before = await chromeApi.tabs.get(request.tabId);
    stage = "tab_url";
    if (before.url !== request.conversationUrl) return fail("TAB_CHANGED", "tab_url", "URL_MISMATCH");
    stage = "injection";
    const results = await chromeApi.scripting.executeScript({ target:{ tabId:request.tabId, frameIds:[0] },
      world:"ISOLATED", func:inspectMessageDom, args:[request, message.requestId] });
    stage = "tab_requery";
    const after = await chromeApi.tabs.get(request.tabId);
    const observed = results.find(item => item.frameId === 0);
    if (after.url !== before.url || !observed || observed.result?.observedUrl !== before.url) {
      const pageMismatch = after.url === before.url && observed?.result?.errorCode === "TAB_CHANGED";
      return fail("TAB_CHANGED", pageMismatch ? "page_url" : "tab_requery",
        after.url !== before.url || pageMismatch ? "URL_MISMATCH" : "OBSERVATION_MISMATCH");
    }
    stage = null;
    send({ type:"extension.message-dom.inspected", requestId:message.requestId,
      payload:{ ...observed.result, tabId:request.tabId, windowId:after.windowId,
        chromeDocumentId:observed.documentId ?? null, frameId:0 } });
  } catch { fail("MESSAGE_DOM_INSPECTION_FAILED", stage, {
    tab_query:"TAB_LOOKUP_EXCEPTION", tab_url:"URL_ACCESS_EXCEPTION", injection:"SCRIPT_EXECUTION_EXCEPTION", tab_requery:"TAB_REQUERY_EXCEPTION"
  }[stage]); }
}
