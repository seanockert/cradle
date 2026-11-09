import { expect, test } from 'bun:test'
import { slugify } from '../src/core'
import { TEMPLATE, arr, exportMd, exportName, line, missing, parseMd, projectMd, repoName, str, summary, ticketMd, toStatus } from '../src/format'
import { ticketId } from '../src/github'

test('ticketId: branch, Linear-style branch, title fallback', () => {
  expect(ticketId('web-12-fix-auth')).toBe('WEB-12')
  expect(ticketId('sean/web-12-fix')).toBe('WEB-12')
  expect(ticketId('web-12')).toBe('WEB-12')
  expect(ticketId('web-12x', 'WEB-3: thing')).toBe('WEB-3')
  expect(ticketId('main', 'no id')).toBeNull()
})

test('ticketId: title fallback only at the start or in brackets', () => {
  expect(ticketId('main', 'ABC-12: x')).toBe('ABC-12')
  expect(ticketId('main', 'ABC-12 x')).toBe('ABC-12')
  expect(ticketId('main', 'ABC-12')).toBe('ABC-12')
  expect(ticketId('main', 'Fix auth [abc-12]')).toBe('ABC-12')
  expect(ticketId('main', 'Fix UTF-8 parsing')).toBeNull()
  expect(ticketId('main', 'ABC-12x thing')).toBeNull()
  expect(ticketId('abc-7-fix', '[ABC-12] x')).toBe('ABC-7')
})

test('slugify cuts at a word boundary', () => {
  expect(slugify('  Fix: the Auth!! ')).toBe('fix-the-auth')
  expect(slugify('a'.repeat(39) + ' b')).toBe('a'.repeat(39))
  expect(slugify('Add Claude Code integration with workflow commands')).toBe('add-claude-code-integration-with')
  expect(slugify('x'.repeat(50))).toBe('x'.repeat(40))
})

test('ticketMd -> parseMd round trip', () => {
  const t = { id: 'ABC-1', title: 'Title', status: 'todo', blocked_by: ['ABC-2', 'ABC-3'], updated: 'x', body: 'Body\n\n## Part' }
  const { fm, title, body } = parseMd(ticketMd(t))
  expect(title).toBe('Title')
  expect(body).toBe('Body\n\n## Part')
  expect(fm).toMatchObject({ id: 'ABC-1', status: 'todo', blocked_by: 'ABC-2, ABC-3' })
})

test('exportMd -> parseMd round trip, YAML quoting', () => {
  const t = {
    id: 'ABC-1', title: 'Fix: auth #2', status: 'doing', assignee: 'sean', blocked_by: ['ABC-2'], labels: ['bug', 'repo:shop'],
    parent: 'ABC-0', pr: 'https://x/1', created: '2026-11-07 00:59:26', updated: '2026-11-07 01:00:00', body: 'Body',
  }
  const md = exportMd(t)
  expect(md).toContain('title: "Fix: auth #2"\nstatus: In Progress\nassignee:\n  - sean\n')
  const { fm, title, body } = parseMd(md)
  expect(title).toBe('Fix: auth #2')
  expect(body).toBe('Body')
  expect(fm).toMatchObject({ labels: ['bug', 'repo:shop'], dependencies: ['ABC-2'], parent_task_id: 'ABC-0', pr: 'https://x/1', updated_date: '2026-11-07 01:00' })
  expect(toStatus(fm.status as string)).toBe('doing')
  expect(exportName(t)).toBe('abc-1 - Fix-auth-2.md')
})

test('exportMd -> parseMd keeps notes out of the body', () => {
  const t = { id: 'ABC-1', title: 'T', status: 'todo', body: 'Body\n\n## Part', notes: [{ ts: '2026-11-07 01:00:00', text: 'one' }, { ts: '2026-11-07 02:00:00', text: 'two\nlines' }] }
  const { body, notes } = parseMd(exportMd(t))
  expect(body).toBe('Body\n\n## Part')
  expect(notes).toBe('- 2026-11-07 01:00 one\n- 2026-11-07 02:00 two\n  lines')
  expect(parseMd(exportMd({ ...t, notes: [] })).notes).toBeUndefined()
  expect(parseMd('# T\n\n## Notes\n\nx\n\n## After').body).toBe('## Notes\n\nx\n\n## After')
})

test('parseMd reads Backlog.md files', () => {
  const src = `---\nid: BACK-200\ntitle: Add thing\nstatus: To Do\nassignee: []\ncreated_date: '2025-07-23'\nlabels:\n  - enhancement\ndependencies: [task-24.1, BACK-208]\n---\n\n## Description\n\nText`
  const { fm, title, body } = parseMd(src)
  expect(title).toBe('Add thing')
  expect(toStatus(fm.status as string)).toBe('todo')
  expect(fm).toMatchObject({ assignee: [], created_date: '2025-07-23', labels: ['enhancement'], dependencies: ['task-24.1', 'BACK-208'] })
  expect(body).toBe('## Description\n\nText')
})

test('str and arr', () => {
  expect(str(['a', 'b'])).toBe('a, b')
  expect(arr(' a, ,b ')).toEqual(['a', 'b'])
  expect(arr(undefined)).toEqual([])
})

test('line shows labels as tags', () => {
  expect(line({ id: 'ABC-1', status: 'todo', title: 'T', labels: ['bug', 'repo:shop'], assignee: 'sean' })).toBe(
    'ABC-1 [todo] T #bug #repo:shop @sean',
  )
})

test('project summary and markdown', () => {
  expect(summary('## Goal\n\nShip it fast.\n\n## More')).toBe('Ship it fast.')
  expect(summary('## Only heading')).toBe('Only heading')
  expect(summary('x'.repeat(120))).toHaveLength(100)
  expect(projectMd({ key: 'ABC', name: 'Shop', tickets: { done: 2, todo: 1 } })).toBe('# ABC Shop\ntickets: 1 todo, 2 done\n\nNo context yet.\n')
})

test('missing body sections', () => {
  expect(missing(TEMPLATE)).toEqual([])
  expect(missing('## goal\nx\n## Done when\n- [ ] y')).toEqual(['Verify'])
  expect(missing(undefined)).toEqual(['Goal', 'Done when', 'Verify'])
})

test('repoName from name, owner/name and git URLs', () => {
  expect(repoName('Cradle')).toBe('cradle')
  expect(repoName('seanockert/cradle')).toBe('cradle')
  expect(repoName('https://github.com/seanockert/cradle.git')).toBe('cradle')
  expect(repoName('git@github.com:seanockert/cradle.git')).toBe('cradle')
})
