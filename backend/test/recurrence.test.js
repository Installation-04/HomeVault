import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceDate, nextOccurrenceAfter } from '../src/utils/recurrence.js';

test('monthly: plain case', () => {
  assert.equal(advanceDate('2026-03-15', 'monthly'), '2026-04-15');
  assert.equal(advanceDate('2026-12-15', 'monthly'), '2027-01-15');
});

test('monthly: clamps to the end of a shorter month instead of spilling into the next one', () => {
  assert.equal(advanceDate('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(advanceDate('2028-01-31', 'monthly'), '2028-02-29'); // leap year
  assert.equal(advanceDate('2026-03-31', 'monthly'), '2026-04-30');
});

test('yearly: Feb 29 lands on Feb 28 in non-leap years', () => {
  assert.equal(advanceDate('2028-02-29', 'yearly'), '2029-02-28');
  assert.equal(advanceDate('2026-06-01', 'yearly'), '2027-06-01');
});

test('custom: adds N days, defaults to 30 and never goes backwards', () => {
  assert.equal(advanceDate('2026-01-01', 'custom', 10), '2026-01-11');
  assert.equal(advanceDate('2026-01-01', 'custom'), '2026-01-31');
  assert.equal(advanceDate('2026-01-01', 'custom', 0), '2026-01-31');
  assert.equal(advanceDate('2026-01-01', 'custom', -5), '2026-01-31');
});

test('none: unchanged', () => {
  assert.equal(advanceDate('2026-01-01', 'none'), '2026-01-01');
});

test('nextOccurrenceAfter skips missed occurrences but stays on the original cadence', () => {
  // Monthly bill due Jan 10, completed on Oct 11 -> next is Nov 10, not Feb 10.
  assert.equal(nextOccurrenceAfter('2026-01-10', 'monthly', null, '2026-10-11'), '2026-11-10');
  // Completed early: only advances one period.
  assert.equal(nextOccurrenceAfter('2026-10-20', 'monthly', null, '2026-10-11'), '2026-11-20');
  // Completed on the due date: strictly after today.
  assert.equal(nextOccurrenceAfter('2026-10-11', 'yearly', null, '2026-10-11'), '2027-10-11');
  assert.equal(nextOccurrenceAfter('2026-01-01', 'custom', 7, '2026-01-20'), '2026-01-22');
});

test('nextOccurrenceAfter on a non-recurring date returns it unchanged', () => {
  assert.equal(nextOccurrenceAfter('2026-01-01', 'none', null, '2026-10-11'), '2026-01-01');
});
