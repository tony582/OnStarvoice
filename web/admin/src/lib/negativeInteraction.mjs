export function isHighInteractionNegative(sentiment, interactionTotal) {
  const total = Number(interactionTotal);
  return String(sentiment || '').trim().toLowerCase() === 'negative' &&
    Number.isFinite(total) && total > 200;
}

export function negativeInteractionClass(sentiment, interactionTotal, fallback = 'text-muted-foreground') {
  return isHighInteractionNegative(sentiment, interactionTotal) ? 'text-status-red' : fallback;
}
