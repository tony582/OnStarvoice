import {
  elementExists,
  querySelector,
  querySelectorAll,
  waitForElement,
} from "../../selectors.js";

function getSectionConfig(domProfile, sectionKey) {
  return domProfile?.[sectionKey] || null;
}

function matchesSelectorInScope(node, selector) {
  if (!node || typeof selector !== "string") {
    return false;
  }

  try {
    if (typeof node.matches === "function" && node.matches(selector)) {
      return true;
    }
  } catch {
    return false;
  }

  try {
    return Boolean(node.querySelector(selector));
  } catch {
    return false;
  }
}

function countSelectorMatches(selectors = [], context = document) {
  return selectors.reduce((count, selector) => {
    return count + (matchesSelectorInScope(context, selector) ? 1 : 0);
  }, 0);
}

function getElementDepth(node) {
  let depth = 0;
  let current = node;

  while (current?.parentElement) {
    depth += 1;
    current = current.parentElement;
  }

  return depth;
}

function collectAncestorScores(nodes = []) {
  const scores = new Map();

  nodes.forEach((node) => {
    let depth = 0;
    let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;

    while (current && current !== document.body && current !== document.documentElement) {
      const existing = scores.get(current) || {
        score: 0,
        depth: getElementDepth(current),
      };

      existing.score += Math.max(1, 12 - depth);
      scores.set(current, existing);

      current = current.parentElement;
      depth += 1;
    }
  });

  return scores;
}

function pickBestSignalRoot(signalNodes = [], validationSelectors = []) {
  if (!signalNodes.length) {
    return null;
  }

  const scored = Array.from(collectAncestorScores(signalNodes).entries())
    .map(([node, meta]) => ({
      node,
      score: meta.score,
      depth: meta.depth,
      validationScore: countSelectorMatches(validationSelectors, node),
    }))
    .filter(({ node, validationScore }) => {
      if (!node || node === document.body || node === document.documentElement) {
        return false;
      }

      if (!validationSelectors.length) {
        return true;
      }

      return validationScore >= 2;
    })
    .sort((left, right) => {
      if (right.validationScore !== left.validationScore) {
        return right.validationScore - left.validationScore;
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.depth - left.depth;
    });

  return scored[0]?.node || null;
}

export async function ensureSectionReady(domProfile, sectionKey, { timeout = 6000 } = {}) {
  const ready = getSectionConfig(domProfile, sectionKey)?.ready;
  const selectors = ready?.anyOf || [];
  const minimumCount = Math.max(1, Number(ready?.minimumCount || 1));

  if (!selectors.length) {
    return true;
  }

  const countMatches = () =>
    selectors.reduce((count, selector) => count + (elementExists(selector) ? 1 : 0), 0);

  if (countMatches() >= minimumCount) {
    return true;
  }

  await waitForElement(selectors, timeout);

  if (countMatches() >= minimumCount) {
    return true;
  }

  throw new Error("PAGE_NOT_READY");
}

export function resolveSectionRoot(domProfile, sectionKey) {
  const section = getSectionConfig(domProfile, sectionKey);
  if (!section) {
    return document.body;
  }

  const directRoot = querySelector(section.rootSelectors || []);
  if (directRoot) {
    const validationSelectors = section.rootValidationSelectors || [];
    if (!validationSelectors.length || countSelectorMatches(validationSelectors, directRoot) >= 2) {
      return directRoot;
    }
  }

  const signalNodes = querySelectorAll(section.rootSignals || []);
  const signalRoot = pickBestSignalRoot(signalNodes, section.rootValidationSelectors || []);
  if (signalRoot) {
    return signalRoot;
  }

  return directRoot || document.querySelector("main") || document.body;
}

export async function ensureDetailPageReady(domProfile, { timeout = 6000 } = {}) {
  return ensureSectionReady(domProfile, "noteDetail", { timeout });
}

export function resolveDetailRoot(domProfile) {
  return resolveSectionRoot(domProfile, "noteDetail");
}

export function getFirstMatch(selectors, context = document) {
  return querySelector(selectors, context);
}

export function getAllMatches(selectors, context = document) {
  return querySelectorAll(selectors, context);
}

export function getText(selectors, context = document, { fallbackContext = null } = {}) {
  const target = querySelector(selectors, context) || querySelector(selectors, fallbackContext || document);
  return String(target?.textContent || "").trim();
}

export function getAttribute(
  selectors,
  attributeName,
  context = document,
  { fallbackContext = null } = {},
) {
  const target = querySelector(selectors, context) || querySelector(selectors, fallbackContext || document);
  if (!target || !attributeName) {
    return "";
  }

  return String(
    target.getAttribute(attributeName) ||
      (attributeName in target ? target[attributeName] : "") ||
      "",
  ).trim();
}

export function getAllTexts(selectors, context = document) {
  return querySelectorAll(selectors, context)
    .map((node) => String(node?.textContent || "").trim())
    .filter(Boolean);
}

export function getAllAttributes(selectors, attributeName, context = document) {
  return querySelectorAll(selectors, context)
    .map((node) =>
      String(
        node?.getAttribute(attributeName) ||
          (attributeName in node ? node[attributeName] : "") ||
          "",
      ).trim(),
    )
    .filter(Boolean);
}
