// ─────────────────────────────────────────────────────────────────────────────
// Fleet Monitor — per-pool detail view.
//
// Routed off the hash (#pool/MCPS-0017) so it has a real, shareable URL and the
// back button works. Reads entirely from MON state that the board already
// loaded — opening a pool costs no network round trip.
// ─────────────────────────────────────────────────────────────────────────────

let MON_DETAIL = { poolId: null, field: 'pH', chart: null };

function monDetailRoute() {
  const hash = location.hash.replace(/^#/, '');
  const m = hash.match(/^pool\/(.+)$/);
  const app = document.getElementById('app');
  const detail = document.getElementById('detail');

  if (!m) {
    detail.hidden = true;
    if (MON.loaded || MON.pools.size) app.hidden = false;
    if (MON_DETAIL.chart) { MON_DETAIL.chart.destroy(); MON_DETAIL.chart = null; }
    MON_DETAIL.poolId = null;
    return;
  }

  const poolId = decodeURIComponent(m[1]);
  if (!MON.pools.has(poolId)) {
    // Deep link opened before data landed — wait for the board's first load.
    if (!MON.loaded) return;
    detail.hidden = true; app.hidden = false; location.hash = '';
    monToast('That pool isn’t on the board right now.', true);
    return;
  }

  MON_DETAIL.poolId = poolId;
  app.hidden = true;
  detail.hidden = false;
  window.scrollTo(0, 0);
  monDetailRender();
}

function monDetailRender() {
  const p = MON.pools.get(MON_DETAIL.poolId);
  if (!p) return;
  const d = p.derived;

  const deltaCls = d.delta === null ? 'flat' : (d.delta > 0 ? 'up' : 'down');
  const deltaTxt = d.delta === null ? '' :
    (d.delta > 0 ? '▲' : '▼') + Math.abs(d.delta).toFixed(1) + ' since last visit';

  document.getElementById('detail').innerHTML =
    '<div class="mon-detail-back" id="detail-back">← Back to fleet</div>' +

    '<div class="mon-detail-head">' +
      '<div class="mon-detail-id">' +
        '<h1>' + monEsc(d.name) +
          '<span class="mon-ticker-chip">' + monEsc(p.id) + '</span>' +
          monLifeBadge(d) +
          '<span class="mon-star' + (d.watched ? ' on' : '') + '" id="detail-star">' +
            (d.watched ? '★' : '☆') + '</span>' +
        '</h1>' +
        '<p>' + monEsc([d.address, d.city].filter(Boolean).join(', ') || 'No address on file') +
          (d.service ? ' · ' + monEsc(d.service) : '') + '</p>' +
      '</div>' +
      '<div class="mon-detail-score">' +
        '<div class="val">' + (d.score === null ? '—' : d.score.toFixed(1)) + '</div>' +
        '<div class="lbl">Balance Score</div>' +
        '<div class="mon-delta ' + deltaCls + '">' + deltaTxt + '</div>' +
      '</div>' +
    '</div>' +

    monDetailActions_(d) +
    monDetailAlerts_(d) +

    '<div class="mon-panel">' +
      '<h2>Chemistry — last ' + d.visits.length + ' visits</h2>' +
      '<div class="mon-chart-tabs" id="chart-tabs">' +
        MON_COLS.map(f => '<button class="mon-chart-tab' + (f === MON_DETAIL.field ? ' active' : '') +
          '" data-field="' + monEsc(f) + '">' + monEsc(MON_SHORT[f]) + '</button>').join('') +
      '</div>' +
      '<div id="detail-chart-wrap"><canvas id="detail-chart"></canvas></div>' +
    '</div>' +

    monDetailVitals_(d) +
    monDetailRisk_(d) +
    monDetailFundamentals_(p, d) +
    monDetailTimeline_(d);

  document.getElementById('detail-back').addEventListener('click', () => { location.hash = ''; });
  document.getElementById('detail-star').addEventListener('click', () => {
    monToggleWatch(p.id); monDetailRender();
  });
  document.getElementById('chart-tabs').addEventListener('click', e => {
    const t = e.target.closest('.mon-chart-tab');
    if (!t) return;
    MON_DETAIL.field = t.getAttribute('data-field');
    monDetailRender();
  });
  document.querySelectorAll('#detail [data-act]').forEach(el => {
    el.addEventListener('click', () => monDoAction(el.getAttribute('data-act'), p.id));
  });
  document.querySelectorAll('#detail [data-resolve]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-resolve');
      if (!confirm('Resolve this alert?')) return;
      monToast('Resolving…');
      monResolveAlert(id).then(() => { monToast('Alert resolved.'); monDetailRender(); })
        .catch(err => monToast(err.message || 'Could not resolve.', true));
    });
  });

  monDetailChart_(d);
}

