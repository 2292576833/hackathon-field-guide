import assert from 'node:assert/strict';
import test from 'node:test';
import { safeAuthReturnTo } from '../modules/auth/service.ts';
test('login preserves a skill bundle and bounded approved filters', () => {
  assert.equal(safeAuthReturnTo('/skills/bundles/game-prototype?agentId=codex&track=game&category=delivery&search=README'), '/skills/bundles/game-prototype?agentId=codex&track=game&category=delivery&search=README');
  assert.equal(safeAuthReturnTo('/skills?search=%E4%B8%AD%E6%96%87'), '/skills?search=%E4%B8%AD%E6%96%87');
  assert.equal(safeAuthReturnTo('/skills/bundles/game-prototype'), '/skills/bundles/game-prototype');
  assert.equal(safeAuthReturnTo('/admin/services'), '/admin/services');
  assert.equal(safeAuthReturnTo('/journey'), '/journey');
});
test('login and registration retain a fixed skill version and selected presentation space', () => {
  const version='create-readme@'+'a'.repeat(40);
  const fixed='/skills/create-readme?agentId=codex&versionId='+encodeURIComponent(version);
  assert.equal(safeAuthReturnTo(fixed),fixed);
  for(const path of ['/roadshow?projectId=project-1','/ppt?projectId=project-1&roadshowId=script-1','/ppt?roadshowId=script-1']) assert.equal(safeAuthReturnTo(path),path);
  for(const path of ['/skills/create-readme?versionId=%2F%2Fevil.test','/skills/create-readme?versionId=x&versionId=y','/skills/create-readme?versionId=%0d%0a','/skills/create-readme?versionId='+ 'x'.repeat(201),'/roadshow?projectId=x&projectId=y','/roadshow?projectId=%2f%2fevil.test','/roadshow?roadshowId=script-1','/ppt?projectId=project-1&pairToken=private']) assert.equal(safeAuthReturnTo(path),'/app');
});
test('login context rejects redirects, hidden credentials, duplicates and control/encoded path bypasses', () => {
  for (const input of ['//evil.test/skills','/skills/%2f%2fevil.test','/skills?returnTo=https://evil.test','/skills?pairToken=private','/skills?agentId=codex&agentId=claude-code','/skills?search=%0d%0a','/skills?search=%zz','/skills?track=%5cfoo','/skills?search=a?evil','/skills?search='+ 'x'.repeat(201),'/skills/bundles/a#evil','/skills\\evil']) assert.equal(safeAuthReturnTo(input), '/app', input);
});
test('login and registration preserve organizer and exact current-event destinations', () => {
  const eventId = '6ff95f59-f2ea-4bb6-bb91-6aee5bcbc9fa';
  const eventPath = `/competitions/${eventId}`;
  const destinations = [
    '/organizers', '/organizers/workspace', '/competitions', '/admin/organizers',
    eventPath, `/judging/${eventId}`,
    ...['register', 'teams', 'help', 'schedule', 'services', 'submit', 'results'].map((page) => `${eventPath}/${page}`),
    `/competitions/${'a'.repeat(128)}/register`, `/judging/${'a'.repeat(128)}`,
  ];
  for (const destination of destinations) {
    assert.equal(safeAuthReturnTo(destination), destination, destination);
    assert.equal(new URL(destination, 'https://platform.example').origin, 'https://platform.example');
  }
  assert.equal(safeAuthReturnTo('/competitions/event-a/register'), '/competitions/event-a/register');
  assert.equal(safeAuthReturnTo('/competitions/event-b/register'), '/competitions/event-b/register');
});
test('organizer return paths reject external URLs, encoded segments and URL normalization bypasses', () => {
  const destinations = [
    'https://evil.test/competitions/event-1/register', '//evil.test/organizers',
    'https://platform.example/competitions/event-1/register',
    '/competitions//evil.test/register', '/competitions/%2F%2Fevil.test/register',
    '/competitions/%252F%252Fevil.test/register', '/competitions/%65vent-1/register',
    '/competitions/event-1/%72egister', '/competitions/event-1/../event-2/register',
    '/competitions/event-1/%2e%2e/event-2/register', '/competitions/./register',
    '/competitions/event-1\\register', '/competitions/event-1%5Cregister',
    '/competitions/event-1/register\r\nLocation:https://evil.test',
    '/competitions/event-1/register#private', '/judging/%2f%2fevil.test',
    '/organizers/workspace/../competitions/event-2', '/admin/organizers%2f..%2fservices',
  ];
  for (const destination of destinations) assert.equal(safeAuthReturnTo(destination), '/app', destination);
});
test('organizer destinations have bounded IDs and carry no query credentials or arbitrary subpages', () => {
  const paths = ['/organizers', '/organizers/workspace', '/competitions', '/competitions/event-1/register', '/judging/event-1', '/admin/organizers'];
  for (const path of paths) {
    for (const suffix of ['?token=secret', '?pairToken=private', '?returnTo=%2Fcompetitions%2Fevent-2', '?eventId=event-2', '?next=https://evil.test', '?', '?token=%0d%0a', '?eventId=a&eventId=b']) {
      assert.equal(safeAuthReturnTo(`${path}${suffix}`), '/app', `${path}${suffix}`);
    }
  }
  for (const destination of [
    '/competitions/', '/judging/', '/judging/event-1/results', '/organizers/workspace/event-1',
    '/competitions/event-1/private', '/competitions/event-1/register/extra',
    `/competitions/${'a'.repeat(129)}/register`, `/judging/${'a'.repeat(129)}`,
    '/competitions/event.1/register', '/competitions/赛事/register', '/competitions/event-1/register/',
  ]) assert.equal(safeAuthReturnTo(destination), '/app', destination);
});
