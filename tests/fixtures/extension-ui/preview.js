const frame = document.querySelector("iframe");
document.getElementById("width").addEventListener("change", event => frame.style.width = `${Number(event.target.value)}px`);
document.getElementById("reload").addEventListener("click", () => {
  frame.src = `/sidebar/sidebar.html?${new URLSearchParams({scenario: document.getElementById("scenario").value, platform: document.getElementById("platform").value})}`;
});
document.getElementById("contracts").addEventListener("click", () => frame.contentWindow.postMessage({type: "sv-ui-test"}, location.origin));
document.getElementById("rehearse").addEventListener("click", () => frame.contentWindow.postMessage({type: "sv-ui-stage", flow: document.getElementById("flow").value, stage: document.getElementById("stage").value}, location.origin));
document.getElementById("lifecycle").addEventListener("click", () => frame.contentWindow.postMessage({type: "sv-ui-lifecycle-test"}, location.origin));
window.addEventListener("message", event => {
  if (event.source === frame.contentWindow && event.origin === location.origin && event.data?.type === "sv-ui-report") document.getElementById("report").textContent = event.data.report;
});
