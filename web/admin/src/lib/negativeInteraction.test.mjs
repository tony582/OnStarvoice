import test from 'node:test';
import assert from 'node:assert/strict';
import {isHighInteractionNegative, negativeInteractionClass} from './negativeInteraction.mjs';

test('only negative content strictly above 200 interactions is highlighted', () => {
  for (const total of [0, 199, 200, '200']) assert.equal(isHighInteractionNegative('negative', total), false);
  for (const total of [201, '201', 10000]) assert.equal(isHighInteractionNegative('negative', total), true);
  for (const sentiment of ['positive', 'neutral', '', null, undefined]) assert.equal(isHighInteractionNegative(sentiment, 999), false);
});

test('missing or invalid totals never trigger the highlight', () => {
  for (const total of [undefined, null, '', 'unknown', NaN, Infinity, -Infinity]) assert.equal(isHighInteractionNegative('negative', total), false);
});

test('normal appearance is preserved and only the interaction value changes tone', () => {
  assert.equal(negativeInteractionClass('negative', 201), 'text-status-red');
  assert.equal(negativeInteractionClass('negative', 200, 'text-foreground'), 'text-foreground');
  assert.equal(negativeInteractionClass('positive', 201, 'text-foreground'), 'text-foreground');
});