function monDetailActions_(d) {
  let html = '<div class="mon-panel"><h2>Actions</h2><div style="display:flex;gap:.5rem;flex-wrap:wrap">';
  if (d.lifecycle === 'convert') {
    html += '<button class="mon-btn" data-act="convert">Convert to weekly route</button>';
  }
  html += '<button class="mon-btn ghost" data-act="log">Log a visit</button>' +
          '<button class="mon-btn ghost" data-act="flag">Flag for follow-up</button>';
  html += '</div>';
  if (d.lifecycle === 'convert') {
    html += '<p style="color:var(--gold);font-size:.78rem;margin-top:.7rem">' +
      'This pool finished its startup visits but isn’t on a weekly route yet. ' +
      'Until it is, nobody is scheduled to service it.</p>';
  }
  return html + '</div>';
}

function monDetailAlerts_(d) {
  if (!d.alerts || !d.alerts.length) return '';
  return '<div class="mon-panel"><h2>Open alerts</h2>' +
    d.alerts.map(a =>
      '<div class="mon-timeline-item alert">' +
        '<span class="date">' + monEsc(String(a.timestamp || '').slice(0, 10)) + '</span>' +
        '<span style="flex:1">' + monEsc(a.message || '') +
          (a.submitter_name ? ' <span style="color:var(--text3)">— ' + monEsc(a.submitter_name) + '</span>' : '') +
        '</span>' +
        '<button class="mon-act gold" data-resolve="' + monEsc(a.id) + '">Resolve</button>' +
      '</div>').join('') + '</div>';
}

function monDetailVitals_(d) {
  const r = d.latest ? d.latest.readings : {};
  return '<div class="mon-panel"><h2>Latest readings</h2><div class="mon-vitals-grid">' +
    MON_COLS.map(f => {
      const band = monBand(f, r[f]);
      const txt = monFmtReading(f, r[f]);
      const zone = monIdealZone(f);
      const pct = monMeterPct(f, r[f]);
      const bandLabel = band ? (band === 'veryhigh' ? 'Very high' : band.charAt(0).toUpperCase() + band.slice(1)) : 'Not tested';
      const meter = txt === null ? '' :
        '<div class="mon-meter" style="margin-top:.5rem">' +
          '<div class="zone" style="left:' + zone.start.toFixed(1) + '%;right:' + (100 - zone.end).toFixed(1) + '%"></div>' +
          '<div class="mark" style="left:calc(' + pct.toFixed(1) + '% - 1px)"></div></div>';
      return '<div class="mon-vital">' +
        '<div class="lbl">' + monEsc(MON_SHORT[f]) + '</div>' +
        '<div class="v">' + (txt === null ? '—' : monEsc(txt)) + '</div>' +
        '<div class="band ' + (band || 'empty') + '">' + bandLabel + '</div>' + meter +
      '</div>';
    }).join('') + '</div></div>';
}

function monDetailRisk_(d) {
  const lsi = d.lsi;
  let gauge = '<p style="color:var(--text3);font-size:.82rem">Needs calcium hardness and alkalinity to estimate.</p>';
  if (lsi) {
    // Map roughly -1..+1 onto the track.
    const pct = Math.max(0, Math.min(100, (lsi.value + 1) / 2 * 100));
    gauge = '<div class="mon-lsi-gauge">' +
      '<span class="mon-lsi-label">' + lsi.value.toFixed(2) + '</span>' +
      '<div class="mon-lsi-track"><div class="mon-lsi-mark" style="left:calc(' + pct.toFixed(1) + '% - 1px)"></div></div>' +
      '<span class="mon-lsi-label">' + monEsc(monLSILabel(lsi.value)) + '</span></div>' +
      '<div class="mon-lsi-note">Estimated — water temperature is not recorded on visits, so this assumes ' +
      lsi.tempF + '°F for this time of year, and ' + lsi.tds + ' ppm TDS. ' +
      'Treat it as a direction, not a measurement.</div>';
  }

  let fc = '';
  const forecasts = ['Free Chlorine (FC)', 'pH'].map(f => monForecast(d.visits, f)).filter(Boolean);
  if (forecasts.length) {
    fc = '<div style="margin-top:1rem">' + forecasts.map(f =>
      '<div style="font-size:.85rem;padding:.3rem 0">' +
      '<b>' + monEsc(f.short) + '</b> is ' + f.direction + ' — leaves the ideal range in about <b>' +
      f.days + ' day' + (f.days === 1 ? '' : 's') + '</b> at this rate.</div>').join('') + '</div>';
  }

  return '<div class="mon-panel"><h2>Balance risk</h2>' + gauge + fc + '</div>';
}

