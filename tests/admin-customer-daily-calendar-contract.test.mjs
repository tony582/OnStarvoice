import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const page = readFileSync(new URL('../web/admin/src/pages/insights/CustomerDailyReport.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../web/admin/src/pages/insights/CustomerDailyReportSettings.tsx', import.meta.url), 'utf8');

function between(source, start, end) {
  const begin = source.indexOf(start);
  assert.notEqual(begin, -1, `missing boundary: ${start}`);
  const finish = source.indexOf(end, begin + start.length);
  assert.notEqual(finish, -1, `missing boundary: ${end}`);
  return source.slice(begin + start.length, finish);
}

function calendarRequest({date = '2026-09-13', defaultPending = true} = {}) {
  let resolve;
  let reject;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  const observed = {dates: [], calendars: [], errors: [], urls: []};
  const calendarDefaultPending = {current: defaultPending};
  const effect = between(page, '  useEffect(() => {\n    let cancelled = false\n    async function loadCalendar()', '  }, [date, reload])');
  const body = `let cancelled = false; async function loadCalendar()${effect}`
    .replace('api.get<{ calendar: DailyCalendar }>', 'api.get');
  const cleanup = vm.runInNewContext(`(() => { ${body} })()`, {
    date, DAILY_API: '/customer-daily-reports', mounted: {current: true}, calendarDefaultPending,
    api: {get(url) { observed.urls.push(url); return response; }},
    setDate(value) { observed.dates.push(value); },
    setCalendar(value) { observed.calendars.push(value); },
    setCalendarError(value) { observed.errors.push(value); },
    dailyError(_error, fallback) { return fallback; },
  });
  return {observed, calendarDefaultPending, cleanup, resolve, reject};
}

const weekend = {defaultReportDate: '2026-09-11', isWorkingDay: false, nextWorkingDate: '2026-09-14', collectionBoundaryTime: '18:00', revision: '2026-official'};
const settle = () => new Promise(resolve => setImmediate(resolve));

test('initial weekend selection adopts the latest working day supplied by the calendar', async () => {
  const request = calendarRequest();
  request.resolve({calendar: weekend});
  await settle();
  assert.deepEqual(request.observed.urls, ['/customer-daily-reports/calendar?date=2026-09-13']);
  assert.deepEqual(request.observed.dates, ['2026-09-11']);
  assert.equal(request.observed.calendars[0].date, '2026-09-13');
  assert.equal(request.observed.calendars[0].value.nextWorkingDate, '2026-09-14');
});

test('a delayed initial calendar cannot override a date the customer explicitly selected', async () => {
  const request = calendarRequest();
  request.calendarDefaultPending.current = false;
  request.resolve({calendar: weekend});
  await settle();
  assert.deepEqual(request.observed.dates, []);
  const chooseDate = between(page, '  function chooseDate(value: string) {', '\n  async function generate()');
  assert.match(chooseDate, /calendarDefaultPending\.current = false/);
});

test('a response from an old date or tenant cannot apply after the effect is canceled', async () => {
  const request = calendarRequest();
  request.cleanup();
  request.resolve({calendar: weekend});
  await settle();
  assert.deepEqual(request.observed.dates, []);
  assert.deepEqual(request.observed.calendars, []);
  assert.match(page, /CustomerDailyReportWorkspace key=\{tenantId\}/);
});

test('calendar failure clears permission to generate while retaining report viewing', async () => {
  const request = calendarRequest();
  request.reject(new Error('calendar year unavailable'));
  await settle();
  assert.deepEqual(request.observed.calendars, [null]);
  assert.equal(request.observed.errors.at(-1), '工作日历暂时无法读取，请刷新重试。');

  const generate = between(page, '  async function generate() {', '\n  async function saveSummary()')
    .replace('api.post<{ report: DailyReport }>', 'api.post')
    .replace('api.get<ReportResponse>', 'api.get');
  // With no usable working-day calendar, even a direct invocation must not submit.
  await vm.runInNewContext(`(async () => { ${generate.slice(0, generate.lastIndexOf('}'))} })()`, {
    canWrite: () => true, operation: {current: false}, summaryDraft: null, canGenerate: false,
  });
  assert.match(page, /const selectedCalendar = calendar\?\.date === date \? calendar\.value : null/);
});

test('report settings submit the selected collection boundary and keep the legacy default', () => {
  const expression = between(settings, '    const publicSettings = ', '\n    try {');
  for (const [boundary, expected] of [[undefined, '18:00'], ['19:30', '19:30']]) {
    const result = vm.runInNewContext(`(${expression.trim()})`, {form: {collectionBoundaryTime: boundary}});
    assert.equal(result.collectionBoundaryTime, expected);
  }
});
