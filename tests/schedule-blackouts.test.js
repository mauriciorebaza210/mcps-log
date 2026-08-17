// Schedule blackouts — admin producer for the optional blackout sheet.
//
//   node tests/schedule-blackouts.test.js
//
// Availability treats the sheet as optional, but once staff creates blackout
// rows they must be durable, editable and archiveable without deleting history.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/ServiceAreas.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

const HEADERS = ['blackout_id','start_date','end_date','reason','active','created_at','updated_at'];

function norm(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); }

function makeSheet(name, rows, withHeader) {
  const sheet = {
    _name: name,
    _headers: withHeader === false ? [] : HEADERS.slice(),
    _rows: (rows || []).map(r => [
      r.blackout_id || '', r.start_date || '', r.end_date || '',
      r.reason || '', r.active === undefined ? 'TRUE' : r.active,
      r.created_at || '', r.updated_at || ''
    ]),
    getName() { return this._name; },
    getLastRow() { return this._headers.length ? this._rows.length + 1 : 0; },
    getLastColumn() { return this._headers.length; },
    setFrozenRows() {},
    appendRow(row) { this._rows.push(row.slice()); },
    getDataRange() { return { getValues: () => [this._headers.slice(), ...this._rows.map(r => r.slice())] }; },
    getRange(row, col, numRows, numCols) {
      const self = this;
      const range = {
        getValues() {
          if (row === 1) return [self._headers.slice(col - 1, col - 1 + (numCols || self._headers.length))];
          return self._rows.slice(row - 2, row - 2 + (numRows || 1))
            .map(r => r.slice(col - 1, col - 1 + (numCols || 1)));
        },
        setValues(values) {
          if (row === 1) self._headers = values[0].slice();
          return range;
        },
        setValue(value) {
          if (row === 1) {
            self._headers[col - 1] = value;
          } else {
            while (self._rows.length < row - 1) self._rows.push([]);
            self._rows[row - 2][col - 1] = value;
          }
          return range;
        },
        setFontWeight() { return range; }
      };
      return range;
    }
  };
  return sheet;
}

function build(rows) {
  let blackoutSheet = rows === null ? null : makeSheet('Schedule_Blackouts', rows || [], true);

  function sheetToObjects_(sheet) {
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(norm);
    return {
      headers,
      rows: values.slice(1).map((r, i) => {
        const obj = { _rowNum: i + 2 };
        headers.forEach((h, j) => { obj[h] = r[j]; });
        return obj;
      })
    };
  }

  function findRowByValue_(sheet, field, val) {
    const key = norm(field);
    return sheetToObjects_(sheet).rows.find(r => String(r[key] || '').trim() === String(val || '').trim()) || null;
  }

  function softSetCell_(sheet, rowNum, field, value) {
    const key = norm(field);
    let idx = sheet._headers.map(norm).indexOf(key);
    if (idx === -1) {
      idx = sheet._headers.length;
      sheet._headers.push(field);
    }
    sheet._rows[rowNum - 2][idx] = value == null ? '' : value;
  }

  function updateObjectRow_(sheet, rowNum, fields) {
    Object.keys(fields || {}).forEach(k => softSetCell_(sheet, rowNum, k, fields[k]));
  }

  function nextSequence_(sheet, idColumn, prefix, width) {
    const key = norm(idColumn);
    const idx = sheet._headers.map(norm).indexOf(key);
    let max = 0;
    sheet._rows.forEach(r => {
      const m = String(r[idx] || '').match(new RegExp('^' + prefix + '-(\\d+)$', 'i'));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return prefix + '-' + String(max + 1).padStart(width, '0');
  }

  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN, Infinity, RegExp,
    Logger: { log: () => {} },
    CacheService: { getScriptCache: () => ({ remove: () => {} }) },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: n => (n === 'Schedule_Blackouts' ? blackoutSheet : null),
        insertSheet: n => { blackoutSheet = makeSheet(n, [], false); return blackoutSheet; }
      })
    },
    sheetToObjects_, findRowByValue_, softSetCell_, updateObjectRow_, nextSequence_,
    nowIso_: () => '2026-08-16T12:00:00Z'
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'ServiceAreas.js' });
  ctx._sheet = () => blackoutSheet;
  return ctx;
}

console.log('\nSchedule blackout admin handlers');
{
  const ctx = build(null);
  const created = ctx.handleSaveScheduleBlackout_({
    blackout: { start_date: '2026-12-24', end_date: '2026-12-26', reason: 'Christmas closure' }
  });
  t('a missing sheet is created on save', created.ok === true && created.created === true,
    '(got ' + JSON.stringify(created) + ')');
  const list = ctx.handleListScheduleBlackouts_({});
  t('the new blackout is listed', list.ok === true && list.blackouts.length === 1);
  t('date range and reason are preserved',
    list.blackouts[0].start_date === '2026-12-24' &&
    list.blackouts[0].end_date === '2026-12-26' &&
    list.blackouts[0].reason === 'Christmas closure');

  const bad = ctx.handleSaveScheduleBlackout_({
    blackout: { start_date: '2026-12-27', end_date: '2026-12-26' }
  });
  t('an inverted date range is rejected', bad.ok === false && /End date/.test(bad.error));

  const id = list.blackouts[0].blackout_id;
  const edited = ctx.handleSaveScheduleBlackout_({
    blackout: { blackout_id: id, start_date: '2026-12-24', end_date: '2026-12-25', reason: 'Holiday hold' }
  });
  t('an existing blackout updates in place', edited.ok === true && edited.created === false);
  const afterEdit = ctx.handleListScheduleBlackouts_({});
  t('the edited end date is visible', afterEdit.blackouts[0].end_date === '2026-12-25');

  const archived = ctx.handleArchiveScheduleBlackout_({ blackout_id: id });
  t('archive succeeds', archived.ok === true && archived.active === false);
  t('active list excludes archived rows', ctx.handleListScheduleBlackouts_({}).blackouts.length === 0);
  const withArchived = ctx.handleListScheduleBlackouts_({ include_archived: true });
  t('include_archived keeps the audit row',
    withArchived.blackouts.length === 1 && withArchived.blackouts[0].active === false);

  const restored = ctx.handleArchiveScheduleBlackout_({ blackout_id: id, restore: true });
  t('restore succeeds', restored.ok === true && restored.active === true);
  t('restored row is active again', ctx.handleListScheduleBlackouts_({}).blackouts.length === 1);
}

if (fail) {
  console.log(`\n${fail} failing assertion(s), ${pass} passing`);
  process.exit(1);
}
console.log(`\nAll ${pass} assertions passed`);
