import { showDashboardPageError } from "./dashboard-status-view.js";

// Install the failure surface before importing the application and its modules.
window.addEventListener("error", event => showDashboardPageError(event.error ?? new Error("Dashboard script failed.")));
window.addEventListener("unhandledrejection", event => showDashboardPageError(event.reason));
document.addEventListener("submit", event => {
  if (!document.getElementById("dashboardPageError").hidden) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.getElementById("dashboardAddress").textContent = window.location.origin;
document.getElementById("refreshDashboard").onclick = () => window.location.reload();
try {
  await import("./app.js");
  const projects = document.getElementById("toggleProjectNavigation");
  projects.addEventListener("click", () => {
    const expanded = projects.getAttribute("aria-expanded") !== "true";
    projects.setAttribute("aria-expanded", String(expanded));
    projects.textContent = expanded ? "프로젝트 닫기" : "프로젝트 보기";
  });
  const workspace = document.getElementById("studioWorkspace");
  for (const [id, panel] of [["studioExplorer", "explorer"], ["studioInspector", "inspector"]]) {
    const toggle = document.getElementById(id + "Toggle");
    const width = document.getElementById(id + "Width");
    const grip = document.getElementById(id + "Grip");
    const key = "bridge.studio." + panel;
    try {
      toggle.checked = localStorage.getItem(key + ".shown") !== "false";
      const savedWidth = localStorage.getItem(key + ".width");
      if (savedWidth !== null) width.value = savedWidth;
    } catch { /* Layout remains available without storage. */ }
    const project = () => {
      workspace.dataset[panel] = toggle.checked ? "shown" : "compact";
      workspace.style.setProperty("--studio-" + panel + "-width", width.value + "px");
    };
    toggle.addEventListener("change", () => {
      project();
      try { localStorage.setItem(key + ".shown", String(toggle.checked)); } catch { /* Keep the in-page layout. */ }
    });
    width.addEventListener("input", project);
    const saveWidth = () => {
      try { localStorage.setItem(key + ".width", width.value); } catch { /* Keep the in-page layout. */ }
    };
    width.addEventListener("change", saveWidth);
    let drag;
    grip.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag) return;
      grip.setPointerCapture(event.pointerId);
      drag = { pointerId:event.pointerId, x:event.clientX, width:grip.parentElement.getBoundingClientRect().width };
    });
    grip.addEventListener("pointermove", event => {
      if (event.pointerId !== drag?.pointerId) return;
      const delta = (event.clientX - drag.x) * (panel === "explorer" ? 1 : -1);
      width.valueAsNumber = drag.width + delta;
      project();
    });
    grip.addEventListener("lostpointercapture", () => {
      drag = null;
      saveWidth();
    });
    project();
  }
  if (document.getElementById("dashboardPageError").hidden) document.getElementById("refreshDashboard").onclick = null;
} catch (error) {
  showDashboardPageError(error);
}
