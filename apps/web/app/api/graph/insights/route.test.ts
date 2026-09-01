import { describe, expect, it } from 'bun:test';
import { MAX_GRAPH_LINKS, MAX_GRAPH_PAGES, validateGraphInputSize } from './route';

describe('graph input size guard', () => {
  it('accepts the hard caps and rejects the extra probe row', () => {
    expect(validateGraphInputSize(MAX_GRAPH_PAGES, MAX_GRAPH_LINKS)).toBeNull();
    expect(validateGraphInputSize(MAX_GRAPH_PAGES + 1, MAX_GRAPH_LINKS)).toEqual({
      code: 'GRAPH_TOO_LARGE',
      message: 'Graph exceeds the supported size',
    });
    expect(validateGraphInputSize(MAX_GRAPH_PAGES, MAX_GRAPH_LINKS + 1)).toMatchObject({
      code: 'GRAPH_TOO_LARGE',
    });
  });
});
