/** Selected Lucide v1.8.0 icons, ISC license. No icon runtime dependency. */
const icons = {
  more: [["circle", {cx: "12", cy: "12", r: "1"}], ["circle", {cx: "19", cy: "12", r: "1"}], ["circle", {cx: "5", cy: "12", r: "1"}]],
  capture: [["path", {d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}], ["path", {d: "M14 2v5a1 1 0 0 0 1 1h5"}], ["path", {d: "M10 9H8"}], ["path", {d: "M16 13H8"}], ["path", {d: "M16 17H8"}]],
  tasks: [["rect", {width: "8", height: "4", x: "8", y: "2", rx: "1", ry: "1"}], ["path", {d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}], ["path", {d: "M12 11h4"}], ["path", {d: "M12 16h4"}], ["path", {d: "M8 11h.01"}], ["path", {d: "M8 16h.01"}]],
  data: [["path", {d: "M5 21v-6"}], ["path", {d: "M12 21V3"}], ["path", {d: "M19 21V9"}]],
  settings: [["path", {d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}], ["circle", {cx: "12", cy: "12", r: "3"}]],
  down: [["path", {d: "m6 9 6 6 6-6"}]],
};
export function icon(document, name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({viewBox: "0 0 24 24", width: "20", height: "20", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false"})) svg.setAttribute(key, value);
  for (const [tag, attrs] of icons[name]) {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}
