import { describe, it, expect } from 'vitest';
import { boardUnread, sortPosts, extractLinks, videoEmbed, genId } from '../lib/board.js';

describe('board: boardUnread', () => {
  const posts = [
    { id: 'a', authorId: '2', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'b', authorId: '5', createdAt: '2026-09-01T02:00:00Z' }, // mine
    { id: 'c', authorId: '2', createdAt: '2026-09-01T03:00:00Z' },
  ];
  it('counts only others posts after lastSeen', () => {
    expect(boardUnread(posts, Date.parse('2026-09-01T01:00:00Z'), '5')).toBe(1); // only c
  });
  it('zero when all seen', () => {
    expect(boardUnread(posts, Date.parse('2026-09-02T00:00:00Z'), '5')).toBe(0);
  });
});

describe('board: sortPosts', () => {
  it('pinned first, then newest', () => {
    const out = sortPosts([
      { id: 'a', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-09-03T00:00:00Z' },
      { id: 'c', createdAt: '2026-09-02T00:00:00Z', pinned: true },
    ]);
    expect(out.map(p => p.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('board: extractLinks', () => {
  it('extracts and dedups', () => {
    expect(extractLinks('a https://x.com/1 b https://x.com/1')).toEqual(['https://x.com/1']);
  });
});

describe('board: videoEmbed', () => {
  it('parses youtube watch/short/youtu.be', () => {
    expect(videoEmbed('https://www.youtube.com/watch?v=abc123XYZ').embedUrl).toBe('https://www.youtube.com/embed/abc123XYZ');
    expect(videoEmbed('https://youtu.be/abc123XYZ').kind).toBe('youtube');
    expect(videoEmbed('https://www.youtube.com/shorts/abc123XYZ').kind).toBe('youtube');
  });
  it('parses vimeo', () => {
    expect(videoEmbed('https://vimeo.com/123456789').embedUrl).toBe('https://player.vimeo.com/video/123456789');
  });
  it('direct video file → file kind', () => {
    expect(videoEmbed('https://cdn.example.com/a.mp4').kind).toBe('file');
  });
  it('other url → link kind, empty → null', () => {
    expect(videoEmbed('https://example.com/page').kind).toBe('link');
    expect(videoEmbed('')).toBeNull();
  });
});

describe('board: genId', () => {
  it('unique-ish and prefixed', () => {
    expect(genId('p')).not.toBe(genId('p'));
    expect(genId('p').startsWith('p_')).toBe(true);
  });
});
