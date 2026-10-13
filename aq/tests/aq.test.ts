import { describe, expect, test } from 'claude-code/testing'

import { anchorOf, joinBatch, keptItems, nextSeq, seqsToFiles, slugify, toItem, truncate } from '../hooks/queue'

describe('slugify', () => {
  // Expected values from the zsh pipeline in ~/.zshrc `aq add`.
  test('matches the zsh slug', async () => {
    expect(slugify('fix the login redirect loop')).toBe('fix-the-login-redirect-loop')
    expect(slugify('## Refactor: API (v2)!\nmore detail')).toBe('refactor-api-v2')
    expect(slugify('Add a very long title that goes well past the forty character cut')).toBe(
      'add-a-very-long-title-that-goes-well-pas',
    )
    expect(slugify('!!!')).toBe('task')
  })
})

describe('nextSeq', () => {
  test('continues after the highest number, skipping gaps', async () => {
    expect(nextSeq([])).toBe('001')
    expect(nextSeq(['001-a.md', '004-b.md', '.draft.md', 'done', 'notes.md'])).toBe('005')
  })
})

describe('anchorOf', () => {
  test('collapses whitespace, lowercases, and cuts to 30 chars', async () => {
    expect(anchorOf('  Fix   LOGIN   now  \nsecond line')).toBe('fix login now')
    expect(anchorOf('A very long title that exceeds thirty characters comfortably')).toBe(
      'a very long title that exceeds',
    )
  })
})

describe('toItem', () => {
  test('strips heading marks from the title and previews the rest', async () => {
    expect(toItem('002-x.md', '# Fix login\n\nThe redirect loops\nwhen logged out\n')).toEqual({
      file: '002-x.md',
      seq: '002',
      title: 'Fix login',
      preview: 'The redirect loops when logged out',
    })
    expect(toItem('003-y.md', 'one liner\n').preview).toBe('')
  })
})

describe('batch', () => {
  test('joins with the aq next separator', async () => {
    expect(joinBatch(['one\n', 'two\n\n'])).toBe('one\n\n---\n\ntwo')
  })

  const pending = [
    { file: '001-a.md', anchor: 'fix login' },
    { file: '003-c.md', anchor: 'add tests' },
  ]

  test('archives everything still in the draft', async () => {
    expect(keptItems('Fix login\n\n---\n\nAdd tests for it', pending)).toEqual(['001-a.md', '003-c.md'])
  })

  test('keeps an item deleted from the draft queued', async () => {
    expect(keptItems('Fix login, and be careful', pending)).toEqual(['001-a.md'])
  })

  test('archives a single-line item with text appended or edited mid-line', async () => {
    const single = [{ file: '001-backtesting.md', anchor: anchorOf('001-backtesting: run elo model on 2024 season') }]
    expect(keptItems('001-backtesting: run elo model on 2024 season, and compare against 2023', single)).toEqual([
      '001-backtesting.md',
    ])
    expect(keptItems('001-backtesting: run elo model on 2025 season instead', single)).toEqual([
      '001-backtesting.md',
    ])
  })

  test('archives when whitespace or case changes', async () => {
    expect(keptItems('  FIX   LOGIN  \n\n---\n\nADD   TESTS  ', pending)).toEqual(['001-a.md', '003-c.md'])
  })

  test('archives nothing for an unrelated prompt', async () => {
    expect(keptItems('what does this function do?', pending)).toEqual([])
  })
})

describe('seqsToFiles', () => {
  const items = [
    { file: '001-fix-login.md', seq: '001', title: 'Fix login', preview: '' },
    { file: '003-backtesting.md', seq: '003', title: 'Backtesting', preview: '' },
    { file: '010-clean-cache.md', seq: '010', title: 'Clean cache', preview: '' },
  ]

  test('resolves seq numbers to matching item files with zero-padding', async () => {
    expect(seqsToFiles('3', items)).toEqual(['003-backtesting.md'])
    expect(seqsToFiles(['3'], items)).toEqual(['003-backtesting.md'])
    expect(seqsToFiles(['003'], items)).toEqual(['003-backtesting.md'])
    expect(seqsToFiles(['1', '10'], items)).toEqual(['001-fix-login.md', '010-clean-cache.md'])
  })

  test('ignores unknown seqs', async () => {
    expect(seqsToFiles(['3', '99'], items)).toEqual(['003-backtesting.md'])
    expect(seqsToFiles('99', items)).toEqual([])
  })
})

describe('truncate', () => {
  test('cuts with an ellipsis', async () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
  })
})