function monDetailFundamentals_(p, d) {
  const rows = [
    ['Pool ID', p.id],
    ['Service', d.service || '—'],
    ['Route day', d.weekday >= 0 ? FM_WEEKDAY_NAMES[d.weekday] : 'Unscheduled'],
    ['Technician', d.operator || '—'],
    ['Pool size', d.size || '—'],
    ['Material', d.material || '—'],
    ['Visits on record', d.visits.length],
    ['Last serviced', monDaysAgoLabel(d.daysAgo)]
  ];
  return '<div class="mon-panel"><h2>Pool details</h2><div class="mon-fund-grid">' +
    rows.map(([k, v]) => '<div><div class="lbl">' + monEsc(k) + '</div><div>' + monEsc(v) + '</div></div>').join('') +
    '</div></div>';
}

const FM_WEEKDAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function monDetailTimeline_(d) {
  if (!d.visits.length) return '<div class="mon-panel"><h2>Visit history</h2><p style="color:var(--text3)">No visits logged yet.</p></div>';
  return '<div class="mon-panel"><h2>Visit history</h2>' +
    d.visits.map(v => {
      const s = monScore(v.readings);
      return '<div class="mon-timeline-item">' +
        '<span class="date">' + v.date.toLocaleDateString() + '</span>' +
        '<span style="flex:1">' + monEsc(v.tech || 'Unknown technician') +
          (v.provisional ? ' <span style="color:var(--gold)">· just logged</span>' : '') + '</span>' +
        '<span style="color:var(--text2)">' + (s === null ? 'Not tested' : s.toFixed(1)) + '</span>' +
      '</div>';
    }).join('') + '</div>';
}

// ── chart ────────────────────────────────────────────────────────────────────
// The ideal band is shaded behind the line, so leaving the green zone is
// visible at a glance instead of requiring you to know that 7.8 is high.
function monDetailChart_(d) {
  if (typeof Chart === 'undefined') return;
  if (MON_DETAIL.chart) { MON_DETAIL.chart.destroy(); MON_DETAIL.chart = null; }

  const field = MON_DETAIL.field;
  const band = MON_BANDS[field];
  const series = d.visits.slice().reverse()
    .map(v => ({ x: v.date, y: monNum(v.readings[field]) }))
    .filter(pt => pt.y !== null);

  const canvas = document.getElementById('detail-chart');
  if (!canvas || !series.length) {
    if (canvas) canvas.parentElement.innerHTML =
      '<p style="color:var(--text3);font-size:.85rem;padding:2rem 0">No ' + monEsc(MON_SHORT[field]) + ' readings recorded yet.</p>';
    return;
  }

  const idealBandPlugin = {
    id: 'idealBand',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const yTop = scales.y.getPixelForValue(band.idealMax);
      const yBot = scales.y.getPixelForValue(band.low);
      ctx.save();
      ctx.fillStyle = 'rgba(31,167,168,.10)';
      ctx.fillRect(chartArea.left, yTop, chartArea.right - chartArea.left, yBot - yTop);
      ctx.strokeStyle = 'rgba(31,167,168,.28)';
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      [yTop, yBot].forEach(y => {
        ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
      });
      ctx.restore();
    }
  };

  MON_DETAIL.chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: series.map(pt => pt.x.toLocaleDateString()),
      datasets: [{
        data: series.map(pt => pt.y),
        borderColor: '#1FA7A8',
        backgroundColor: 'rgba(31,167,168,.08)',
        borderWidth: 2, tension: .32, fill: true,
        pointBackgroundColor: series.map(pt => {
          const b = monBand(field, pt.y);
          return b === 'ideal' ? '#1FA7A8' : (b === 'veryhigh' ? '#E5534B' : '#c8a84b');
        }),
        pointRadius: 4, pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1A2726', borderColor: 'rgba(255,255,255,.08)', borderWidth: 1,
          titleFont: { family: 'Montserrat' }, bodyFont: { family: 'Open Sans' },
          callbacks: {
            label(ctx) {
              const b = monBand(field, ctx.parsed.y);
              const label = b === 'veryhigh' ? 'very high' : b;
              return MON_SHORT[field] + ': ' + ctx.parsed.y + (band.unit ? ' ' + band.unit : '') + '  (' + label + ')';
            }
          }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#647876', font: { family: 'Open Sans', size: 10 } } },
        y: {
          grid: { color: 'rgba(255,255,255,.04)' },
          ticks: { color: '#647876', font: { family: 'Open Sans', size: 10 } },
          suggestedMin: band.min, suggestedMax: band.max
        }
      }
    },
    plugins: [idealBandPlugin]
  });
}

window.addEventListener('hashchange', monDetailRoute);
