// Bulk Clean for Slack - Core Logic Unit Test Suite (Playwright runner)
//
// Uses the SAME production logic as the background worker (shared-filters.js) —
// no forked/inline reimplementation.

const { test, expect } = require('@playwright/test');
const { qualifies } = require('../shared-filters.js');

test.describe('Bulk Clean for Slack Qualification Engine', () => {
  const CURRENT_USER = 'U123456';

  test('should correctly filter messages by sender (me vs all)', () => {
    const myMsg = { ts: '100.0', user: CURRENT_USER, text: 'Hello' };
    const otherMsg = { ts: '101.0', user: 'U999999', text: 'Hi there' };

    expect(qualifies(myMsg, CURRENT_USER, 'me', '', false)).toBe(true);
    expect(qualifies(otherMsg, CURRENT_USER, 'me', '', false)).toBe(false);
    expect(qualifies(otherMsg, CURRENT_USER, 'all', '', false)).toBe(true);
  });

  test('should handle attachment-only filter', () => {
    const textOnly = { ts: '100.0', user: CURRENT_USER, text: 'Just text' };
    const withFile = { ts: '101.0', user: CURRENT_USER, text: 'File attached', files: [{ id: 'F123' }] };

    expect(qualifies(textOnly, CURRENT_USER, 'all', '', true)).toBe(false);
    expect(qualifies(withFile, CURRENT_USER, 'all', '', true)).toBe(true);
  });

  test('should handle keyword substring matching', () => {
    const msg = { ts: '100.0', user: CURRENT_USER, text: 'CONFIDENTIAL: Project Launch' };

    expect(qualifies(msg, CURRENT_USER, 'all', 'confidential', false)).toBe(true);
    expect(qualifies(msg, CURRENT_USER, 'all', 'secret', false)).toBe(false);
  });

  test('should safely intercept catastrophic ReDoS patterns', () => {
    const msg = { ts: '100.0', user: CURRENT_USER, text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!' };
    const dangerousPattern = '/(a+)+/';

    const startTime = Date.now();
    const result = qualifies(msg, CURRENT_USER, 'all', dangerousPattern, false);
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(100);
    expect(result).toBe(false);
  });

  test('should correctly match valid regex patterns', () => {
    const msg = { ts: '100.0', user: CURRENT_USER, text: 'Error code: ERR_404_NOT_FOUND' };
    const pattern = '/ERR_\\d+/';

    expect(qualifies(msg, CURRENT_USER, 'all', pattern, false)).toBe(true);
  });
});
